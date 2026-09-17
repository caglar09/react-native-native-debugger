package com.rnnativedebugger;

import android.content.Context;
import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Runtime sink used by patched third-party native modules.
 *
 * Integrations locate this class with reflection, so they never gain a compile-time
 * dependency on react-native-native-debugger.
 */
public final class NativeDebugSink {
  public static final boolean COMPILED_DEBUG = BuildConfig.DEBUG;
  public static final String EVENT_NAME = "RNNativeDebuggerEvent";
  private static final String TAG = "RNNativeDebugger";
  private static final String BUFFER_FILE = "rn-native-debugger-events.jsonl";
  private static final int MAX_EVENTS = 1000;
  private static final long MAX_FILE_BYTES = 2L * 1024L * 1024L;

  private static final Object LOCK = new Object();
  private static final ArrayDeque<Map<String, Object>> EVENTS = new ArrayDeque<>();
  private static WeakReference<ReactApplicationContext> reactContextRef = new WeakReference<>(null);
  private static Context appContext;
  private static int listeners = 0;
  private static volatile boolean enabled = BuildConfig.DEBUG;
  private static boolean loadedPersisted = false;

  private NativeDebugSink() {}

  /** Called through reflection by patched dependencies. */
  public static boolean isEnabled() {
    return enabled;
  }

  /** Called through reflection by patched dependencies. */
  public static void emit(
      String integration,
      String category,
      String event,
      Map<?, ?> data
  ) {
    if (!enabled) return;

    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("id", UUID.randomUUID().toString());
    payload.put("timestamp", System.currentTimeMillis());
    payload.put("platform", "android");
    payload.put("integration", integration == null ? "unknown" : integration);
    payload.put("category", category == null ? "native" : category);
    payload.put("event", event == null ? "event" : event);
    payload.put("data", sanitizeMap(data));

    synchronized (LOCK) {
      addToRing(payload);
      appendToDisk(payload);
    }

    Log.d(TAG, "[" + integration + "][" + category + "][" + event + "] " + payload.get("data"));
    emitToReactNative(payload);
  }

  static void attach(ReactApplicationContext context) {
    reactContextRef = new WeakReference<>(context);
    synchronized (LOCK) {
      appContext = context.getApplicationContext();
      if (!loadedPersisted) {
        loadPersistedEvents();
        loadedPersisted = true;
        rewriteDisk();
      }
    }
  }

  static void detach(ReactApplicationContext context) {
    ReactApplicationContext current = reactContextRef.get();
    if (current == context) reactContextRef.clear();
  }

  static void addListener() {
    synchronized (LOCK) {
      listeners++;
    }
  }

  static void removeListeners(int count) {
    synchronized (LOCK) {
      listeners = Math.max(0, listeners - Math.max(0, count));
    }
  }

  static void setEnabled(boolean value) {
    enabled = value && BuildConfig.DEBUG;
  }

  static WritableArray snapshotAsWritableArray() {
    WritableArray array = Arguments.createArray();
    synchronized (LOCK) {
      for (Map<String, Object> event : EVENTS) {
        array.pushMap(toWritableMap(event));
      }
    }
    return array;
  }

  static void clear() {
    synchronized (LOCK) {
      EVENTS.clear();
      File file = bufferFile();
      if (file != null && file.exists()) {
        //noinspection ResultOfMethodCallIgnored
        file.delete();
      }
    }
  }

  private static void emitToReactNative(Map<String, Object> payload) {
    ReactApplicationContext context = reactContextRef.get();
    int listenerCount;
    synchronized (LOCK) {
      listenerCount = listeners;
    }
    if (context == null || listenerCount <= 0) return;

    try {
      context
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
          .emit(EVENT_NAME, toWritableMap(payload));
    } catch (Throwable throwable) {
      Log.w(TAG, "Unable to emit event to JS: " + throwable.getMessage());
    }
  }

  private static void addToRing(Map<String, Object> payload) {
    EVENTS.addLast(payload);
    while (EVENTS.size() > MAX_EVENTS) EVENTS.removeFirst();
  }

  private static Map<String, Object> sanitizeMap(Map<?, ?> source) {
    Map<String, Object> out = new LinkedHashMap<>();
    if (source == null) return out;
    for (Map.Entry<?, ?> entry : source.entrySet()) {
      String key = String.valueOf(entry.getKey());
      out.put(key, sanitizeValue(entry.getValue(), 0));
    }
    return out;
  }

  private static Object sanitizeValue(Object value, int depth) {
    if (value == null) return null;
    if (depth > 8) return "[MAX_DEPTH]";
    if (value instanceof String || value instanceof Boolean || value instanceof Number) return value;
    if (value instanceof Map) return sanitizeMap((Map<?, ?>) value);
    if (value instanceof Collection) {
      List<Object> list = new ArrayList<>();
      for (Object child : (Collection<?>) value) list.add(sanitizeValue(child, depth + 1));
      return list;
    }
    if (value.getClass().isArray()) return String.valueOf(value);
    return String.valueOf(value);
  }

  private static WritableMap toWritableMap(Map<String, Object> map) {
    WritableMap writable = Arguments.createMap();
    for (Map.Entry<String, Object> entry : map.entrySet()) {
      putValue(writable, entry.getKey(), entry.getValue());
    }
    return writable;
  }

  @SuppressWarnings("unchecked")
  private static void putValue(WritableMap map, String key, Object value) {
    if (value == null) map.putNull(key);
    else if (value instanceof Boolean) map.putBoolean(key, (Boolean) value);
    else if (value instanceof Integer) map.putInt(key, (Integer) value);
    else if (value instanceof Number) map.putDouble(key, ((Number) value).doubleValue());
    else if (value instanceof String) map.putString(key, (String) value);
    else if (value instanceof Map) map.putMap(key, toWritableMap((Map<String, Object>) value));
    else if (value instanceof Collection) {
      WritableArray array = Arguments.createArray();
      for (Object child : (Collection<?>) value) pushValue(array, child);
      map.putArray(key, array);
    } else map.putString(key, String.valueOf(value));
  }

  @SuppressWarnings("unchecked")
  private static void pushValue(WritableArray array, Object value) {
    if (value == null) array.pushNull();
    else if (value instanceof Boolean) array.pushBoolean((Boolean) value);
    else if (value instanceof Integer) array.pushInt((Integer) value);
    else if (value instanceof Number) array.pushDouble(((Number) value).doubleValue());
    else if (value instanceof String) array.pushString((String) value);
    else if (value instanceof Map) array.pushMap(toWritableMap((Map<String, Object>) value));
    else if (value instanceof Collection) {
      WritableArray nested = Arguments.createArray();
      for (Object child : (Collection<?>) value) pushValue(nested, child);
      array.pushArray(nested);
    } else array.pushString(String.valueOf(value));
  }

  private static File bufferFile() {
    if (appContext == null) return null;
    return new File(appContext.getCacheDir(), BUFFER_FILE);
  }

  private static void appendToDisk(Map<String, Object> payload) {
    File file = bufferFile();
    if (file == null) return;
    try (FileWriter writer = new FileWriter(file, true)) {
      writer.write(new JSONObject(payload).toString());
      writer.write('\n');
    } catch (Throwable throwable) {
      Log.w(TAG, "Unable to persist native event: " + throwable.getMessage());
    }
    if (file.length() > MAX_FILE_BYTES) rewriteDisk();
  }

  private static void rewriteDisk() {
    File file = bufferFile();
    if (file == null) return;
    try (FileWriter writer = new FileWriter(file, false)) {
      for (Map<String, Object> event : EVENTS) {
        writer.write(new JSONObject(event).toString());
        writer.write('\n');
      }
    } catch (Throwable throwable) {
      Log.w(TAG, "Unable to compact native event buffer: " + throwable.getMessage());
    }
  }

  private static void loadPersistedEvents() {
    File file = bufferFile();
    if (file == null || !file.exists()) return;

    List<Map<String, Object>> persisted = new ArrayList<>();
    try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.trim().isEmpty()) continue;
        persisted.add(jsonObjectToMap(new JSONObject(line)));
      }
    } catch (Throwable throwable) {
      Log.w(TAG, "Unable to restore native event buffer: " + throwable.getMessage());
    }

    if (persisted.isEmpty()) return;
    ArrayDeque<Map<String, Object>> merged = new ArrayDeque<>();
    for (Map<String, Object> item : persisted) merged.addLast(item);
    for (Map<String, Object> item : EVENTS) merged.addLast(item);
    EVENTS.clear();
    EVENTS.addAll(merged);
    while (EVENTS.size() > MAX_EVENTS) EVENTS.removeFirst();
  }

  private static Map<String, Object> jsonObjectToMap(JSONObject object) throws Exception {
    Map<String, Object> map = new LinkedHashMap<>();
    Iterator<String> keys = object.keys();
    while (keys.hasNext()) {
      String key = keys.next();
      map.put(key, jsonValue(object.get(key)));
    }
    return map;
  }

  private static Object jsonValue(Object value) throws Exception {
    if (value == JSONObject.NULL) return null;
    if (value instanceof JSONObject) return jsonObjectToMap((JSONObject) value);
    if (value instanceof JSONArray) {
      JSONArray array = (JSONArray) value;
      List<Object> list = new ArrayList<>();
      for (int i = 0; i < array.length(); i++) list.add(jsonValue(array.get(i)));
      return list;
    }
    return value;
  }
}
