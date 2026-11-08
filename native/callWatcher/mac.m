// IncarnaMind's call watcher on macOS (#208): which processes are using a microphone, one JSON
// line each time that changes, as {"exact":true,"apps":[{"pid":123,"bundle":"us.zoom.xos"}]}.
// It reads only that, from Core Audio, which asks no permission for it. It waits on Core Audio's
// own notices and never polls, and it exits when its parent closes its stdin.
//
// macOS 14 and later say which process runs input. Before that only "the default input device is
// running somewhere" is known, so the line names the app in front instead, with "exact":false.
//
// Built by the packager into the app (scripts/afterPack.mjs), and by `npm run call-watcher` for development.

#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

static NSString *lastLine = nil;
static NSMutableSet<NSNumber *> *watchedProcesses = nil;
static AudioObjectID watchedDevice = kAudioObjectUnknown;

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress found = {selector, kAudioObjectPropertyScopeGlobal,
                                      kAudioObjectPropertyElementMain};
  return found;
}

static void report(void);

static void watch(AudioObjectID object, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress where = {selector, kAudioObjectPropertyScopeWildcard,
                                      kAudioObjectPropertyElementWildcard};
  AudioObjectAddPropertyListenerBlock(object, &where, dispatch_get_main_queue(),
                                      ^(UInt32 count __unused, const AudioObjectPropertyAddress *changed __unused) {
                                        report();
                                      });
}

static NSString *quoted(NSString *text) {
  NSString *escaped = [[text stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
      stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
  return [NSString stringWithFormat:@"\"%@\"", escaped];
}

static NSString *entry(pid_t pid, NSString *bundle) {
  return [NSString stringWithFormat:@"{\"pid\":%d,\"bundle\":%@}", pid, quoted(bundle ?: @"")];
}

static NSArray<NSString *> *exactUsers(void) API_AVAILABLE(macos(14.0)) {
  AudioObjectPropertyAddress listAddress = address(kAudioHardwarePropertyProcessObjectList);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &listAddress, 0, NULL, &size) != noErr)
    return @[];
  UInt32 count = size / sizeof(AudioObjectID);
  AudioObjectID *processes = calloc(count > 0 ? count : 1, sizeof(AudioObjectID));
  NSMutableArray<NSString *> *users = [NSMutableArray array];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &listAddress, 0, NULL, &size,
                                 processes) == noErr) {
    count = size / sizeof(AudioObjectID);
    for (UInt32 at = 0; at < count; at++) {
      AudioObjectID process = processes[at];
      NSNumber *key = @(process);
      if (![watchedProcesses containsObject:key]) {
        [watchedProcesses addObject:key];
        // Core Audio says when a process's devices change, as it starts or stops input, but not
        // always when its IsRunningInput does.
        watch(process, kAudioProcessPropertyDevices);
        watch(process, kAudioProcessPropertyIsRunningInput);
      }
      UInt32 running = 0;
      UInt32 runningSize = sizeof(running);
      AudioObjectPropertyAddress runningAddress = address(kAudioProcessPropertyIsRunningInput);
      if (AudioObjectGetPropertyData(process, &runningAddress, 0, NULL, &runningSize, &running) !=
              noErr ||
          running == 0)
        continue;
      pid_t pid = 0;
      UInt32 pidSize = sizeof(pid);
      AudioObjectPropertyAddress pidAddress = address(kAudioProcessPropertyPID);
      AudioObjectGetPropertyData(process, &pidAddress, 0, NULL, &pidSize, &pid);
      CFStringRef bundle = NULL;
      UInt32 bundleSize = sizeof(bundle);
      AudioObjectPropertyAddress bundleAddress = address(kAudioProcessPropertyBundleID);
      AudioObjectGetPropertyData(process, &bundleAddress, 0, NULL, &bundleSize, &bundle);
      [users addObject:entry(pid, bundle ? (__bridge NSString *)bundle : nil)];
      if (bundle) CFRelease(bundle);
    }
  }
  free(processes);
  return users;
}

static NSArray<NSString *> *frontUserIfRunning(void) {
  AudioObjectPropertyAddress defaultAddress = address(kAudioHardwarePropertyDefaultInputDevice);
  AudioObjectID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &defaultAddress, 0, NULL, &size,
                                 &device) != noErr ||
      device == kAudioObjectUnknown)
    return @[];
  if (device != watchedDevice) {
    watchedDevice = device;
    watch(device, kAudioDevicePropertyDeviceIsRunningSomewhere);
  }
  UInt32 running = 0;
  size = sizeof(running);
  AudioObjectPropertyAddress runningAddress = address(kAudioDevicePropertyDeviceIsRunningSomewhere);
  if (AudioObjectGetPropertyData(device, &runningAddress, 0, NULL, &size, &running) != noErr ||
      running == 0)
    return @[];
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front) return @[];
  return @[ entry(front.processIdentifier, front.bundleIdentifier) ];
}

static void report(void) {
  BOOL exact = NO;
  NSArray<NSString *> *users;
  if (@available(macOS 14.0, *)) {
    exact = YES;
    users = exactUsers();
  } else {
    users = frontUserIfRunning();
  }
  NSString *line = [NSString stringWithFormat:@"{\"exact\":%@,\"apps\":[%@]}",
                                              exact ? @"true" : @"false",
                                              [users componentsJoinedByString:@","]];
  if ([line isEqualToString:lastLine]) return;
  lastLine = line;
  printf("%s\n", line.UTF8String);
  fflush(stdout);
}

int main(void) {
  @autoreleasepool {
    watchedProcesses = [NSMutableSet set];
    if (@available(macOS 14.0, *)) {
      watch(kAudioObjectSystemObject, kAudioHardwarePropertyProcessObjectList);
    } else {
      watch(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice);
      [NSWorkspace.sharedWorkspace.notificationCenter
          addObserverForName:NSWorkspaceDidActivateApplicationNotification
                      object:nil
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification *notice __unused) {
                    report();
                  }];
    }
    dispatch_source_t input =
        dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(input, ^{
      char buffer[256];
      if (read(STDIN_FILENO, buffer, sizeof(buffer)) <= 0) exit(0);
    });
    dispatch_resume(input);
    report();
    CFRunLoopRun();
  }
  return 0;
}
