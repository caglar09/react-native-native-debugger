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

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class RNNDInstrumentation {
  private static volatile boolean resolved = false;
  private static Method emitMethod;
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
    } catch (Throwable ignored) {
      enabledMethod = null;
      emitMethod = null;
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

  public static void emit(String category, String event, Object... keyValues) {
    if (!enabled()) return;
    try {
      Map<String, Object> data = new LinkedHashMap<>();
      if (keyValues != null) {
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
          data.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
      }
      emitMethod.invoke(null, "${integrationName}", category, event, data);
    } catch (Throwable ignored) {
      // Debug instrumentation must never alter app behavior.
    }
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

module.exports = {
  integrationOptions,
  iosEvent,
  isIntegrationEnabled,
  javaHelper,
  loadConfig,
  normalizeThrottleMs,
  readPackageVersion,
  resolvePackageRoot
};
