package com.rnnativedebugger;

import android.app.ActivityManager;
import android.app.Application;
import android.content.Context;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.net.TrafficStats;
import android.util.Log;
import android.view.Choreographer;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.FileReader;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Development-only runtime sampler for the current React Native app process. */
final class RuntimeTelemetry {
  private static final String TAG = "RNNativeDebuggerTelemetry";
  private static final String MARKER = "RNND_TELEMETRY ";
  private static final Object LOCK = new Object();
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  private static Context appContext;
  private static ScheduledExecutorService scheduler;
  private static boolean running = false;
  private static long intervalMs = 1000L;

  private static long lastCpuMs = 0L;
  private static long lastWallMs = 0L;
  private static double lastCpuPercent = 0.0;

  private static long fpsWindowStartNs = 0L;
  private static int fpsFrames = 0;
  private static double lastFps = 0.0;
  private static Choreographer.FrameCallback frameCallback;

  private RuntimeTelemetry() {}

  static boolean isRunning() {
    synchronized (LOCK) {
      return running;
    }
  }

  static void start(Context context, double requestedIntervalMs) {
    if (!BuildConfig.DEBUG || context == null) return;
    final long requested = Math.round(requestedIntervalMs);
    final long nextInterval = Math.max(250L, Math.min(5000L, requested > 0 ? requested : 1000L));

    synchronized (LOCK) {
      appContext = context.getApplicationContext();
      if (running && intervalMs == nextInterval) return;
      stopLocked();
      intervalMs = nextInterval;
      running = true;
      lastCpuMs = android.os.Process.getElapsedCpuTime();
      lastWallMs = SystemClock.elapsedRealtime();
      startFpsLocked();
      scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "RNND-RuntimeTelemetry");
        thread.setDaemon(true);
        return thread;
      });
      scheduler.scheduleAtFixedRate(RuntimeTelemetry::sampleAndLog, 0L, intervalMs, TimeUnit.MILLISECONDS);
    }
  }

  static void stop() {
    synchronized (LOCK) {
      stopLocked();
    }
  }

  private static void stopLocked() {
    running = false;
    if (scheduler != null) {
      scheduler.shutdownNow();
      scheduler = null;
    }
    if (frameCallback != null) {
      final Choreographer.FrameCallback callback = frameCallback;
      MAIN.post(() -> {
        try {
          Choreographer.getInstance().removeFrameCallback(callback);
        } catch (Throwable ignored) {}
      });
    }
    frameCallback = null;
    fpsWindowStartNs = 0L;
    fpsFrames = 0;
    lastFps = 0.0;
  }

  private static void startFpsLocked() {
    frameCallback = new Choreographer.FrameCallback() {
      @Override
      public void doFrame(long frameTimeNanos) {
        synchronized (LOCK) {
          if (!running || frameCallback != this) return;
          if (fpsWindowStartNs == 0L) fpsWindowStartNs = frameTimeNanos;
          fpsFrames += 1;
          final long elapsed = frameTimeNanos - fpsWindowStartNs;
          if (elapsed >= 1_000_000_000L) {
            lastFps = fpsFrames * 1_000_000_000.0 / elapsed;
            fpsFrames = 0;
            fpsWindowStartNs = frameTimeNanos;
          }
        }
        if (isRunning()) Choreographer.getInstance().postFrameCallback(this);
      }
    };
    MAIN.post(() -> {
      try {
        if (isRunning() && frameCallback != null) {
          Choreographer.getInstance().postFrameCallback(frameCallback);
        }
      } catch (Throwable throwable) {
        Log.w(TAG, "Unable to start FPS sampler: " + throwable.getMessage());
      }
    });
  }

  static Map<String, Object> snapshot() {
    Map<String, Object> out = new LinkedHashMap<>();
    Context context;
    synchronized (LOCK) {
      context = appContext;
    }
    if (!BuildConfig.DEBUG || context == null) {
      out.put("available", false);
      out.put("reason", "debug-runtime-unavailable");
      return out;
    }

    final long now = System.currentTimeMillis();
    final long pid = android.os.Process.myPid();
    final int uid = android.os.Process.myUid();

    Debug.MemoryInfo memoryInfo = new Debug.MemoryInfo();
    Debug.getMemoryInfo(memoryInfo);
    final long pssBytes = memoryInfo.getTotalPss() * 1024L;
    final long privateDirtyBytes = memoryInfo.getTotalPrivateDirty() * 1024L;
    final Runtime runtime = Runtime.getRuntime();
    final long javaHeapUsed = runtime.totalMemory() - runtime.freeMemory();
    final long javaHeapMax = runtime.maxMemory();
    final long nativeHeap = Debug.getNativeHeapAllocatedSize();

    final long cpuMs = android.os.Process.getElapsedCpuTime();
    final long wallMs = SystemClock.elapsedRealtime();
    synchronized (LOCK) {
      if (lastWallMs > 0L && wallMs > lastWallMs) {
        final long cpuDelta = Math.max(0L, cpuMs - lastCpuMs);
        final long wallDelta = Math.max(1L, wallMs - lastWallMs);
        final int processors = Math.max(1, Runtime.getRuntime().availableProcessors());
        lastCpuPercent = Math.max(0.0, Math.min(100.0, (cpuDelta * 100.0) / (wallDelta * processors)));
      }
      lastCpuMs = cpuMs;
      lastWallMs = wallMs;
    }

    out.put("available", true);
    out.put("source", "android-native");
    out.put("timestamp", now);
    out.put("platform", "android");
    out.put("pid", pid);
    out.put("uid", uid);
    out.put("process", processName(context));
    out.put("residentMemoryBytes", pssBytes);
    out.put("memoryKind", "pss");
    out.put("privateDirtyBytes", privateDirtyBytes);
    out.put("javaHeapUsedBytes", javaHeapUsed);
    out.put("javaHeapMaxBytes", javaHeapMax);
    out.put("nativeHeapAllocatedBytes", nativeHeap);
    out.put("cpuPercent", lastCpuPercent);
    synchronized (LOCK) {
      out.put("fps", lastFps > 0.0 ? lastFps : null);
    }
    out.put("threads", readThreadCount());
    out.put("thermalState", thermalState(context));
    out.put("batteryPercent", batteryPercent(context));
    out.put("rxBytes", safeTrafficBytes(TrafficStats.getUidRxBytes(uid)));
    out.put("txBytes", safeTrafficBytes(TrafficStats.getUidTxBytes(uid)));
    out.put("physicalMemoryBytes", totalDeviceMemory(context));
    out.put("uptimeMs", SystemClock.elapsedRealtime());
    out.put("activeProcessors", Runtime.getRuntime().availableProcessors());
    return out;
  }

  static WritableMap snapshotAsWritableMap() {
    WritableMap writable = Arguments.createMap();
    for (Map.Entry<String, Object> entry : snapshot().entrySet()) {
      put(writable, entry.getKey(), entry.getValue());
    }
    return writable;
  }

  private static void sampleAndLog() {
    if (!isRunning()) return;
    try {
      Map<String, Object> metrics = snapshot();
      Log.i(TAG, MARKER + new JSONObject(metrics).toString());
    } catch (Throwable throwable) {
      Log.w(TAG, "Runtime telemetry sample failed: " + throwable.getMessage());
    }
  }

  private static String processName(Context context) {
    if (Build.VERSION.SDK_INT >= 28) {
      String value = Application.getProcessName();
      if (value != null && !value.isEmpty()) return value;
    }
    return context.getPackageName();
  }

  private static int readThreadCount() {
    try (BufferedReader reader = new BufferedReader(new FileReader("/proc/self/status"))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (!line.startsWith("Threads:")) continue;
        return Integer.parseInt(line.substring("Threads:".length()).trim());
      }
    } catch (Throwable ignored) {}
    return Thread.getAllStackTraces().size();
  }

  private static String thermalState(Context context) {
    if (Build.VERSION.SDK_INT < 29) return "unsupported";
    try {
      PowerManager manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
      if (manager == null) return "unknown";
      switch (manager.getCurrentThermalStatus()) {
        case PowerManager.THERMAL_STATUS_NONE: return "nominal";
        case PowerManager.THERMAL_STATUS_LIGHT: return "fair";
        case PowerManager.THERMAL_STATUS_MODERATE: return "serious";
        case PowerManager.THERMAL_STATUS_SEVERE: return "critical";
        case PowerManager.THERMAL_STATUS_CRITICAL: return "critical";
        case PowerManager.THERMAL_STATUS_EMERGENCY: return "emergency";
        case PowerManager.THERMAL_STATUS_SHUTDOWN: return "shutdown";
        default: return "unknown";
      }
    } catch (Throwable ignored) {
      return "unknown";
    }
  }

  private static Integer batteryPercent(Context context) {
    try {
      BatteryManager manager = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
      if (manager == null) return null;
      int value = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
      return value >= 0 && value <= 100 ? value : null;
    } catch (Throwable ignored) {
      return null;
    }
  }

  private static Long safeTrafficBytes(long value) {
    return value == TrafficStats.UNSUPPORTED ? null : value;
  }

  private static Long totalDeviceMemory(Context context) {
    try {
      ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
      if (manager == null) return null;
      ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
      manager.getMemoryInfo(info);
      return info.totalMem;
    } catch (Throwable ignored) {
      return null;
    }
  }

  private static void put(WritableMap map, String key, Object value) {
    if (value == null) map.putNull(key);
    else if (value instanceof Boolean) map.putBoolean(key, (Boolean) value);
    else if (value instanceof Integer) map.putInt(key, (Integer) value);
    else if (value instanceof Number) map.putDouble(key, ((Number) value).doubleValue());
    else map.putString(key, String.valueOf(value));
  }
}
