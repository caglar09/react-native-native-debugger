'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rnfs = require('../cli/integrations/rnfs');
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

  // Second application is idempotent.
  definition.patch(root, { progressThrottleMs: 321 });
  definition.unpatch(root);
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(content, /@rn-native-debugger:start/);
  }
}

test('RNFS integration patches current source anchors transactionally', () => {
  const root = tempRoot('rnnd-rnfs-');
  write(root, 'android/src/main/java/com/rnfs/Downloader.java', `
package com.rnfs;
class Downloader {
 void x() {
      connection = (HttpURLConnection)param.src.openConnection();
      int statusCode = connection.getResponseCode();
      long lengthOfFile = getContentLength(connection);
          total += count;
        res.bytesWritten = total;
        } catch (Exception ex) {
  }
}`);
  write(root, 'Downloader.m', `
- (void)x {
  NSURL* url = [NSURL URLWithString:_params.fromUrl];
}
- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask didWriteData:(int64_t)bytesWritten totalBytesWritten:(int64_t)totalBytesWritten totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite
{
  NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)downloadTask.response;
}
- (void)y {
  return _params.completeCallback(_statusCode, _bytesWritten);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if (error) {
  }
}`);

  assertPatchedThenUnpatched(rnfs, root, [
    'android/src/main/java/com/rnfs/Downloader.java',
    'Downloader.m'
  ]);
});

test('BlobUtil integration patches OkHttp, DownloadManager and NSURLSession anchors', () => {
  const root = tempRoot('rnnd-blob-');
  write(root, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java', `
class ReactNativeBlobUtilReq {
    public void run() {
        Context appCtx = ReactNativeBlobUtilImpl.RCTContext.getApplicationContext();
                downloadManagerId = dm.enqueue(req);
                            long total = cursor.getLong(cursor.getColumnIndex(
                                    DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                            cursor.close();
            Call call = client.newCall(req);
                public void onFailure(@NonNull Call call, @NonNull IOException e) {
                public void onResponse(@NonNull Call call, @NonNull Response response) throws IOException {
        } catch (Exception error) {
            error.printStackTrace();
    }
}`);
  write(root, 'ios/ReactNativeBlobUtilRequest.mm', `
- (void)sendRequest {
    self.options = options;
}
- (void)response {
    respStatus = statusCode;
}
- (void)data {
    receivedBytes += [received longValue];
}
- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask didWriteData:(int64_t)bytesWritten totalBytesWritten:(int64_t)totalBytesWritten totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {
}
- (void) URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didSendBodyData:(int64_t)bytesSent totalBytesSent:(int64_t)totalBytesWritten totalBytesExpectedToSend:(int64_t)totalBytesExpectedToWrite
{
}
- (void)complete {
    self.error = error;
}
`);

  assertPatchedThenUnpatched(blob, root, [
    'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java',
    'ios/ReactNativeBlobUtilRequest.mm'
  ]);
});

test('background-downloader integration patches centralized lifecycle paths', () => {
  const root = tempRoot('rnnd-bgdl-');
  write(root, 'android/src/main/java/com/eko/DownloadEventEmitter.kt', `
class DownloadEventEmitter {
 fun a() {
        safeEmit(EVENT_DOWNLOAD_BEGIN, params)
 }
 fun b() {
        safeEmit(EVENT_DOWNLOAD_COMPLETE, params)
 }
 fun c() {
        safeEmit(EVENT_DOWNLOAD_FAILED, params)
 }
}`);
  write(root, 'android/src/main/java/com/eko/ProgressReporter.kt', `
class ProgressReporter {
 fun x() {
        val percent = if (effectiveTotal > 0) bytesDownloaded.toDouble() / effectiveTotal else 0.0
 }
}`);
  write(root, 'ios/RNBackgroundDownloader.mm', `
- (void)a {
        DLog(identifier, @"[RNBackgroundDownloader] - [executeDownloadWithRequest]");
}
- (void)b {
        DLog(taskConfig.id, @"[RNBackgroundDownloader] - [didWriteData]");
}
- (void)sendDownloadCompletionEvent:(RNBGDTaskConfig *)taskConfig task:(NSURLSessionDownloadTask *)task error:(NSError *)error {
}
- (void)c {
        // Handle failure
}
`);

  assertPatchedThenUnpatched(bgdl, root, [
    'android/src/main/java/com/eko/DownloadEventEmitter.kt',
    'android/src/main/java/com/eko/ProgressReporter.kt',
    'ios/RNBackgroundDownloader.mm'
  ]);
});

test('integration does not write partial source changes when a later anchor is missing', () => {
  const root = tempRoot('rnnd-transaction-');
  const androidPath = 'android/src/main/java/com/rnfs/Downloader.java';
  const iosPath = 'Downloader.m';
  const androidOriginal = `
      connection = (HttpURLConnection)param.src.openConnection();
      long lengthOfFile = getContentLength(connection);
          total += count;
        res.bytesWritten = total;
        } catch (Exception ex) {
`;
  write(root, androidPath, androidOriginal);
  write(root, iosPath, 'missing every expected anchor');
  assert.throws(() => rnfs.patch(root), /anchor/);
  assert.equal(fs.readFileSync(path.join(root, androidPath), 'utf8'), androidOriginal);
});


test('integration rolls back source edits when generated helper ownership conflicts', () => {
  const root = tempRoot('rnnd-helper-conflict-');
  const androidPath = 'android/src/main/java/com/rnfs/Downloader.java';
  const iosPath = 'Downloader.m';
  const helperPath = 'android/src/main/java/com/rnfs/RNNDInstrumentation.java';
  const androidOriginal = `
package com.rnfs;
class Downloader {
 void x() {
      connection = (HttpURLConnection)param.src.openConnection();
      int statusCode = connection.getResponseCode();
      long lengthOfFile = getContentLength(connection);
          total += count;
        res.bytesWritten = total;
        } catch (Exception ex) {
  }
}`;
  const iosOriginal = `
- (void)x {
  NSURL* url = [NSURL URLWithString:_params.fromUrl];
}
- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask didWriteData:(int64_t)bytesWritten totalBytesWritten:(int64_t)totalBytesWritten totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite
{
  NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)downloadTask.response;
}
- (void)y {
  return _params.completeCallback(_statusCode, _bytesWritten);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error
{
  if (error) {
  }
}`;
  write(root, androidPath, androidOriginal);
  write(root, iosPath, iosOriginal);
  write(root, helperPath, 'package com.rnfs; class UserOwned {}\n');

  assert.throws(() => rnfs.patch(root), /Refusing to overwrite non-generated file/);
  assert.equal(fs.readFileSync(path.join(root, androidPath), 'utf8'), androidOriginal);
  assert.equal(fs.readFileSync(path.join(root, iosPath), 'utf8'), iosOriginal);
  assert.equal(fs.readFileSync(path.join(root, helperPath), 'utf8'), 'package com.rnfs; class UserOwned {}\n');
});
