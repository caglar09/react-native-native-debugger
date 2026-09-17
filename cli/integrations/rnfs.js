'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosEvent, javaHelper } = require('../helpers');

const definition = {
  key: 'rnfs',
  packageName: 'react-native-fs',
  tested: ['2.20.0'],
  files(packageRoot) {
    return {
      android: path.join(packageRoot, 'android/src/main/java/com/rnfs/Downloader.java'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/rnfs/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'Downloader.m')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    const emitIOS = (integration, category, event, data, level) =>
      iosEvent(integration, category, event, data, level, options.progressThrottleMs);
    for (const required of [files.android, files.ios]) {
      if (!fs.existsSync(required)) throw new Error(`Missing expected RNFS source: ${required}`);
    }

    // Build both plans completely before touching disk (transactional per integration).
    const android = new PatchPlan(files.android)
      .insertAfter(
        'rnfs.android.start',
        '      connection = (HttpURLConnection)param.src.openConnection();',
        `      RNNDInstrumentation.emit("download", "started",
          "url", param.src.toString(),
          "destination", param.dest.getAbsolutePath());`
      )
      .insertAfter(
        'rnfs.android.response',
        '      long lengthOfFile = getContentLength(connection);',
        `      RNNDInstrumentation.emit("download", "response",
          "url", param.src.toString(),
          "status", statusCode,
          "contentLength", lengthOfFile);`
      )
      .insertAfter(
        'rnfs.android.progress',
        '          total += count;',
        `          RNNDInstrumentation.progress(param.src.toString(), "download", total, lengthOfFile,
              "url", param.src.toString(),
              "destination", param.dest.getAbsolutePath());`
      )
      .insertAfter(
        'rnfs.android.completed',
        '        res.bytesWritten = total;',
        `        RNNDInstrumentation.emit("download", "completed",
            "url", param.src.toString(),
            "destination", param.dest.getAbsolutePath(),
            "bytesWritten", total,
            "status", statusCode);`
      )
      .insertAfter(
        'rnfs.android.failed',
        '        } catch (Exception ex) {',
        `          RNNDInstrumentation.emit("download", "failed",
              "url", mParam != null && mParam.src != null ? mParam.src.toString() : "",
              "errorType", ex.getClass().getName(),
              "error", ex.getMessage());`
      );

    const ios = new PatchPlan(files.ios)
      .insertAfter(
        'rnfs.ios.start',
        '  NSURL* url = [NSURL URLWithString:_params.fromUrl];',
        emitIOS('react-native-fs', 'download', 'started', `@{
      @"url": _params.fromUrl ?: @"",
      @"destination": _params.toFile ?: @""
    }`)
      )
      .insertAfter(
        'rnfs.ios.progress',
        `- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask didWriteData:(int64_t)bytesWritten totalBytesWritten:(int64_t)totalBytesWritten totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite
{
  NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)downloadTask.response;`,
        emitIOS('react-native-fs', 'download', 'progress', `@{
      @"url": self.params.fromUrl ?: @"",
      @"destination": self.params.toFile ?: @"",
      @"current": @(totalBytesWritten),
      @"total": @(totalBytesExpectedToWrite),
      @"status": @(httpResponse.statusCode)
    }`)
      )
      .insertBefore(
        'rnfs.ios.completed',
        '  return _params.completeCallback(_statusCode, _bytesWritten);',
        emitIOS('react-native-fs', 'download', 'completed', `@{
      @"url": _params.fromUrl ?: @"",
      @"destination": _params.toFile ?: @"",
      @"status": _statusCode ?: @0,
      @"bytesWritten": _bytesWritten ?: @0
    }`, 'info')
      )
      .insertAfter(
        'rnfs.ios.failed',
        `- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if (error) {`,
        emitIOS('react-native-fs', 'download', 'failed', `@{
      @"url": _params.fromUrl ?: @"",
      @"destination": _params.toFile ?: @"",
      @"error": error.localizedDescription ?: @"",
      @"errorCode": @(error.code)
    }`, 'error')
      );

    // Commit only after every anchor and generated-file ownership check succeeded.
    const [androidResult, iosResult] = commitTransaction(
      [android, ios],
      [{ filePath: files.androidHelper, content: javaHelper('com.rnfs', 'react-native-fs', options.progressThrottleMs) }]
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
