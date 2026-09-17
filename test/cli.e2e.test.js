'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cli = path.resolve(__dirname, '../cli/index.js');

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('CLI discovers, patches, reports, and unpatches an optional package', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-cli-'));
  const pkg = path.join(project, 'node_modules/react-native-fs');

  write(pkg, 'package.json', JSON.stringify({ name: 'react-native-fs', version: '2.20.0' }));
  write(pkg, 'android/src/main/java/com/rnfs/Downloader.java', `
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
  write(pkg, 'Downloader.m', `
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

  const doctorBefore = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--root', project, '--json'], { encoding: 'utf8' }));
  const rnfsBefore = doctorBefore.find((row) => row.key === 'rnfs');
  assert.equal(rnfsBefore.installed, true);
  assert.equal(rnfsBefore.versionAllowed, true);

  const patchResult = JSON.parse(execFileSync(process.execPath, [cli, 'patch', '--root', project, '--json', '--strict'], { encoding: 'utf8' }));
  assert.equal(patchResult.find((row) => row.package === 'react-native-fs').state, 'patched');
  assert.match(fs.readFileSync(path.join(pkg, 'Downloader.m'), 'utf8'), /@rn-native-debugger:start/);
  assert.match(fs.readFileSync(path.join(pkg, 'android/src/main/java/com/rnfs/RNNDInstrumentation.java'), 'utf8'), /@rn-native-debugger:generated/);

  const doctorAfter = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--root', project, '--json'], { encoding: 'utf8' }));
  assert.ok(doctorAfter.find((row) => row.key === 'rnfs').status.ios.markers > 0);

  execFileSync(process.execPath, [cli, 'unpatch', '--root', project, '--strict'], { encoding: 'utf8' });
  assert.doesNotMatch(fs.readFileSync(path.join(pkg, 'Downloader.m'), 'utf8'), /@rn-native-debugger:start/);
  assert.equal(fs.existsSync(path.join(pkg, 'android/src/main/java/com/rnfs/RNNDInstrumentation.java')), false);
});
