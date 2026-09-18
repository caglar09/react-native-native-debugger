#import "RNNativeDebugger.h"
#import "RNNativeDebuggerNativeSink.h"
#import "RNNativeDebuggerRuntimeTelemetry.h"

@implementation RNNativeDebugger

RCT_EXPORT_MODULE(RNNativeDebugger)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    [RNNativeDebuggerRuntimeTelemetry startWithIntervalMs:1000.0];
  }
  return self;
}

- (void)dealloc {
  [RNNativeDebuggerRuntimeTelemetry stop];
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"RNNativeDebuggerEvent"];
}

- (void)startObserving {
  __weak typeof(self) weakSelf = self;
  [RNNativeDebuggerNativeSink setEmitter:^(NSDictionary *event) {
    __strong typeof(weakSelf) strongSelf = weakSelf;
    if (!strongSelf) return;
    [strongSelf sendEventWithName:@"RNNativeDebuggerEvent" body:event];
  }];
}

- (void)stopObserving {
  [RNNativeDebuggerNativeSink setEmitter:nil];
}

RCT_REMAP_METHOD(getBufferedEvents,
                 getBufferedEventsWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([RNNativeDebuggerNativeSink snapshot]);
}

RCT_REMAP_METHOD(clearBufferedEvents,
                 clearBufferedEventsWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [RNNativeDebuggerNativeSink clear];
  resolve(nil);
}

RCT_EXPORT_METHOD(setEnabled:(BOOL)enabled) {
  [RNNativeDebuggerNativeSink setEnabled:enabled];
}

RCT_EXPORT_METHOD(startRuntimeTelemetry:(double)intervalMs) {
  [RNNativeDebuggerRuntimeTelemetry startWithIntervalMs:intervalMs];
}

RCT_EXPORT_METHOD(stopRuntimeTelemetry) {
  [RNNativeDebuggerRuntimeTelemetry stop];
}

RCT_REMAP_METHOD(getRuntimeMetrics,
                 getRuntimeMetricsWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([RNNativeDebuggerRuntimeTelemetry snapshot]);
}

@end
