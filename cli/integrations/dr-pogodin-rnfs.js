'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosNativeLog, javaHelper } = require('../helpers');

const definition = {
  key: 'drPogodinRnfs',
  packageName: '@dr.pogodin/react-native-fs',
  tested: ['2.36.2'],
  files(packageRoot) {
    return {
      android: path.join(packageRoot, 'android/src/main/java/com/drpogodin/reactnativefs/Downloader.kt'),
      androidUploader: path.join(packageRoot, 'android/src/main/java/com/drpogodin/reactnativefs/Uploader.kt'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/drpogodin/reactnativefs/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'ios/Downloader.mm'),
      iosUploader: path.join(packageRoot, 'ios/Uploader.mm')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    for (const required of [files.android, files.androidUploader, files.ios, files.iosUploader]) {
      if (!fs.existsSync(required)) {
        throw new Error(`Missing expected @dr.pogodin/react-native-fs source: ${required}`);
      }
    }

    const android = new PatchPlan(files.android)
      .stripInjectedBlocks()
      .insertAfter(
        'dr-rnfs.android.native-log.gzip',
        'Log.d("Downloader", "File compress with GZIP. Decompress...")',
        '                    RNNDInstrumentation.log("debug", "Downloader", "File compress with GZIP. Decompress...")'
      )
      .insertAfter(
        'dr-rnfs.android.native-log.progress',
        'Log.d("Downloader", "EMIT: $progress, TOTAL:$total")',
        '                                    RNNDInstrumentation.log("debug", "Downloader", "EMIT: $progress, TOTAL:$total")'
      )
      .insertAfter(
        'dr-rnfs.android.native-error.download',
        '} catch (ex: Exception) {',
        '                RNNDInstrumentation.error("Downloader", "Download failed", ex)'
      );

    const androidUploader = new PatchPlan(files.androidUploader)
      .stripInjectedBlocks()
      .insertAfter(
        'dr-rnfs.android-uploader.native-error.upload',
        `        } catch (e: Exception) {
          e.printStackTrace()`,
        '          RNNDInstrumentation.error("Uploader", "Upload failed", e)'
      );

    const ios = new PatchPlan(files.ios)
      .stripInjectedBlocks()
      .insertAfter(
        'dr-rnfs.ios.native-log.progress',
        'NSLog(@"---Progress callback EMIT--- %u", [progress unsignedIntValue]);',
        iosNativeLog(
          '@dr.pogodin/react-native-fs',
          'debug',
          '@"RNFSDownloader"',
          '[NSString stringWithFormat:@"---Progress callback EMIT--- %u", [progress unsignedIntValue]]'
        )
      )
      .insertAfter(
        'dr-rnfs.ios.native-log.move-error',
        'NSLog(@"RNFS download: unable to move tempfile to destination. %@, %@", error, error.userInfo);',
        iosNativeLog(
          '@dr.pogodin/react-native-fs',
          'error',
          '@"RNFSDownloader"',
          '[NSString stringWithFormat:@"RNFS download: unable to move tempfile to destination. %@, %@", error, error.userInfo]',
          '@{ @"error": error.localizedDescription ?: @"", @"errorCode": @(error.code) }'
        )
      )
      .insertAfter(
        'dr-rnfs.ios.native-log.complete-error',
        'NSLog(@"RNFS download: didCompleteWithError %@, %@", error, error.userInfo);',
        iosNativeLog(
          '@dr.pogodin/react-native-fs',
          'error',
          '@"RNFSDownloader"',
          '[NSString stringWithFormat:@"RNFS download: didCompleteWithError %@, %@", error, error.userInfo]',
          '@{ @"error": error.localizedDescription ?: @"", @"errorCode": @(error.code) }'
        )
      );

    const iosUploaderError = `if (error != nil) {
${iosNativeLog(
  '@dr.pogodin/react-native-fs',
  'error',
  '@"RNFSUploader"',
  'error.localizedDescription ?: @"Upload failed"',
  '@{ @"error": error.localizedDescription ?: @"", @"errorCode": @(error.code) }'
)}
}`;

    const iosUploader = new PatchPlan(files.iosUploader)
      .stripInjectedBlocks()
      .insertAfter(
        'dr-rnfs.ios-uploader.native-log.missing-file',
        'NSLog(@"Failed to open target file at path: %@", filepath);',
        iosNativeLog(
          '@dr.pogodin/react-native-fs',
          'error',
          '@"RNFSUploader"',
          '[NSString stringWithFormat:@"Failed to open target file at path: %@", filepath]',
          '@{ @"path": filepath ?: @"" }'
        )
      )
      .insertAfter(
        'dr-rnfs.ios-uploader.native-error.complete',
        '- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error\n{',
        iosUploaderError
      );

    const [androidResult, androidUploaderResult, iosResult, iosUploaderResult] = commitTransaction(
      [android, androidUploader, ios, iosUploader],
      [{
        filePath: files.androidHelper,
        content: javaHelper('com.drpogodin.reactnativefs', '@dr.pogodin/react-native-fs', options.progressThrottleMs)
      }]
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
