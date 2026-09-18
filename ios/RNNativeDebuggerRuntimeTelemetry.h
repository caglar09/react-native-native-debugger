#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNNativeDebuggerRuntimeTelemetry : NSObject

+ (void)startWithIntervalMs:(double)intervalMs;
+ (void)stop;
+ (BOOL)isRunning;
+ (NSDictionary *)snapshot;

@end

NS_ASSUME_NONNULL_END
