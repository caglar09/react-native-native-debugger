'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rnfs = require('../cli/integrations/rnfs');
const drRnfs = require('../cli/integrations/dr-pogodin-rnfs');
const blob = require('../cli/integrations/blob-util');
const bgdl = require('../cli/integrations/background-downloader');

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function assertPatchedThenUnpatched(definition, root, files) {
  definition.patch(root, { progressThrottleMs: 321 });
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(content, /@rn-native-debugger:start/);
  }
  const status = definition.status(root);
  assert.ok(Object.values(status).some((value) => value === true || (value && value.markers > 0)));

  // Reapplying must converge to the same instrumentation rather than duplicating it.
  const snapshots = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  definition.patch(root, { progressThrottleMs: 321 });
  files.forEach((file, index) => {
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), snapshots[index]);
  });

  definition.unpatch(root);
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(content, /@rn-native-debugger:start/);
  }
}

function rnfsAndroidSource() {
  return `
package com.rnfs;
class Downloader {
 void x() {
                  Log.d("Downloader", "EMIT: " + String.valueOf(progress) + ", TOTAL:" + String.valueOf(total));
        } catch (Exception ex) {
  }
}`;
}


function rnfsAndroidUploaderSource() {
  return `
package com.rnfs;
class Uploader {
 void x() {
                try {
                  upload();
                } catch (Exception e) {
                  res = null;
                }
  }
}`;
}

function rnfsIOSUploaderSource() {
  return `
- (void)uploadFiles {
      NSLog(@"Failed to open target file at path: %@", filepath);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if(error != nil) {
    return _params.errorCallback(error);
  }
}
`;
}

function rnfsIOSSource() {
  return `
- (void)x {
            NSLog(@"---Progress callback EMIT--- %u", [progress unsignedIntValue]);
  if (error) {
    NSLog(@"RNFS download: unable to move tempfile to destination. %@, %@", error, error.userInfo);
  }
  if (error) {
    NSLog(@"RNFS download: didCompleteWithError %@, %@", error, error.userInfo);
  }
}`;
}

test('RNFS mirrors upstream native logs and real exceptions without synthetic lifecycle events', () => {
  const root = tempRoot('rnnd-rnfs-');
  write(root, 'android/src/main/java/com/rnfs/Downloader.java', rnfsAndroidSource());
  write(root, 'Downloader.m', rnfsIOSSource());
  write(root, 'android/src/main/java/com/rnfs/Uploader.java', rnfsAndroidUploaderSource());
  write(root, 'Uploader.m', rnfsIOSUploaderSource());

  rnfs.patch(root);
  const android = fs.readFileSync(path.join(root, 'android/src/main/java/com/rnfs/Downloader.java'), 'utf8');
  const ios = fs.readFileSync(path.join(root, 'Downloader.m'), 'utf8');
  const androidUploader = fs.readFileSync(path.join(root, 'android/src/main/java/com/rnfs/Uploader.java'), 'utf8');
  const iosUploader = fs.readFileSync(path.join(root, 'Uploader.m'), 'utf8');

  assert.match(android, /RNNDInstrumentation\.log\("debug", "Downloader"/);
  assert.match(android, /RNNDInstrumentation\.error\("Downloader", "Download failed", ex\)/);
  assert.match(ios, /@"category": @"native-log"/);
  assert.match(androidUploader, /RNNDInstrumentation\.error\("Uploader", "Upload failed", e\)/);
  assert.match(iosUploader, /@"category": @"native-error"/);
  assert.match(iosUploader, /@"RNFSUploader"/);
  assert.doesNotMatch(android, /"started"|"completed"|RNNDInstrumentation\.progress/);
  assert.doesNotMatch(ios, /@"event": @"progress"|@"event": @"completed"/);

  rnfs.unpatch(root);
});

function drRnfsAndroidSource() {
  return `
package com.drpogodin.reactnativefs
class Downloader {
  fun x() {
                    Log.d("Downloader", "File compress with GZIP. Decompress...")
                                    Log.d("Downloader", "EMIT: $progress, TOTAL:$total")
            } catch (ex: Exception) {
  }
}`;
}


function drRnfsAndroidUploaderSource() {
  return `
package com.drpogodin.reactnativefs
class Uploader {
  fun x() {
        try {
          upload()
        } catch (e: Exception) {
          e.printStackTrace()
          throw e
        }
  }
}`;
}

function drRnfsIOSUploaderSource() {
  return `
- (void)uploadFiles {
      NSLog(@"Failed to open target file at path: %@", filepath);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if(error != nil) {
    return _params.errorCallback(error);
  }
}
`;
}

function drRnfsIOSSource() {
  return `
- (void)x {
            NSLog(@"---Progress callback EMIT--- %u", [progress unsignedIntValue]);
    NSLog(@"RNFS download: unable to move tempfile to destination. %@, %@", error, error.userInfo);
    NSLog(@"RNFS download: didCompleteWithError %@, %@", error, error.userInfo);
}`;
}

test('@dr.pogodin/react-native-fs 2.36.2 mirrors existing Log.d/NSLog and caught download exceptions', () => {
  const root = tempRoot('rnnd-dr-rnfs-');
  write(root, 'android/src/main/java/com/drpogodin/reactnativefs/Downloader.kt', drRnfsAndroidSource());
  write(root, 'ios/Downloader.mm', drRnfsIOSSource());
  write(root, 'android/src/main/java/com/drpogodin/reactnativefs/Uploader.kt', drRnfsAndroidUploaderSource());
  write(root, 'ios/Uploader.mm', drRnfsIOSUploaderSource());

  assert.deepEqual(drRnfs.tested, ['2.36.2']);
  drRnfs.patch(root, { progressThrottleMs: 321 });
  const android = fs.readFileSync(path.join(root, 'android/src/main/java/com/drpogodin/reactnativefs/Downloader.kt'), 'utf8');
  const androidUploader = fs.readFileSync(path.join(root, 'android/src/main/java/com/drpogodin/reactnativefs/Uploader.kt'), 'utf8');
  const ios = fs.readFileSync(path.join(root, 'ios/Downloader.mm'), 'utf8');
  const iosUploader = fs.readFileSync(path.join(root, 'ios/Uploader.mm'), 'utf8');
  assert.match(android, /RNNDInstrumentation\.log\("debug", "Downloader"/);
  assert.match(android, /RNNDInstrumentation\.error\("Downloader", "Download failed", ex\)/);
  assert.match(androidUploader, /RNNDInstrumentation\.error\("Uploader", "Upload failed", e\)/);
  assert.match(ios, /@"category": @"native-log"/);
  assert.match(iosUploader, /@"category": @"native-error"/);
  assert.match(iosUploader, /@"RNFSUploader"/);
  assert.doesNotMatch(android, /RNNDInstrumentation\.progress|"started"|"completed"/);
  const snapshots = [
    'android/src/main/java/com/drpogodin/reactnativefs/Downloader.kt',
    'android/src/main/java/com/drpogodin/reactnativefs/Uploader.kt',
    'ios/Downloader.mm',
    'ios/Uploader.mm'
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  drRnfs.patch(root, { progressThrottleMs: 321 });
  [
    'android/src/main/java/com/drpogodin/reactnativefs/Downloader.kt',
    'android/src/main/java/com/drpogodin/reactnativefs/Uploader.kt',
    'ios/Downloader.mm',
    'ios/Uploader.mm'
  ].forEach((file, index) => assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), snapshots[index]));
  drRnfs.unpatch(root);
});

function blobAndroidSource() {
  return `
class ReactNativeBlobUtilReq {
  void x() {
                try {
                    req.addRequestHeader("Cookie", cookie);
                } catch (MalformedURLException e) {
                    e.printStackTrace();
                }

            try {
                builder.url(new URL(url));
            } catch (MalformedURLException e) {
                e.printStackTrace();
            }

                    } catch (SocketException e) {
                    } catch (SocketTimeoutException e) {
                    } catch (Exception ex) {
                        if (originalResponse != null) {
                            originalResponse.close();
                        }

                public void onFailure(@NonNull Call call, @NonNull IOException e) {

        } catch (Exception error) {
            error.printStackTrace();

                            } catch (Exception e) {
                                invoke_callback("Error from file transformer:" + e.getLocalizedMessage(),  respmap.copy());

                } catch (Exception ignored) {
//                    ignored.printStackTrace();

                } catch (ClassCastException ex) {

                        } catch (IOException exception) {
                            exception.printStackTrace();
  }
}`;
}

function blobIOSSource() {
  return `
- (void)x {
        @catch(NSException * ex)
        {
            NSLog(@"write file error");
        }
        NSLog(@"oops");
    self.error = error;
                    errMsg = [NSString stringWithFormat:@"Exception on File Transformer: '%@' ", [ex description]];
    NSLog(@"sess done in background");
}`;
}

test('BlobUtil mirrors native failures/logs instead of creating request/progress/completed events', () => {
  const root = tempRoot('rnnd-blob-');
  write(root, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java', blobAndroidSource());
  write(root, 'ios/ReactNativeBlobUtilRequest.mm', blobIOSSource());

  assertPatchedThenUnpatched(blob, root, [
    'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java',
    'ios/ReactNativeBlobUtilRequest.mm'
  ]);

  // Re-patch to inspect the resulting shape.
  blob.patch(root);
  const android = fs.readFileSync(path.join(root, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java'), 'utf8');
  const ios = fs.readFileSync(path.join(root, 'ios/ReactNativeBlobUtilRequest.mm'), 'utf8');
  assert.match(android, /RNNDInstrumentation\.error/);
  assert.match(ios, /@"category": @"native-log"/);
  assert.match(ios, /@"category": @"native-error"/);
  assert.doesNotMatch(android, /RNNDInstrumentation\.progress|"request"|"response"|"completed"/);
  assert.doesNotMatch(ios, /@"event": @"progress"|@"event": @"completed"|@"event": @"started"/);
  blob.unpatch(root);
});


test('BlobUtil 0.25.0 mirrors the native custom-CA NSLogs introduced by that version', () => {
  const root = tempRoot('rnnd-blob-025-');
  write(root, 'package.json', JSON.stringify({ name: 'react-native-blob-util', version: '0.25.0' }));
  write(root, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java', blobAndroidSource());
  write(root, 'ios/ReactNativeBlobUtilRequest.mm', `${blobIOSSource()}
            NSLog(@"[ReactNativeBlobUtil] customCACerts: none of %@ could be loaded from the app bundle", customCACerts);
                NSLog(@"[ReactNativeBlobUtil] Custom CA trust evaluation failed: %@", (__bridge NSError *)error);
    NSLog(@"[ReactNativeBlobUtil] Could not load certificate '%@' from bundle", certName);
`);

  blob.patch(root);
  const ios = fs.readFileSync(path.join(root, 'ios/ReactNativeBlobUtilRequest.mm'), 'utf8');
  assert.match(ios, /blob\.ios\.native-log\.ca-none-loaded/);
  assert.match(ios, /blob\.ios\.native-log\.ca-trust-failed/);
  assert.match(ios, /blob\.ios\.native-log\.ca-certificate-missing/);
  blob.unpatch(root);
});

test('BlobUtil declares both validated source versions', () => {
  assert.deepEqual(blob.tested, ['0.22.2', '0.25.0']);
});

function bgModuleSource() {
  return `
package com.eko
class RNBackgroundDownloaderModuleImpl {
  companion object {
    fun logD(tag: String, message: String) {
      if (isLogsEnabled) Log.d(tag, message)
    }
    fun logW(tag: String, message: String) {
      if (isLogsEnabled) Log.w(tag, message)
    }
    fun logE(tag: String, message: String) {
      if (isLogsEnabled) Log.e(tag, message)
    }
  }
}`;
}

function bgEventSource() {
  return `
package com.eko
class DownloadEventEmitter {
  private fun safeEmit(eventName: String, params: WritableMap) {
    try {
      getEmitter().emit(eventName, params)
    } catch (e: Exception) {
            RNBackgroundDownloaderModuleImpl.logW(TAG, "Failed to emit $eventName event: \${e.message}")
    }
  }
}`;
}

function bgProgressSource() {
  return `
package com.eko
class ProgressReporter {
  fun reportProgress() {
    val percent = 0.5
  }
}`;
}

function bgIOSSource() {
  return `
${'#define DLog( taskId, s, ... ) do { if (self->isLogsEnabled) { NSLog( @"<%p %@:(%d)> %@ %@", self, [[NSString stringWithUTF8String:__FILE__] lastPathComponent], __LINE__, [NSString stringWithFormat:(s), ##__VA_ARGS__], ((id)(taskId) ? [NSString stringWithFormat:@"taskId:%@", (id)(taskId)] : @"taskId:NULL") ); } } while(0)'}
- (void)sendDebugLog:(NSString *)message taskId:(NSString *)taskId {
    if (!isLogsEnabled) {
        return;
    }
}
`;
}

test('background-downloader mirrors its centralized Android/iOS logging paths and removes legacy synthetic progress patches', () => {
  const root = tempRoot('rnnd-bgdl-');
  write(root, 'android/src/main/java/com/eko/RNBackgroundDownloaderModuleImpl.kt', bgModuleSource());
  write(root, 'android/src/main/java/com/eko/DownloadEventEmitter.kt', bgEventSource());
  write(root, 'android/src/main/java/com/eko/ProgressReporter.kt', `${bgProgressSource()}\n// @rn-native-debugger:start bgdl.android.progress\nRNNDInstrumentation.progress("x", "download", 1, 2)\n// @rn-native-debugger:end bgdl.android.progress\n`);
  write(root, 'ios/RNBackgroundDownloader.mm', bgIOSSource());

  bgdl.patch(root);
  const module = fs.readFileSync(path.join(root, 'android/src/main/java/com/eko/RNBackgroundDownloaderModuleImpl.kt'), 'utf8');
  const events = fs.readFileSync(path.join(root, 'android/src/main/java/com/eko/DownloadEventEmitter.kt'), 'utf8');
  const progress = fs.readFileSync(path.join(root, 'android/src/main/java/com/eko/ProgressReporter.kt'), 'utf8');
  const ios = fs.readFileSync(path.join(root, 'ios/RNBackgroundDownloader.mm'), 'utf8');

  assert.match(module, /RNNDInstrumentation\.log\("debug", tag, message\)/);
  assert.match(module, /RNNDInstrumentation\.log\("warn", tag, message\)/);
  assert.match(module, /RNNDInstrumentation\.log\("error", tag, message\)/);
  assert.match(events, /RNNDInstrumentation\.error/);
  assert.doesNotMatch(progress, /RNNDInstrumentation\.progress/);
  assert.match(ios, /RNNDMirrorBackgroundLog/);
  assert.doesNotMatch(ios, /@"event": @"progress"|@"event": @"completed"/);

  bgdl.unpatch(root);
});

test('patch migrates legacy synthetic markers before applying the native-log/error model', () => {
  const root = tempRoot('rnnd-migrate-');
  const androidPath = 'android/src/main/java/com/rnfs/Downloader.java';
  write(root, androidPath, `${rnfsAndroidSource()}\n// @rn-native-debugger:start rnfs.android.progress\nRNNDInstrumentation.progress("old", "download", 1, 2);\n// @rn-native-debugger:end rnfs.android.progress\n`);
  write(root, 'Downloader.m', rnfsIOSSource());
  write(root, 'android/src/main/java/com/rnfs/Uploader.java', rnfsAndroidUploaderSource());
  write(root, 'Uploader.m', rnfsIOSUploaderSource());

  rnfs.patch(root);
  const result = fs.readFileSync(path.join(root, androidPath), 'utf8');
  assert.doesNotMatch(result, /rnfs\.android\.progress|RNNDInstrumentation\.progress/);
  assert.match(result, /rnfs\.android\.native-log\.progress/);
});

test('integration does not write partial source changes when a later anchor is missing', () => {
  const root = tempRoot('rnnd-transaction-');
  const androidPath = 'android/src/main/java/com/rnfs/Downloader.java';
  const androidOriginal = rnfsAndroidSource();
  write(root, androidPath, androidOriginal);
  write(root, 'android/src/main/java/com/rnfs/Uploader.java', rnfsAndroidUploaderSource());
  write(root, 'Uploader.m', rnfsIOSUploaderSource());
  write(root, 'Downloader.m', 'missing every expected anchor');
  assert.throws(() => rnfs.patch(root), /anchor/);
  assert.equal(fs.readFileSync(path.join(root, androidPath), 'utf8'), androidOriginal);
});

test('integration rolls back source edits when generated helper ownership conflicts', () => {
  const root = tempRoot('rnnd-helper-conflict-');
  const androidPath = 'android/src/main/java/com/rnfs/Downloader.java';
  const iosPath = 'Downloader.m';
  const helperPath = 'android/src/main/java/com/rnfs/RNNDInstrumentation.java';
  const androidOriginal = rnfsAndroidSource();
  const iosOriginal = rnfsIOSSource();
  write(root, androidPath, androidOriginal);
  write(root, iosPath, iosOriginal);
  write(root, 'android/src/main/java/com/rnfs/Uploader.java', rnfsAndroidUploaderSource());
  write(root, 'Uploader.m', rnfsIOSUploaderSource());
  write(root, helperPath, 'package com.rnfs; class UserOwned {}\n');

  assert.throws(() => rnfs.patch(root), /Refusing to overwrite non-generated file/);
  assert.equal(fs.readFileSync(path.join(root, androidPath), 'utf8'), androidOriginal);
  assert.equal(fs.readFileSync(path.join(root, iosPath), 'utf8'), iosOriginal);
  assert.equal(fs.readFileSync(path.join(root, helperPath), 'utf8'), 'package com.rnfs; class UserOwned {}\n');
});
