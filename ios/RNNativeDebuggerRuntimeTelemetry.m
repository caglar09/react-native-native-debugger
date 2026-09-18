#import "RNNativeDebuggerRuntimeTelemetry.h"

#import <QuartzCore/CADisplayLink.h>
#import <UIKit/UIKit.h>
#import <mach/mach.h>
#import <math.h>

static NSString * const RNNDMarker = @"RNND_TELEMETRY ";

@implementation RNNativeDebuggerRuntimeTelemetry

static dispatch_queue_t _telemetryQueue;
static dispatch_source_t _telemetryTimer;
static CADisplayLink *_displayLink;
static BOOL _running = NO;
static double _intervalMs = 1000.0;
static NSUInteger _frameCount = 0;
static CFTimeInterval _frameWindowStart = 0;
static double _lastFps = 0;

+ (void)initialize {
  if (self != [RNNativeDebuggerRuntimeTelemetry class]) return;
  _telemetryQueue = dispatch_queue_create("com.rnnativedebugger.runtime-telemetry", DISPATCH_QUEUE_SERIAL);
}

+ (BOOL)isRunning {
  @synchronized(self) {
    return _running;
  }
}

+ (void)startWithIntervalMs:(double)intervalMs {
#if DEBUG
  double clamped = MAX(250.0, MIN(5000.0, intervalMs > 0 ? intervalMs : 1000.0));
  @synchronized(self) {
    if (_running && fabs(_intervalMs - clamped) < 0.1) return;
  }
  [self stop];

  @synchronized(self) {
    _running = YES;
    _intervalMs = clamped;
    _frameCount = 0;
    _frameWindowStart = 0;
    _lastFps = 0;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    [UIDevice currentDevice].batteryMonitoringEnabled = YES;
    if (![self isRunning]) return;
    _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(frameTick:)];
    [_displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
  });

  dispatch_async(_telemetryQueue, ^{
    if (![self isRunning]) return;
    _telemetryTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _telemetryQueue);
    uint64_t interval = (uint64_t)(_intervalMs * NSEC_PER_MSEC);
    dispatch_source_set_timer(_telemetryTimer, dispatch_time(DISPATCH_TIME_NOW, 0), interval, 50 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(_telemetryTimer, ^{
      if (![self isRunning]) return;
      @autoreleasepool {
        NSDictionary *metrics = [self snapshot];
        NSData *json = [NSJSONSerialization dataWithJSONObject:metrics options:0 error:nil];
        if (!json) return;
        NSString *payload = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        if (payload.length) NSLog(@"%@%@", RNNDMarker, payload);
      }
    });
    dispatch_resume(_telemetryTimer);
  });
#endif
}

+ (void)stop {
  @synchronized(self) {
    _running = NO;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    [_displayLink invalidate];
    _displayLink = nil;
  });

  dispatch_sync(_telemetryQueue, ^{
    if (_telemetryTimer) {
      dispatch_source_cancel(_telemetryTimer);
      _telemetryTimer = nil;
    }
  });

  @synchronized(self) {
    _frameCount = 0;
    _frameWindowStart = 0;
    _lastFps = 0;
  }
}

+ (void)frameTick:(CADisplayLink *)link {
  @synchronized(self) {
    if (!_running) return;
    if (_frameWindowStart <= 0) _frameWindowStart = link.timestamp;
    _frameCount += 1;
    CFTimeInterval elapsed = link.timestamp - _frameWindowStart;
    if (elapsed >= 1.0) {
      _lastFps = _frameCount / elapsed;
      _frameCount = 0;
      _frameWindowStart = link.timestamp;
    }
  }
}

+ (NSDictionary *)snapshot {
#if !DEBUG
  return @{@"available": @NO, @"reason": @"debug-runtime-unavailable"};
#else
  NSMutableDictionary *metrics = [NSMutableDictionary dictionary];
  metrics[@"available"] = @YES;
  metrics[@"source"] = @"ios-native";
  metrics[@"platform"] = @"ios";
  metrics[@"timestamp"] = @([[NSDate date] timeIntervalSince1970] * 1000.0);
  metrics[@"process"] = [NSProcessInfo processInfo].processName ?: @"";
  metrics[@"pid"] = @([[NSProcessInfo processInfo] processIdentifier]);
  metrics[@"physicalMemoryBytes"] = @([NSProcessInfo processInfo].physicalMemory);
  metrics[@"activeProcessors"] = @([NSProcessInfo processInfo].activeProcessorCount);
  metrics[@"lowPowerMode"] = @([NSProcessInfo processInfo].lowPowerModeEnabled);
  metrics[@"thermalState"] = [self thermalStateName:[NSProcessInfo processInfo].thermalState];

  uint64_t footprint = [self physicalFootprint];
  if (footprint > 0) {
    metrics[@"residentMemoryBytes"] = @(footprint);
    metrics[@"memoryKind"] = @"phys_footprint";
  }

  NSUInteger threads = 0;
  double cpu = [self processCpuPercentWithThreadCount:&threads];
  metrics[@"cpuPercent"] = @(cpu);
  metrics[@"threads"] = @(threads);

  @synchronized(self) {
    if (_lastFps > 0) metrics[@"fps"] = @(_lastFps);
  }

  __block float battery = -1.0f;
  if ([NSThread isMainThread]) {
    battery = [UIDevice currentDevice].batteryLevel;
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      battery = [UIDevice currentDevice].batteryLevel;
    });
  }
  if (battery >= 0) metrics[@"batteryPercent"] = @(battery * 100.0);

  return metrics;
#endif
}

+ (uint64_t)physicalFootprint {
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  kern_return_t result = task_info(mach_task_self(),
                                   TASK_VM_INFO,
                                   (task_info_t)&info,
                                   &count);
  return result == KERN_SUCCESS ? info.phys_footprint : 0;
}

+ (double)processCpuPercentWithThreadCount:(NSUInteger *)threadCount {
  thread_act_array_t threads = NULL;
  mach_msg_type_number_t count = 0;
  kern_return_t result = task_threads(mach_task_self(), &threads, &count);
  if (result != KERN_SUCCESS) {
    if (threadCount) *threadCount = 0;
    return 0;
  }

  double usage = 0;
  for (mach_msg_type_number_t index = 0; index < count; index++) {
    thread_basic_info_data_t info;
    mach_msg_type_number_t infoCount = THREAD_BASIC_INFO_COUNT;
    if (thread_info(threads[index],
                    THREAD_BASIC_INFO,
                    (thread_info_t)&info,
                    &infoCount) != KERN_SUCCESS) continue;
    if ((info.flags & TH_FLAGS_IDLE) == 0) {
      usage += (double)info.cpu_usage / (double)TH_USAGE_SCALE;
    }
  }

  vm_deallocate(mach_task_self(),
                (vm_address_t)threads,
                sizeof(thread_t) * count);

  if (threadCount) *threadCount = count;
  NSUInteger processors = MAX((NSUInteger)1, [NSProcessInfo processInfo].activeProcessorCount);
  return MAX(0.0, MIN(100.0, (usage * 100.0) / processors));
}

+ (NSString *)thermalStateName:(NSProcessInfoThermalState)state {
  switch (state) {
    case NSProcessInfoThermalStateNominal: return @"nominal";
    case NSProcessInfoThermalStateFair: return @"fair";
    case NSProcessInfoThermalStateSerious: return @"serious";
    case NSProcessInfoThermalStateCritical: return @"critical";
    default: return @"unknown";
  }
}

@end
