'use strict';

const fs = require('fs');
const path = require('path');
const { PatchPlan, commitTransaction, markerStatus, unpatchFile, removeGeneratedFile } = require('../patch-engine');
const { iosNativeError, iosNativeLog, javaHelper, readPackageVersion } = require('../helpers');

const definition = {
  key: 'blobUtil',
  packageName: 'react-native-blob-util',
  tested: ['0.22.2', '0.25.0'],
  files(packageRoot) {
    return {
      android: path.join(packageRoot, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java'),
      androidHelper: path.join(packageRoot, 'android/src/main/java/com/ReactNativeBlobUtil/RNNDInstrumentation.java'),
      ios: path.join(packageRoot, 'ios/ReactNativeBlobUtilRequest.mm')
    };
  },

  patch(packageRoot, options = {}) {
    const files = this.files(packageRoot);
    for (const required of [files.android, files.ios]) {
      if (!fs.existsSync(required)) throw new Error(`Missing expected BlobUtil source: ${required}`);
    }

    const android = new PatchPlan(files.android)
      .stripInjectedBlocks()
      .insertAfter(
        'blob.android.native-error.cookie-url',
        `                } catch (MalformedURLException e) {
                    e.printStackTrace();`,
        `                    RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Invalid URL while reading cookies: " + url, e);`
      )
      .insertAfter(
        'blob.android.native-error.request-url',
        `            } catch (MalformedURLException e) {
                e.printStackTrace();`,
        `                RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Invalid request URL: " + url, e);`
      )
      .insertAfter(
        'blob.android.native-error.socket',
        '                    } catch (SocketException e) {',
        '                        RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Socket error while sending request", e);'
      )
      .insertAfter(
        'blob.android.native-error.socket-timeout',
        '                    } catch (SocketTimeoutException e) {',
        '                        RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Socket timeout while sending request", e);'
      )
      .insertAfter(
        'blob.android.native-error.interceptor',
        '                    } catch (Exception ex) {',
        '                        RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Unexpected interceptor error", ex);'
      )
      .insertAfter(
        'blob.android.native-error.okhttp',
        '                public void onFailure(@NonNull Call call, @NonNull IOException e) {',
        '                    RNNDInstrumentation.error("ReactNativeBlobUtilReq", "OkHttp request failed: " + method + " " + url, e);'
      )
      .insertAfter(
        'blob.android.native-error.outer',
        `        } catch (Exception error) {
            error.printStackTrace();`,
        `            RNNDInstrumentation.error("ReactNativeBlobUtilReq", "ReactNativeBlobUtil request error", error);`
      )
      .insertAfter(
        'blob.android.native-error.file-transformer',
        `                            } catch (Exception e) {
                                invoke_callback("Error from file transformer:" + e.getLocalizedMessage(),  respmap.copy());`,
        '                                RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Error from file transformer", e);'
      )
      .insertAfter(
        'blob.android.native-error.file-storage-read',
        `                } catch (Exception ignored) {
//                    ignored.printStackTrace();`,
        '                    RNNDInstrumentation.error("ReactNativeBlobUtilReq", "FileStorage response read failed", ignored);'
      )
      .insertAfter(
        'blob.android.native-error.file-storage-cast',
        '                } catch (ClassCastException ex) {',
        '                    RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Unexpected FileStorage response type", ex);'
      )
      .insertAfter(
        'blob.android.native-error.response-body',
        `                        } catch (IOException exception) {
                            exception.printStackTrace();`,
        '                            RNNDInstrumentation.error("ReactNativeBlobUtilReq", "Could not read unexpected response body", exception);'
      );

    const completionError = `if (error) {
${iosNativeError(
  'react-native-blob-util',
  '@"ReactNativeBlobUtilRequest"',
  'error.localizedDescription ?: @"NSURLSession task failed"',
  'error',
  '@{ @"taskId": taskId ?: @"", @"url": task.originalRequest.URL.absoluteString ?: @"", @"errorDomain": error.domain ?: @"", @"errorCode": @(error.code) }'
)}
}`;

    const ios = new PatchPlan(files.ios)
      .stripInjectedBlocks()
      .insertAfter(
        'blob.ios.native-log.write-file-error',
        '            NSLog(@"write file error");',
        iosNativeLog(
          'react-native-blob-util',
          'error',
          '@"ReactNativeBlobUtilRequest"',
          '@"write file error"',
          '@{ @"exception": [ex description] ?: @"" }'
        )
      )
      .insertAfter(
        'blob.ios.native-log.oops',
        '        NSLog(@"oops");',
        iosNativeLog('react-native-blob-util', 'warn', '@"ReactNativeBlobUtilRequest"', '@"oops"')
      )
      .insertAfter(
        'blob.ios.native-error.session',
        '    self.error = error;',
        completionError
      )
      .insertAfter(
        'blob.ios.native-error.file-transformer',
        `                    errMsg = [NSString stringWithFormat:@"Exception on File Transformer: '%@' ", [ex description]];`,
        iosNativeError(
          'react-native-blob-util',
          '@"ReactNativeBlobUtilRequest"',
          'errMsg',
          'ex',
          '@{ @"taskId": taskId ?: @"" }'
        )
      )
      .insertAfter(
        'blob.ios.native-log.background-finished',
        '    NSLog(@"sess done in background");',
        iosNativeLog('react-native-blob-util', 'debug', '@"ReactNativeBlobUtilRequest"', '@"sess done in background"')
      );

    // 0.25.0 added explicit custom-CA diagnostics. Mirror only the log calls that
    // actually exist in that validated source version; 0.22.2 must not require them.
    if (readPackageVersion(packageRoot) === '0.25.0') {
      ios
        .insertAfter(
          'blob.ios.native-log.ca-none-loaded',
          '            NSLog(@"[ReactNativeBlobUtil] customCACerts: none of %@ could be loaded from the app bundle", customCACerts);',
          iosNativeLog(
            'react-native-blob-util',
            'error',
            '@"ReactNativeBlobUtilRequest"',
            '[NSString stringWithFormat:@"[ReactNativeBlobUtil] customCACerts: none of %@ could be loaded from the app bundle", customCACerts]'
          )
        )
        .insertAfter(
          'blob.ios.native-log.ca-trust-failed',
          '                NSLog(@"[ReactNativeBlobUtil] Custom CA trust evaluation failed: %@", (__bridge NSError *)error);',
          iosNativeLog(
            'react-native-blob-util',
            'error',
            '@"ReactNativeBlobUtilRequest"',
            '[NSString stringWithFormat:@"[ReactNativeBlobUtil] Custom CA trust evaluation failed: %@", (__bridge NSError *)error]'
          )
        )
        .insertAfter(
          'blob.ios.native-log.ca-certificate-missing',
          `    NSLog(@"[ReactNativeBlobUtil] Could not load certificate '%@' from bundle", certName);`,
          iosNativeLog(
            'react-native-blob-util',
            'error',
            '@"ReactNativeBlobUtilRequest"',
            `[NSString stringWithFormat:@"[ReactNativeBlobUtil] Could not load certificate '%@' from bundle", certName]`
          )
        );
    }

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
