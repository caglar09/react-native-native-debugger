'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosEvent, javaHelper } = require('../helpers');

const definition = {
  key: 'drPogodinRnfs',
  packageName: '@dr.pogodin/react-native-fs',
  tested: ['2.36.2'],
  files(packageRoot) {
    return {
      android: path.join(packageRoot, 'android/src/main/java/com/drpogodin/reactnativefs/Downloader.kt'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/drpogodin/reactnativefs/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'ios/Downloader.mm')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    const emitIOS = (integration, category, event, data, level) =>
      iosEvent(integration, category, event, data, level, options.progressThrottleMs);

    for (const required of [files.android, files.ios]) {
      if (!fs.existsSync(required)) {
        throw new Error(`Missing expected @dr.pogodin/react-native-fs source: ${required}`);
      }
    }

    const android = new PatchPlan(files.android)
      .insertAfter(
        'dr-rnfs.android.start',
        '            connection = param!!.src!!.openConnection() as HttpURLConnection',
        `            RNNDInstrumentation.emit("download", "started",
                "url", param.src?.toString() ?: "",
                "destination", param.dest?.absolutePath ?: "")`
      )
      .insertAfter(
        'dr-rnfs.android.response',
        '            var lengthOfFile = getContentLength(connection)',
        `            RNNDInstrumentation.emit("download", "response",
                "url", param.src?.toString() ?: "",
                "status", statusCode,
                "contentLength", lengthOfFile)`
      )
      .insertAfter(
        'dr-rnfs.android.progress',
        '                    total += count.toLong()',
        `                    RNNDInstrumentation.progress(param.src?.toString() ?: "", "download", total, lengthOfFile,
                        "url", param.src?.toString() ?: "",
                        "destination", param.dest?.absolutePath ?: "")`
      )
      .insertAfter(
        'dr-rnfs.android.completed',
        '                res.bytesWritten = total',
        `                RNNDInstrumentation.emit("download", "completed",
                    "url", param.src?.toString() ?: "",
                    "destination", param.dest?.absolutePath ?: "",
                    "bytesWritten", total,
                    "status", statusCode)`
      )
      .insertAfter(
        'dr-rnfs.android.failed',
        '            } catch (ex: Exception) {',
        `                RNNDInstrumentation.emit("download", "failed",
                    "url", mParam?.src?.toString() ?: "",
                    "errorType", ex.javaClass.name,
                    "error", ex.message ?: "")`
      );

    const progressSignature = `- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask didWriteData:(int64_t)bytesWritten totalBytesWritten:(int64_t)totalBytesWritten totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite
{`;

    const ios = new PatchPlan(files.ios)
      .insertAfter(
        'dr-rnfs.ios.start',
        '  NSURL* url = [NSURL URLWithString:_params.fromUrl];',
        emitIOS('@dr.pogodin/react-native-fs', 'download', 'started', `@{
      @"url": _params.fromUrl ?: @"",
      @"destination": _params.toFile ?: @""
    }`)
      )
      .insertAfter(
        'dr-rnfs.ios.progress',
        progressSignature,
        emitIOS('@dr.pogodin/react-native-fs', 'download', 'progress', `@{
      @"url": self.params.fromUrl ?: @"",
      @"destination": self.params.toFile ?: @"",
      @"current": @(totalBytesWritten),
      @"total": @(totalBytesExpectedToWrite)
    }`)
      )
      .insertBefore(
        'dr-rnfs.ios.completed',
        '  return _params.completeCallback(_statusCode, _bytesWritten, httpResponse.allHeaderFields, responseBodyString);',
        emitIOS('@dr.pogodin/react-native-fs', 'download', 'completed', `@{
      @"url": _params.fromUrl ?: @"",
      @"destination": _params.toFile ?: @"",
      @"status": _statusCode ?: @0,
      @"bytesWritten": _bytesWritten ?: @0
    }`, 'info')
      )
      .insertAfter(
        'dr-rnfs.ios.failed',
        `- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if (error) {`,
        emitIOS('@dr.pogodin/react-native-fs', 'download', 'failed', `@{
      @"url": _params.fromUrl ?: @"",
      @"destination": _params.toFile ?: @"",
      @"error": error.localizedDescription ?: @"",
      @"errorCode": @(error.code)
    }`, 'error')
      );

    const [androidResult, iosResult] = commitTransaction(
      [android, ios],
      [{
        filePath: files.androidHelper,
        content: javaHelper('com.drpogodin.reactnativefs', '@dr.pogodin/react-native-fs', options.progressThrottleMs)
      }]
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
