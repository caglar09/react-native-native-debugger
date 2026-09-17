'use strict';

const fs = require('fs');
const path = require('path');

function resolvePackageRoot(projectRoot, packageName) {
  try {
    const packageJson = require.resolve(`${packageName}/package.json`, { paths: [projectRoot] });
    return fs.realpathSync(path.dirname(packageJson));
  } catch (_) {
    return null;
  }
}

function readPackageVersion(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function loadConfig(projectRoot) {
  const candidates = [
    'rn-native-debugger.config.js',
    'native-debugger.config.js'
  ];
  for (const name of candidates) {
    const fullPath = path.join(projectRoot, name);
    if (fs.existsSync(fullPath)) {
      delete require.cache[require.resolve(fullPath)];
      return require(fullPath) || {};
    }
  }
  return {};
}

function isIntegrationEnabled(config, key) {
  const value = config && config.integrations && config.integrations[key];
  if (value === false) return false;
  if (value && typeof value === 'object' && value.enabled === false) return false;
  return true;
}

function integrationOptions(config, key) {
  const value = config && config.integrations && config.integrations[key];
  return value && typeof value === 'object' ? value : {};
}

function normalizeThrottleMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 500;
}

function javaHelper(packageName, integrationName, throttleMs = 500) {
  const normalizedThrottleMs = normalizeThrottleMs(throttleMs);
  return `package ${packageName};

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class RNNDInstrumentation {
  private static volatile boolean resolved = false;
  private static Method emitMethod;
  private static Method emitWithLevelMethod;
  private static Method enabledMethod;
  private static volatile boolean permanentlyDisabled = false;
  private static final ConcurrentHashMap<String, Long> LAST_PROGRESS = new ConcurrentHashMap<>();
  private static final long PROGRESS_THROTTLE_MS = ${normalizedThrottleMs}L;

  private RNNDInstrumentation() {}

  private static synchronized void resolve() {
    if (resolved) return;
    resolved = true;
    try {
      Class<?> sink = Class.forName("com.rnnativedebugger.NativeDebugSink");
      Object compiledDebug = sink.getField("COMPILED_DEBUG").get(null);
      if (!(compiledDebug instanceof Boolean) || !((Boolean) compiledDebug)) {
        permanentlyDisabled = true;
        return;
      }
      enabledMethod = sink.getMethod("isEnabled");
      emitMethod = sink.getMethod("emit", String.class, String.class, String.class, Map.class);
      try {
        emitWithLevelMethod = sink.getMethod("emitWithLevel", String.class, String.class, String.class, String.class, Map.class);
      } catch (Throwable ignored) {
        emitWithLevelMethod = null;
      }
    } catch (Throwable ignored) {
      enabledMethod = null;
      emitMethod = null;
      emitWithLevelMethod = null;
    }
  }

  public static boolean enabled() {
    if (permanentlyDisabled) return false;
    if (!resolved) resolve();
    if (permanentlyDisabled) return false;
    if (enabledMethod == null) return false;
    try {
      Object result = enabledMethod.invoke(null);
      return result instanceof Boolean && (Boolean) result;
    } catch (Throwable ignored) {
      return false;
    }
  }

  private static Map<String, Object> map(Object... keyValues) {
    Map<String, Object> data = new LinkedHashMap<>();
    if (keyValues != null) {
      for (int i = 0; i + 1 < keyValues.length; i += 2) {
        data.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
      }
    }
    return data;
  }

  private static void emitMap(String category, String event, String level, Map<String, Object> data) {
    if (!enabled()) return;
    try {
      if (emitWithLevelMethod != null) {
        emitWithLevelMethod.invoke(null, "${integrationName}", category, event, level, data);
      } else if (emitMethod != null) {
        if (level != null) data.put("level", level);
        emitMethod.invoke(null, "${integrationName}", category, event, data);
      }
    } catch (Throwable ignored) {
      // Debug instrumentation must never alter app behavior.
    }
  }

  public static void emit(String category, String event, Object... keyValues) {
    emitMap(category, event, null, map(keyValues));
  }

  public static void log(String level, String tag, String message) {
    emitMap("native-log", "log", level, map(
        "tag", tag == null ? "" : tag,
        "message", message == null ? "" : message));
  }

  public static void error(String tag, String message, Throwable throwable) {
    Map<String, Object> data = map(
        "tag", tag == null ? "" : tag,
        "message", message == null ? "" : message);
    if (throwable != null) {
      data.put("errorType", throwable.getClass().getName());
      data.put("error", throwable.getMessage() == null ? "" : throwable.getMessage());
      try {
        StringWriter writer = new StringWriter();
        throwable.printStackTrace(new PrintWriter(writer));
        data.put("stackTrace", writer.toString());
      } catch (Throwable ignored) {
        data.put("stackTrace", String.valueOf(throwable));
      }
    }
    emitMap("native-error", "exception", "error", data);
  }

  public static void progress(String key, String category, long current, long total, Object... keyValues) {
    if (!enabled()) return;
    long now = System.currentTimeMillis();
    Long previous = LAST_PROGRESS.get(key);
    if (previous != null && now - previous < PROGRESS_THROTTLE_MS && current != total) return;
    LAST_PROGRESS.put(key, now);

    Object[] extra = new Object[(keyValues == null ? 0 : keyValues.length) + 4];
    extra[0] = "current";
    extra[1] = current;
    extra[2] = "total";
    extra[3] = total;
    if (keyValues != null) System.arraycopy(keyValues, 0, extra, 4, keyValues.length);
    emit(category, "progress", extra);
  }
}`;
}

function iosEvent(integration, category, event, dataExpression, level, throttleMs = 500) {
  const normalizedThrottleMs = normalizeThrottleMs(throttleMs);
  const levelPart = level ? `, @"level": @"${level}"` : '';
  return `#if DEBUG
if ([[NSNotificationCenter defaultCenter] respondsToSelector:@selector(postNotificationName:object:userInfo:)]) {
  [[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent"
                                                      object:nil
                                                    userInfo:@{
    @"integration": @"${integration}",
    @"category": @"${category}",
    @"event": @"${event}"${levelPart},
    @"progressThrottleMs": @(${normalizedThrottleMs}),
    @"data": ${dataExpression}
  }];
}
#endif`;
}

function iosNativeLog(integration, level, tagExpression, messageExpression, detailsExpression = null) {
  const details = detailsExpression ? `, @"details": ${detailsExpression}` : '';
  return iosEvent(integration, 'native-log', 'log', `@{
      @"tag": (${tagExpression}) ?: @"",
      @"message": (${messageExpression}) ?: @""${details}
    }`, level);
}

function iosNativeError(integration, tagExpression, messageExpression, errorExpression, detailsExpression = null) {
  const details = detailsExpression ? `, @"details": ${detailsExpression}` : '';
  return iosEvent(integration, 'native-error', 'exception', `@{
      @"tag": (${tagExpression}) ?: @"",
      @"message": (${messageExpression}) ?: @"",
      @"error": [(${errorExpression}) description] ?: @""${details}
    }`, 'error');
}

module.exports = {
  integrationOptions,
  iosEvent,
  iosNativeError,
  iosNativeLog,
  isIntegrationEnabled,
  javaHelper,
  loadConfig,
  normalizeThrottleMs,
  readPackageVersion,
  resolvePackageRoot
};
