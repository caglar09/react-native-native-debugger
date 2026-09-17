#import "RNNativeDebuggerNativeSink.h"

NSString * const RNNativeDebuggerInstrumentationNotification = @"RNNativeDebuggerInstrumentationEvent";

static const NSUInteger RNNativeDebuggerMaxEvents = 1000;
static const unsigned long long RNNativeDebuggerMaxFileBytes = 2ULL * 1024ULL * 1024ULL;

@implementation RNNativeDebuggerNativeSink

static NSMutableArray<NSDictionary *> *_events;
static RNNativeDebuggerEmitter _emitter;
static dispatch_queue_t _queue;
static BOOL _enabled;
static NSMutableDictionary<NSString *, NSNumber *> *_lastProgressAt;

+ (void)load {
  _queue = dispatch_queue_create("com.rnnativedebugger.sink", DISPATCH_QUEUE_SERIAL);
  _events = [NSMutableArray array];
  _lastProgressAt = [NSMutableDictionary dictionary];
#if DEBUG
  _enabled = YES;
#else
  _enabled = NO;
#endif

  [self restorePersistedEvents];

  [[NSNotificationCenter defaultCenter]
      addObserverForName:RNNativeDebuggerInstrumentationNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification * _Nonnull note) {
    [self consumeNotification:note];
  }];
}

+ (BOOL)isEnabled {
  __block BOOL value = NO;
  dispatch_sync(_queue, ^{ value = _enabled; });
  return value;
}

+ (void)setEnabled:(BOOL)enabled {
  dispatch_async(_queue, ^{
#if DEBUG
    _enabled = enabled;
#else
    _enabled = NO;
#endif
  });
}

+ (void)setEmitter:(RNNativeDebuggerEmitter)emitter {
  dispatch_async(_queue, ^{
    _emitter = [emitter copy];
  });
}

+ (NSArray<NSDictionary *> *)snapshot {
  __block NSArray<NSDictionary *> *snapshot;
  dispatch_sync(_queue, ^{
    snapshot = [_events copy];
  });
  return snapshot ?: @[];
}

+ (void)clear {
  dispatch_async(_queue, ^{
    [_events removeAllObjects];
    NSString *path = [self bufferPath];
    if (path) [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  });
}

+ (void)consumeNotification:(NSNotification *)note {
  NSDictionary *input = note.userInfo ?: @{};

  dispatch_async(_queue, ^{
    if (!_enabled) return;

    NSString *integration = [input[@"integration"] isKindOfClass:[NSString class]] ? input[@"integration"] : @"unknown";
    NSString *category = [input[@"category"] isKindOfClass:[NSString class]] ? input[@"category"] : @"native";
    NSString *eventName = [input[@"event"] isKindOfClass:[NSString class]] ? input[@"event"] : @"event";
    NSString *level = [input[@"level"] isKindOfClass:[NSString class]] ? input[@"level"] : nil;
    NSDictionary *data = [input[@"data"] isKindOfClass:[NSDictionary class]] ? input[@"data"] : @{};

    // Native progress delegates can fire dozens of times per second. Throttle them before
    // persistence/bridge work while always allowing the final current == total event.
    if ([eventName isEqualToString:@"progress"]) {
      NSString *identity = [data[@"taskId"] description] ?: [data[@"url"] description] ?: @"default";
      NSString *progressKey = [NSString stringWithFormat:@"%@|%@|%@", integration, category, identity];
      NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
      NSNumber *previous = _lastProgressAt[progressKey];
      NSNumber *current = [data[@"current"] isKindOfClass:[NSNumber class]] ? data[@"current"] : nil;
      NSNumber *total = [data[@"total"] isKindOfClass:[NSNumber class]] ? data[@"total"] : nil;
      NSNumber *throttleValue = [input[@"progressThrottleMs"] isKindOfClass:[NSNumber class]] ? input[@"progressThrottleMs"] : @500;
      NSTimeInterval throttleSeconds = MAX(0.0, [throttleValue doubleValue] / 1000.0);
      BOOL isFinal = current && total && [current longLongValue] == [total longLongValue];
      if (!isFinal && previous && now - [previous doubleValue] < throttleSeconds) return;
      _lastProgressAt[progressKey] = @(now);
    }

    NSMutableDictionary *event = [@{
      @"id": [[NSUUID UUID] UUIDString],
      @"timestamp": @([[NSDate date] timeIntervalSince1970] * 1000.0),
      @"platform": @"ios",
      @"integration": integration,
      @"category": category,
      @"event": eventName,
      @"data": [self sanitizeDictionary:data depth:0]
    } mutableCopy];
    if (level) event[@"level"] = level;

    [_events addObject:event];
    while (_events.count > RNNativeDebuggerMaxEvents) {
      [_events removeObjectAtIndex:0];
    }

    [self appendEventToDisk:event];

    RNNativeDebuggerEmitter emitter = _emitter;
    if (emitter) {
      NSDictionary *copy = [event copy];
      dispatch_async(dispatch_get_main_queue(), ^{ emitter(copy); });
    }
  });
}

+ (NSDictionary *)sanitizeDictionary:(NSDictionary *)source depth:(NSUInteger)depth {
  if (depth > 8) return @{@"value": @"[MAX_DEPTH]"};
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  [source enumerateKeysAndObjectsUsingBlock:^(id key, id obj, BOOL *stop) {
    result[[key description]] = [self sanitizeValue:obj depth:depth + 1] ?: [NSNull null];
  }];
  return result;
}

+ (id)sanitizeValue:(id)value depth:(NSUInteger)depth {
  if (!value || value == [NSNull null]) return [NSNull null];
  if (depth > 8) return @"[MAX_DEPTH]";
  if ([value isKindOfClass:[NSString class]] ||
      [value isKindOfClass:[NSNumber class]] ||
      [value isKindOfClass:[NSNull class]]) return value;
  if ([value isKindOfClass:[NSDictionary class]]) return [self sanitizeDictionary:value depth:depth + 1];
  if ([value isKindOfClass:[NSArray class]]) {
    NSMutableArray *array = [NSMutableArray array];
    for (id item in (NSArray *)value) [array addObject:[self sanitizeValue:item depth:depth + 1] ?: [NSNull null]];
    return array;
  }
  return [value description];
}

+ (NSString *)bufferPath {
  NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
  NSString *directory = paths.firstObject;
  if (!directory) return nil;
  return [directory stringByAppendingPathComponent:@"rn-native-debugger-events.jsonl"];
}

+ (void)appendEventToDisk:(NSDictionary *)event {
  NSString *path = [self bufferPath];
  if (!path) return;
  NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!json) return;

  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (!handle) {
    [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
    handle = [NSFileHandle fileHandleForWritingAtPath:path];
  }
  @try {
    [handle seekToEndOfFile];
    [handle writeData:json];
    [handle writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    [handle closeFile];
  } @catch (__unused NSException *exception) {
  }

  NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
  if ([attributes[NSFileSize] unsignedLongLongValue] > RNNativeDebuggerMaxFileBytes) [self rewriteDisk];
}

+ (void)rewriteDisk {
  NSString *path = [self bufferPath];
  if (!path) return;
  NSMutableData *content = [NSMutableData data];
  for (NSDictionary *event in _events) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (!json) continue;
    [content appendData:json];
    [content appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  }
  [content writeToFile:path atomically:YES];
}

+ (void)restorePersistedEvents {
  NSString *path = [self bufferPath];
  NSData *data = path ? [NSData dataWithContentsOfFile:path] : nil;
  if (!data.length) return;
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  for (NSString *line in [text componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]]) {
    if (!line.length) continue;
    NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
    if ([event isKindOfClass:[NSDictionary class]]) [_events addObject:event];
  }
  while (_events.count > RNNativeDebuggerMaxEvents) [_events removeObjectAtIndex:0];
  [self rewriteDisk];
}

@end
