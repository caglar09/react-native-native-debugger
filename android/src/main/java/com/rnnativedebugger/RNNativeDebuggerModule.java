package com.rnnativedebugger;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class RNNativeDebuggerModule extends ReactContextBaseJavaModule {
  public static final String NAME = "RNNativeDebugger";
  private final ReactApplicationContext context;

  RNNativeDebuggerModule(ReactApplicationContext reactContext) {
    super(reactContext);
    context = reactContext;
    NativeDebugSink.attach(reactContext);
  }

  @Override
  public String getName() {
    return NAME;
  }

  @ReactMethod
  public void getBufferedEvents(Promise promise) {
    promise.resolve(NativeDebugSink.snapshotAsWritableArray());
  }

  @ReactMethod
  public void clearBufferedEvents(Promise promise) {
    NativeDebugSink.clear();
    promise.resolve(null);
  }

  @ReactMethod
  public void setEnabled(boolean enabled) {
    NativeDebugSink.setEnabled(enabled);
  }

  @ReactMethod
  public void addListener(String eventName) {
    NativeDebugSink.addListener();
  }

  @ReactMethod
  public void removeListeners(double count) {
    NativeDebugSink.removeListeners((int) count);
  }

  @Override
  public void invalidate() {
    NativeDebugSink.detach(context);
    super.invalidate();
  }
}
