'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const blob = require('../cli/integrations/blob-util');

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('BlobUtil 0.22.2 disambiguates interceptor catch from DownloadManager catch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnnd-blob-anchor-'));

  write(root, 'package.json', JSON.stringify({
    name: 'react-native-blob-util',
    version: '0.22.2'
  }));

  write(root, 'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java', `
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

                    } catch (Exception ex) {
                        ex.printStackTrace();
                        this.invoke_callback(ex.getLocalizedMessage(), null);
                    }
  }
}`);

  write(root, 'ios/ReactNativeBlobUtilRequest.mm', `
- (void)x {
        @catch(NSException * ex)
        {
            NSLog(@"write file error");
        }
        NSLog(@"oops");
    self.error = error;
                    errMsg = [NSString stringWithFormat:@"Exception on File Transformer: '%@' ", [ex description]];
    NSLog(@"sess done in background");
}`);

  assert.doesNotThrow(() => blob.patch(root));

  const androidPath = path.join(
    root,
    'android/src/main/java/com/ReactNativeBlobUtil/ReactNativeBlobUtilReq.java'
  );
  const android = fs.readFileSync(androidPath, 'utf8');

  assert.equal(
    (android.match(/blob\.android\.native-error\.interceptor/g) || []).length,
    2,
    'one start and one end marker should be generated for the interceptor anchor'
  );

  const interceptorIndex = android.indexOf('Unexpected interceptor error');
  const downloadManagerIndex = android.indexOf('this.invoke_callback(ex.getLocalizedMessage(), null);');
  assert.ok(interceptorIndex >= 0);
  assert.ok(downloadManagerIndex >= 0);
  assert.ok(interceptorIndex < downloadManagerIndex);

  blob.unpatch(root);
});
