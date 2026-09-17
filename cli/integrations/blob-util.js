'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosEvent, javaHelper } = require('../helpers');

const definition = {
  key: 'blobUtil',
  packageName: 'react-native-blob-util',
  tested: ['0.25.0'],
  files(packageRoot) {
    return {
      android: path.join(packageRoot, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/ReactNativeBlobUtil/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'ios/ReactNativeBlobUtilRequest.mm')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    const emitIOS = (integration, category, event, data, level) =>
      iosEvent(integration, category, event, data, level, options.progressThrottleMs);
    for (const required of [files.android, files.ios]) {
      if (!fs.existsSync(required)) throw new Error(`Missing expected BlobUtil source: ${required}`);
    }

    const android = new PatchPlan(files.android)
      .insertAfter(
        'blob.android.start',
        `    public void run() {
        Context appCtx = ReactNativeBlobUtilImpl.RCTContext.getApplicationContext();`,
        `        RNNDInstrumentation.emit("network", "started",
            "taskId", taskId,
            "method", method,
            "url", url);`
      )
      .insertAfter(
        'blob.android.download-manager-enqueued',
        '                downloadManagerId = dm.enqueue(req);',
        `                RNNDInstrumentation.emit("download", "enqueued",
                    "taskId", taskId,
                    "url", url,
                    "downloadManagerId", downloadManagerId);`
      )
      .insertAfter(
        'blob.android.download-manager-progress',
        `                            long total = cursor.getLong(cursor.getColumnIndex(
                                    DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                            cursor.close();`,
        `                            RNNDInstrumentation.progress(String.valueOf(taskId), "download", written, total,
                                "taskId", taskId,
                                "url", url,
                                "transport", "DownloadManager");`
      )
      .insertAfter(
        'blob.android.okhttp-enqueued',
        '            Call call = client.newCall(req);',
        `            RNNDInstrumentation.emit("network", "request",
                "taskId", taskId,
                "method", method,
                "url", url,
                "transport", "OkHttp");`
      )
      .insertAfter(
        'blob.android.okhttp-failed',
        '                public void onFailure(@NonNull Call call, @NonNull IOException e) {',
        `                    RNNDInstrumentation.emit("network", "failed",
                        "taskId", taskId,
                        "method", method,
                        "url", url,
                        "errorType", e.getClass().getName(),
                        "error", e.getMessage());`
      )
      .insertAfter(
        'blob.android.okhttp-response',
        '                public void onResponse(@NonNull Call call, @NonNull Response response) throws IOException {',
        `                    RNNDInstrumentation.emit("network", "response",
                        "taskId", taskId,
                        "method", method,
                        "url", url,
                        "status", response.code(),
                        "contentLength", response.body() != null ? response.body().contentLength() : -1L);`
      )
      .insertAfter(
        'blob.android.outer-failed',
        `        } catch (Exception error) {
            error.printStackTrace();`,
        `            RNNDInstrumentation.emit("network", "failed",
                "taskId", taskId,
                "method", method,
                "url", url,
                "errorType", error.getClass().getName(),
                "error", error.getMessage());`
      );

    const completionBlock = `#if DEBUG
if (error) {
  [[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent" object:nil userInfo:@{
    @"integration": @"react-native-blob-util",
    @"category": @"network",
    @"event": @"failed",
    @"level": @"error",
    @"data": @{
      @"taskId": taskId ?: @"",
      @"error": error.localizedDescription ?: @"",
      @"errorCode": @(error.code),
      @"received": @(receivedBytes),
      @"expected": @(expectedBytes)
    }
  }];
} else {
  [[NSNotificationCenter defaultCenter] postNotificationName:@"RNNativeDebuggerInstrumentationEvent" object:nil userInfo:@{
    @"integration": @"react-native-blob-util",
    @"category": @"network",
    @"event": @"completed",
    @"level": @"info",
    @"data": @{
      @"taskId": taskId ?: @"",
      @"received": @(receivedBytes),
      @"expected": @(expectedBytes)
    }
  }];
}
#endif`;

    const ios = new PatchPlan(files.ios)
      .insertAfter(
        'blob.ios.start',
        '    self.options = options;',
        emitIOS('react-native-blob-util', 'network', 'started', `@{
      @"taskId": taskId ?: @"",
      @"method": req.HTTPMethod ?: @"GET",
      @"url": req.URL.absoluteString ?: @"",
      @"contentLength": @(contentLength)
    }`)
      )
      .insertAfter(
        'blob.ios.response',
        '    respStatus = statusCode;',
        emitIOS('react-native-blob-util', 'network', 'response', `@{
      @"taskId": taskId ?: @"",
      @"url": response.URL.absoluteString ?: @"",
      @"status": @(statusCode),
      @"contentLength": @(expectedBytes)
    }`, 'info')
      )
      .insertAfter(
        'blob.ios.download-progress',
        '    receivedBytes += [received longValue];',
        emitIOS('react-native-blob-util', 'download', 'progress', `@{
      @"taskId": taskId ?: @"",
      @"current": @(receivedBytes),
      @"total": @(expectedBytes)
    }`)
      )
      .insertAfter(
        'blob.ios.background-download-progress',
        '- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask didWriteData:(int64_t)bytesWritten totalBytesWritten:(int64_t)totalBytesWritten totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {',
        emitIOS('react-native-blob-util', 'download', 'progress', `@{
      @"taskId": taskId ?: @"",
      @"current": @(totalBytesWritten),
      @"total": @(totalBytesExpectedToWrite)
    }`)
      )
      .insertAfter(
        'blob.ios.upload-progress',
        '- (void) URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didSendBodyData:(int64_t)bytesSent totalBytesSent:(int64_t)totalBytesWritten totalBytesExpectedToSend:(int64_t)totalBytesExpectedToWrite\n{',
        emitIOS('react-native-blob-util', 'upload', 'progress', `@{
      @"taskId": taskId ?: @"",
      @"current": @(totalBytesWritten),
      @"total": @(totalBytesExpectedToWrite)
    }`)
      )
      .insertAfter(
        'blob.ios.completed-or-failed',
        '    self.error = error;',
        completionBlock
      );

    const [androidResult, iosResult] = commitTransaction(
      [android, ios],
      [{ filePath: files.androidHelper, content: javaHelper('com.ReactNativeBlobUtil', 'react-native-blob-util', options.progressThrottleMs) }]
    );
    return { android: androidResult, ios: iosResult };
  },

  unpatch(packageRoot) {
    const files = this.files(packageRoot);
    return {
      android: unpatchFile(files.android),
      ios: unpatchFile(files.ios),
      helper: removeGeneratedFile(files.androidHelper)
    };
  },

  status(packageRoot) {
    const files = this.files(packageRoot);
    return {
      android: markerStatus(files.android),
      ios: markerStatus(files.ios),
      helper: fs.existsSync(files.androidHelper)
    };
  }
};

module.exports = definition;
