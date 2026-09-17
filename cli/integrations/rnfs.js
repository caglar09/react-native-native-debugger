'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosNativeLog, javaHelper } = require('../helpers');

const definition = {
  key: 'rnfs',
  packageName: 'react-native-fs',
  tested: ['2.20.0'],
  files(packageRoot) {
    return {
      android: path.join(packageRoot, 'android/src/main/java/com/rnfs/Downloader.java'),
      androidUploader: path.join(packageRoot, 'android/src/main/java/com/rnfs/Uploader.java'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/rnfs/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'Downloader.m'),
      iosUploader: path.join(packageRoot, 'Uploader.m')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    for (const required of [files.android, files.androidUploader, files.ios, files.iosUploader]) {
      if (!fs.existsSync(required)) throw new Error(`Missing expected RNFS source: ${required}`);
    }

    // Strip instrumentation from older debugger versions in-memory first. The transaction
    // writes only after all current-version anchors validate.
    const android = new PatchPlan(files.android)
      .stripInjectedBlocks()
      .insertAfter(
        'rnfs.android.native-log.progress',
        'Log.d("Downloader", "EMIT: " + String.valueOf(progress) + ", TOTAL:" + String.valueOf(total));',
        '                  RNNDInstrumentation.log("debug", "Downloader", "EMIT: " + String.valueOf(progress) + ", TOTAL:" + String.valueOf(total));'
      )
      .insertAfter(
        'rnfs.android.native-error.download',
        '} catch (Exception ex) {',
        '          RNNDInstrumentation.error("Downloader", "Download failed", ex);'
      );

    const androidUploader = new PatchPlan(files.androidUploader)
      .stripInjectedBlocks()
      .insertAfter(
        'rnfs.android-uploader.native-error.upload',
        '} catch (Exception e) {',
        '                    RNNDInstrumentation.error("Uploader", "Upload failed", e);'
      );

    const ios = new PatchPlan(files.ios)
      .stripInjectedBlocks()
      .insertAfter(
        'rnfs.ios.native-log.progress',
        'NSLog(@"---Progress callback EMIT--- %u", [progress unsignedIntValue]);',
        iosNativeLog(
          'react-native-fs',
          'debug',
          '@"RNFSDownloader"',
          '[NSString stringWithFormat:@"---Progress callback EMIT--- %u", [progress unsignedIntValue]]'
        )
      )
      .insertAfter(
        'rnfs.ios.native-log.move-error',
        'NSLog(@"RNFS download: unable to move tempfile to destination. %@, %@", error, error.userInfo);',
        iosNativeLog(
          'react-native-fs',
          'error',
          '@"RNFSDownloader"',
          '[NSString stringWithFormat:@"RNFS download: unable to move tempfile to destination. %@, %@", error, error.userInfo]',
          '@{ @"error": error.localizedDescription ?: @"", @"errorCode": @(error.code) }'
        )
      )
      .insertAfter(
        'rnfs.ios.native-log.complete-error',
        'NSLog(@"RNFS download: didCompleteWithError %@, %@", error, error.userInfo);',
        iosNativeLog(
          'react-native-fs',
          'error',
          '@"RNFSDownloader"',
          '[NSString stringWithFormat:@"RNFS download: didCompleteWithError %@, %@", error, error.userInfo]',
          '@{ @"error": error.localizedDescription ?: @"", @"errorCode": @(error.code) }'
        )
      );

    const iosUploaderError = `if (error != nil) {
${iosNativeLog(
  'react-native-fs',
  'error',
  '@"RNFSUploader"',
  'error.localizedDescription ?: @"Upload failed"',
  '@{ @"error": error.localizedDescription ?: @"", @"errorCode": @(error.code) }'
)}
}`;

    const iosUploader = new PatchPlan(files.iosUploader)
      .stripInjectedBlocks()
      .insertAfter(
        'rnfs.ios-uploader.native-log.missing-file',
        'NSLog(@"Failed to open target file at path: %@", filepath);',
        iosNativeLog(
          'react-native-fs',
          'error',
          '@"RNFSUploader"',
          '[NSString stringWithFormat:@"Failed to open target file at path: %@", filepath]',
          '@{ @"path": filepath ?: @"" }'
        )
      )
      .insertAfter(
        'rnfs.ios-uploader.native-error.complete',
        '- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error\n{',
        iosUploaderError
      );

    const [androidResult, androidUploaderResult, iosResult, iosUploaderResult] = commitTransaction(
      [android, androidUploader, ios, iosUploader],
      [{ filePath: files.androidHelper, content: javaHelper('com.rnfs', 'react-native-fs', options.progressThrottleMs) }]
    );
    return { android: androidResult, androidUploader: androidUploaderResult, ios: iosResult, iosUploader: iosUploaderResult };
  },

  unpatch(packageRoot) {
    const files = this.files(packageRoot);
    return {
      android: unpatchFile(files.android),
      androidUploader: unpatchFile(files.androidUploader),
      ios: unpatchFile(files.ios),
      iosUploader: unpatchFile(files.iosUploader),
      helper: removeGeneratedFile(files.androidHelper)
    };
  },

  status(packageRoot) {
    const files = this.files(packageRoot);
    return {
      android: markerStatus(files.android),
      androidUploader: markerStatus(files.androidUploader),
      ios: markerStatus(files.ios),
      iosUploader: markerStatus(files.iosUploader),
      helper: fs.existsSync(files.androidHelper)
    };
  }
};

module.exports = definition;
