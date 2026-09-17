#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString * const RNNativeDebuggerInstrumentationNotification;

typedef void (^RNNativeDebuggerEmitter)(NSDictionary *event);

@interface RNNativeDebuggerNativeSink : NSObject
+ (BOOL)isEnabled;
+ (void)setEnabled:(BOOL)enabled;
+ (void)setEmitter:(nullable RNNativeDebuggerEmitter)emitter;
+ (NSArray<NSDictionary *> *)snapshot;
+ (void)clear;
@end

NS_ASSUME_NONNULL_END
