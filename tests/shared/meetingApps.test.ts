import { describe, expect, test } from "vitest";
import {
  appOfBundle,
  appOfLinuxStream,
  MEETING_APPS,
  meetingAppName,
} from "../../src/shared/meetingApps";

describe("Call apps", () => {
  test("a bundle and its helpers are the app's; a longer name that only starts the same isn't", () => {
    expect(appOfBundle("us.zoom.xos")).toBe("zoom");
    expect(appOfBundle("com.microsoft.teams2.helper")).toBe("teams");
    expect(appOfBundle("com.google.chromecast")).toBeNull();
    expect(appOfBundle("com.apple.VoiceMemos")).toBeNull();
  });

  test("Linux names a stream's program by its binary, else its name", () => {
    expect(appOfLinuxStream("zoom", "ZOOM VoiceEngine")).toBe("zoom");
    expect(appOfLinuxStream(null, "Firefox")).toBe("firefox");
    expect(appOfLinuxStream("arecord", "ALSA plug-in")).toBeNull();
  });

  test("each has a name in both languages, and Chinese apps their Chinese names", () => {
    expect(meetingAppName("tencent-meeting", "zh-CN")).toBe("腾讯会议");
    expect(meetingAppName("tencent-meeting", "en")).toBe("Tencent Meeting");
    expect(meetingAppName("zoom", "zh-CN")).toBe("Zoom");
    expect(new Set(MEETING_APPS.map((app) => app.id)).size).toBe(MEETING_APPS.length);
  });
});
