import type { Language } from "../core/language";

/**
 * The apps whose use of the microphone is a call IncarnaMind offers to take notes in (#208): the
 * meeting and call apps, and the browsers, where Google Meet and other web calls run. Any other
 * app using the microphone (a dictation app, IncarnaMind itself) is no call.
 */
export type CallKind = "meeting" | "call" | "huddle";

export interface MeetingApp {
  id: string;
  name: string;
  /** Its name in Chinese, where it has its own. */
  zh?: string;
  kind: CallKind;
  /** Bundle identifiers, lower case; a helper's ("com.google.Chrome.helper") is its app's. */
  mac: readonly string[];
  /**
   * Executable names, lower case, or a packaged app's family name up to its "_", as Windows records
   * microphone use: for the Windows watcher to come (#2843), and Settings' list of apps there.
   */
  windows: readonly string[];
  /** What PulseAudio names the recording stream's program, lower case: its binary or its name. */
  linux: readonly string[];
}

export const MEETING_APPS: readonly MeetingApp[] = [
  {
    id: "zoom",
    name: "Zoom",
    kind: "meeting",
    mac: ["us.zoom.xos"],
    windows: ["zoom.exe"],
    linux: ["zoom", "zoom.real"],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    kind: "meeting",
    mac: ["com.microsoft.teams2", "com.microsoft.teams"],
    windows: ["ms-teams.exe", "teams.exe", "msteams_"],
    linux: ["teams-for-linux", "teams"],
  },
  {
    id: "slack",
    name: "Slack",
    kind: "huddle",
    mac: ["com.tinyspeck.slackmacgap"],
    windows: ["slack.exe", "91750d7e.slack_"],
    linux: ["slack"],
  },
  {
    id: "webex",
    name: "Webex",
    kind: "meeting",
    mac: ["cisco-systems.spark", "com.webex.meetingmanager", "com.cisco.webexmeetingsapp"],
    windows: ["ciscocollabhost.exe", "webexmta.exe", "atmgr.exe"],
    linux: ["webex"],
  },
  {
    id: "feishu",
    name: "Feishu",
    zh: "飞书",
    kind: "meeting",
    mac: ["com.bytedance.lark", "com.electron.lark"],
    windows: ["feishu.exe", "lark.exe"],
    linux: ["feishu", "bytedance-feishu", "lark"],
  },
  {
    id: "tencent-meeting",
    name: "Tencent Meeting",
    zh: "腾讯会议",
    kind: "meeting",
    mac: ["com.tencent.meeting"],
    windows: ["wemeetapp.exe"],
    linux: ["wemeetapp"],
  },
  {
    id: "dingtalk",
    name: "DingTalk",
    zh: "钉钉",
    kind: "meeting",
    mac: ["com.alibaba.dingtalkmac"],
    windows: ["dingtalk.exe"],
    linux: ["dingtalk"],
  },
  {
    id: "facetime",
    name: "FaceTime",
    kind: "call",
    mac: ["com.apple.facetime", "com.apple.avconferenced"],
    windows: [],
    linux: [],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    kind: "call",
    mac: ["net.whatsapp.whatsapp", "desktop.whatsapp"],
    windows: ["whatsapp.exe", "whatsapp.root.exe", "5319275a.whatsappdesktop_"],
    linux: [],
  },
  {
    id: "wechat",
    name: "WeChat",
    zh: "微信",
    kind: "call",
    mac: ["com.tencent.xinwechat"],
    windows: ["wechat.exe", "weixin.exe"],
    linux: ["wechat"],
  },
  {
    id: "chrome",
    name: "Google Chrome",
    kind: "meeting",
    mac: ["com.google.chrome"],
    windows: ["chrome.exe"],
    linux: ["chrome", "google-chrome", "google chrome"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    kind: "meeting",
    mac: ["com.microsoft.edgemac"],
    windows: ["msedge.exe"],
    linux: ["msedge", "microsoft-edge", "microsoft edge"],
  },
  {
    // Safari's pages use the microphone through WebKit's GPU process.
    id: "safari",
    name: "Safari",
    kind: "meeting",
    mac: ["com.apple.safari", "com.apple.webkit.gpu"],
    windows: [],
    linux: [],
  },
  {
    id: "firefox",
    name: "Firefox",
    kind: "meeting",
    mac: ["org.mozilla.firefox"],
    windows: ["firefox.exe"],
    linux: ["firefox", "firefox-bin"],
  },
  {
    id: "arc",
    name: "Arc",
    kind: "meeting",
    mac: ["company.thebrowser.browser"],
    windows: ["thebrowsercompany.arc_"],
    linux: [],
  },
  {
    id: "brave",
    name: "Brave",
    kind: "meeting",
    mac: ["com.brave.browser"],
    windows: ["brave.exe"],
    linux: ["brave", "brave-browser"],
  },
  {
    id: "chromium",
    name: "Chromium",
    kind: "meeting",
    mac: ["org.chromium.chromium"],
    windows: [],
    linux: ["chromium", "chromium-browser"],
  },
];

const BY_ID = new Map(MEETING_APPS.map((app) => [app.id, app]));

export const isMeetingAppId = (value: unknown): value is string =>
  typeof value === "string" && BY_ID.has(value);

export const meetingApp = (id: string): MeetingApp | undefined => BY_ID.get(id);

/** The app's name as the interface shows it. */
export function meetingAppName(id: string, language: Language): string {
  const app = BY_ID.get(id);
  if (!app) return id;
  return language === "zh-CN" ? (app.zh ?? app.name) : app.name;
}

/** The app a macOS bundle identifier belongs to: its own, or one of its helpers'. */
export function appOfBundle(bundle: string): string | null {
  const id = bundle.toLowerCase();
  const found = MEETING_APPS.find((app) =>
    app.mac.some((each) => id === each || id.startsWith(`${each}.`)),
  );
  return found?.id ?? null;
}

/** The app a recording stream on Linux belongs to, by its program's binary, else its name. */
export function appOfLinuxStream(binary: string | null, name: string | null): string | null {
  for (const given of [binary, name]) {
    if (!given) continue;
    const lower = given.toLowerCase();
    const found = MEETING_APPS.find((app) => app.linux.includes(lower));
    if (found) return found.id;
  }
  return null;
}
