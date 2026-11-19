import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { section } from "../helpers/electronBuilder";

const REPO_ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFile(join(REPO_ROOT, path), "utf8");

describe("The macOS build may record a meeting (ADR-0015)", () => {
  test("it says why it asks for the microphone and the computer's sound, in English and Chinese", async () => {
    const mac = section(await read("electron-builder.yml"), "mac");
    const chinese = await read("build/zh_CN.lproj/InfoPlist.strings");
    for (const [key, englishSource, chineseSource] of [
      ["NSMicrophoneUsageDescription", "your microphone", "麦克风"],
      ["NSAudioCaptureUsageDescription", "sound playing on this Mac", "电脑播放的声音"],
    ]) {
      const english = mac.split("\n").find((line) => line.startsWith(`    ${key}:`));
      const translated = chinese.split("\n").find((line) => line.startsWith(`"${key}" =`));
      expect(english).toContain(englishSource);
      expect(english).toContain(
        "With cloud transcription, the service you choose receives this audio.",
      );
      expect(translated).toContain(chineseSource);
      expect(translated).toContain("使用云端转写时，音频会发送给你选用的服务。");
    }
    expect(mac).toMatch(/^ {4}- from: build\/zh_CN\.lproj\n {6}to: zh_CN\.lproj$/m);
  });

  test("a hardened-runtime build may open the microphone and the calendars, and keeps electron-builder's entitlements", async () => {
    const mac = section(await read("electron-builder.yml"), "mac");
    expect(mac).toMatch(/^ {2}entitlements: build\/entitlements\.mac\.plist$/m);
    expect(mac).toMatch(/^ {2}entitlementsInherit: build\/entitlements\.mac\.plist$/m);

    const entitlements = await read("build/entitlements.mac.plist");
    for (const key of [
      "com.apple.security.device.audio-input",
      "com.apple.security.personal-information.calendars",
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(entitlements).toMatch(
        new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true/>`),
      );
    }
  });
});

describe("The macOS build may read the Mac's calendar (#190)", () => {
  const english =
    "IncarnaMind reads your calendar to show the meetings coming up and fill in a meeting’s notes. Your events stay on this Mac.";
  const chinese =
    "IncarnaMind 会读取你的日历，用来显示即将开始的会议并填写会议笔记。日程只保存在这台 Mac 上。";

  test("it says why it asks, on macOS 14 and later and before, in English and Chinese", async () => {
    const mac = section(await read("electron-builder.yml"), "mac");
    const strings = await read("build/zh_CN.lproj/InfoPlist.strings");
    for (const key of ["NSCalendarsFullAccessUsageDescription", "NSCalendarsUsageDescription"]) {
      expect(mac).toContain(`    ${key}: "${english}"\n`);
      expect(strings).toContain(`"${key}" = "${chinese}";\n`);
    }
  });
});
