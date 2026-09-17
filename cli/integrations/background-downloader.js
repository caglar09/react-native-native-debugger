'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { javaHelper } = require('../helpers');

const DLOG_ANCHOR = '#define DLog( taskId, s, ... ) do { if (self->isLogsEnabled) { NSLog( @"<%p %@:(%d)> %@ %@", self, [[NSString stringWithUTF8String:__FILE__] lastPathComponent], __LINE__, [NSString stringWithFormat:(s), ##__VA_ARGS__], ((id)(taskId) ? [NSString stringWithFormat:@"taskId:%@", (id)(taskId)] : @"taskId:NULL") ); } } while(0)';

const IOS_DLOG_MIRROR = `#if DEBUG
static inline void RNNDMirrorBackgroundLog(NSString *level, NSString *tag, NSString *message, id taskId) {
  if (![[NSNotificationCenter defaultCenter] respondsToSelector:@selector(postNotificationName:object:userInfo:)]) return;
  [[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent"
                                                      object:nil
                                                    userInfo:@{
    @"integration": @"@kesha-antonov/react-native-background-downloader",
    @"category": @"native-log",
    @"event": @"log",
    @"level": level ?: @"debug",
    @"data": @{
      @"tag": tag ?: @"RNBackgroundDownloader",
      @"message": message ?: @"",
      @"taskId": taskId ? [taskId description] : @""
    }
  }];
}
#else
static inline void RNNDMirrorBackgroundLog(NSString *level, NSString *tag, NSString *message, id taskId) { }
#endif

#undef DLog
#define DLog( taskId, s, ... ) do { if (self->isLogsEnabled) { NSString *rnndMessage = [NSString stringWithFormat:(s), ##__VA_ARGS__]; NSLog( @"<%p %@:(%d)> %@ %@", self, [[NSString stringWithUTF8String:__FILE__] lastPathComponent], __LINE__, rnndMessage, ((id)(taskId) ? [NSString stringWithFormat:@"taskId:%@", (id)(taskId)] : @"taskId:NULL") ); RNNDMirrorBackgroundLog(@"debug", @"RNBackgroundDownloader", rnndMessage, (id)(taskId)); } } while(0)`;

const definition = {
  key: 'backgroundDownloader',
  packageName: '@kesha-antonov/react-native-background-downloader',
  tested: ['4.6.3'],
  files(packageRoot) {
    return {
      androidModule: path.join(packageRoot, 'android/src/main/java/com/eko/RNBackgroundDownloaderModuleImpl.kt'),
      androidEvents: path.join(packageRoot, 'android/src/main/java/com/eko/DownloadEventEmitter.kt'),
      androidProgress: path.join(packageRoot, 'android/src/main/java/com/eko/ProgressReporter.kt'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/eko/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'ios/RNBackgroundDownloader.mm')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    for (const required of [files.androidModule, files.androidEvents, files.androidProgress, files.ios]) {
      if (!fs.existsSync(required)) throw new Error(`Missing expected background-downloader source: ${required}`);
    }

    const androidModule = new PatchPlan(files.androidModule)
      .stripInjectedBlocks()
      .insertAfter(
        'bgdl.android.native-log.debug',
        '      if (isLogsEnabled) Log.d(tag, message)',
        '      if (isLogsEnabled) RNNDInstrumentation.log("debug", tag, message)'
      )
      .insertAfter(
        'bgdl.android.native-log.warn',
        '      if (isLogsEnabled) Log.w(tag, message)',
        '      if (isLogsEnabled) RNNDInstrumentation.log("warn", tag, message)'
      )
      .insertAfter(
        'bgdl.android.native-log.error',
        '      if (isLogsEnabled) Log.e(tag, message)',
        '      if (isLogsEnabled) RNNDInstrumentation.log("error", tag, message)'
      );

    const androidEvents = new PatchPlan(files.androidEvents)
      .stripInjectedBlocks()
      .insertAfter(
        'bgdl.android.native-error.emit',
        '            RNBackgroundDownloaderModuleImpl.logW(TAG, "Failed to emit $eventName event: ${e.message}")',
        '            RNNDInstrumentation.error(TAG, "Failed to emit " + eventName + " event", e)'
      );

    // v0.2 instrumented ProgressReporter with synthetic progress events. v0.3 deliberately
    // removes those blocks and leaves upstream progress behavior untouched.
    const androidProgress = new PatchPlan(files.androidProgress).stripInjectedBlocks();

    const ios = new PatchPlan(files.ios)
      .stripInjectedBlocks()
      .insertAfter(
        'bgdl.ios.native-log.dlog-mirror',
        DLOG_ANCHOR,
        IOS_DLOG_MIRROR
      )
      .insertAfter(
        'bgdl.ios.native-log.debug-event',
        `    if (!isLogsEnabled) {
        return;
    }`,
        '    RNNDMirrorBackgroundLog(@"debug", @"RNBackgroundDownloader", message ?: @"", taskId);'
      );

    const [androidModuleResult, androidEventsResult, androidProgressResult, iosResult] = commitTransaction(
      [androidModule, androidEvents, androidProgress, ios],
      [{ filePath: files.androidHelper, content: javaHelper('com.eko', '@kesha-antonov/react-native-background-downloader', options.progressThrottleMs) }]
    );
    return {
      androidModule: androidModuleResult,
      androidEvents: androidEventsResult,
      androidProgress: androidProgressResult,
      ios: iosResult
    };
  },

  unpatch(packageRoot) {
    const files = this.files(packageRoot);
    return {
      androidModule: unpatchFile(files.androidModule),
      androidEvents: unpatchFile(files.androidEvents),
      androidProgress: unpatchFile(files.androidProgress),
      ios: unpatchFile(files.ios),
      helper: removeGeneratedFile(files.androidHelper)
    };
  },

  status(packageRoot) {
    const files = this.files(packageRoot);
    return {
      androidModule: markerStatus(files.androidModule),
      androidEvents: markerStatus(files.androidEvents),
      androidProgress: markerStatus(files.androidProgress),
      ios: markerStatus(files.ios),
      helper: fs.existsSync(files.androidHelper)
    };
  }
};

module.exports = definition;
