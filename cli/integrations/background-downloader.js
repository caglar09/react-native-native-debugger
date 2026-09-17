'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosEvent, javaHelper } = require('../helpers');

const definition = {
  key: 'backgroundDownloader',
  packageName: '@kesha-antonov/react-native-background-downloader',
  tested: ['4.6.3'],
  files(packageRoot) {
    return {
      androidEvents: path.join(packageRoot, 'android/src/main/java/com/eko/DownloadEventEmitter.kt'),
      androidProgress: path.join(packageRoot, 'android/src/main/java/com/eko/ProgressReporter.kt'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/eko/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'ios/RNBackgroundDownloader.mm')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    const emitIOS = (integration, category, event, data, level) =>
      iosEvent(integration, category, event, data, level, options.progressThrottleMs);
    for (const required of [files.androidEvents, files.androidProgress, files.ios]) {
      if (!fs.existsSync(required)) throw new Error(`Missing expected background-downloader source: ${required}`);
    }

    const androidEvents = new PatchPlan(files.androidEvents)
      .insertBefore(
        'bgdl.android.begin',
        '        safeEmit(EVENT_DOWNLOAD_BEGIN, params)',
        `        RNNDInstrumentation.emit("download", "begin",
            "taskId", id,
            "expectedBytes", expectedBytes)`
      )
      .insertBefore(
        'bgdl.android.complete',
        '        safeEmit(EVENT_DOWNLOAD_COMPLETE, params)',
        `        RNNDInstrumentation.emit("download", "completed",
            "taskId", id,
            "location", location,
            "current", bytesDownloaded,
            "total", bytesTotal)`
      )
      .insertBefore(
        'bgdl.android.failed',
        '        safeEmit(EVENT_DOWNLOAD_FAILED, params)',
        `        RNNDInstrumentation.emit("download", "failed",
            "taskId", id,
            "error", error,
            "errorCode", errorCode)`
      );

    const androidProgress = new PatchPlan(files.androidProgress)
      .insertAfter(
        'bgdl.android.progress',
        '        val percent = if (effectiveTotal > 0) bytesDownloaded.toDouble() / effectiveTotal else 0.0',
        `        RNNDInstrumentation.progress(configId, "download", bytesDownloaded, bytesTotal,
            "taskId", configId)`
      );

    const iosFailureBlock = `#if DEBUG
[[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent" object:nil userInfo:@{
  @"integration": @"@kesha-antonov/react-native-background-downloader",
  @"category": @"download",
  @"event": @"failed",
  @"level": @"error",
  @"data": @{
    @"taskId": taskConfig.id ?: @"",
    @"error": error.localizedDescription ?: @"",
    @"errorCode": @(error.code)
  }
}];
#endif`;

    const completionBlock = `#if DEBUG
if (error) {
  [[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent" object:nil userInfo:@{
    @"integration": @"@kesha-antonov/react-native-background-downloader",
    @"category": @"download",
    @"event": @"failed",
    @"level": @"error",
    @"data": @{
      @"taskId": taskConfig.id ?: @"",
      @"error": error.localizedDescription ?: @"",
      @"errorCode": @(error.code)
    }
  }];
} else {
  [[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent" object:nil userInfo:@{
    @"integration": @"@kesha-antonov/react-native-background-downloader",
    @"category": @"download",
    @"event": @"completed",
    @"level": @"info",
    @"data": @{
      @"taskId": taskConfig.id ?: @"",
      @"location": taskConfig.destination ?: @"",
      @"current": @(task.countOfBytesReceived),
      @"total": @(task.countOfBytesExpectedToReceive)
    }
  }];
}
#endif`;

    const ios = new PatchPlan(files.ios)
      .insertAfter(
        'bgdl.ios.started',
        '        DLog(identifier, @"[RNBackgroundDownloader] - [executeDownloadWithRequest]");',
        emitIOS('@kesha-antonov/react-native-background-downloader', 'download', 'started', `@{
      @"taskId": identifier ?: @"",
      @"url": url ?: @"",
      @"destination": destination ?: @""
    }`)
      )
      .insertAfter(
        'bgdl.ios.progress',
        '        DLog(taskConfig.id, @"[RNBackgroundDownloader] - [didWriteData]");',
        emitIOS('@kesha-antonov/react-native-background-downloader', 'download', 'progress', `@{
      @"taskId": taskConfig.id ?: @"",
      @"current": @(bytesTotalWritten),
      @"total": @(bytesTotalExpectedToWrite)
    }`)
      )
      .insertAfter(
        'bgdl.ios.completion',
        '- (void)sendDownloadCompletionEvent:(RNBGDTaskConfig *)taskConfig task:(NSURLSessionDownloadTask *)task error:(NSError *)error {',
        completionBlock
      )
      .insertBefore(
        'bgdl.ios.network-failure',
        '        // Handle failure',
        iosFailureBlock
      );

    const [androidEventsResult, androidProgressResult, iosResult] = commitTransaction(
      [androidEvents, androidProgress, ios],
      [{ filePath: files.androidHelper, content: javaHelper('com.eko', '@kesha-antonov/react-native-background-downloader', options.progressThrottleMs) }]
    );
    return {
      androidEvents: androidEventsResult,
      androidProgress: androidProgressResult,
      ios: iosResult
    };
  },

  unpatch(packageRoot) {
    const files = this.files(packageRoot);
    return {
      androidEvents: unpatchFile(files.androidEvents),
      androidProgress: unpatchFile(files.androidProgress),
      ios: unpatchFile(files.ios),
      helper: removeGeneratedFile(files.androidHelper)
    };
  },

  status(packageRoot) {
    const files = this.files(packageRoot);
    return {
      androidEvents: markerStatus(files.androidEvents),
      androidProgress: markerStatus(files.androidProgress),
      ios: markerStatus(files.ios),
      helper: fs.existsSync(files.androidHelper)
    };
  }
};

module.exports = definition;
