import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  askFirstQuestion,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * A chat-plan profile whose sign-in this app can't read: trying to sign in says so and
 * writes nothing, abandoning the sign-in writes nothing either, and only a sign-in the
 * User finishes replaces the record (#2294).
 */

let dataDir: string;
let home: string;
let profile: string;
let secretsFile: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await mkdtemp(join(tmpdir(), "incarnamind-2294-home-"));
  profile = join(home, "chatgpt-profile");
  secretsFile = join(profile, "secrets.json");
});

test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await rm(home, { recursive: true, force: true });
});

/** A profile as a keychain that changed leaves it: a sign-in record this app can't read. */
async function writeUnreadableProfile() {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const stored = Buffer.from("not a sign-in record").toString("base64");
  await writeFile(secretsFile, JSON.stringify({ "chatgpt:account": stored }), { mode: 0o600 });
}

for (const { language, width, height } of [
  { language: "en", width: 1600, height: 900 },
  { language: "zh-CN", width: 900, height: 700 },
] as const) {
  test(`a chat-plan sign-in on a profile that can't be read says so and writes nothing, until it finishes (${language}, ${width} px)`, async () => {
    // The owner's profile and keychain are never touched: this one is inside a temporary home.
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(profile.startsWith(home)).toBe(true);
    await writeUnreadableProfile();
    const before = await readFile(secretsFile);
    const openai = await createFakeOpenAI();
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      home,
      chatGpt: openai.endpoints.issuer,
      ollama: "http://127.0.0.1:9",
      extraEnv: { INCARNAMIND_CHATGPT_PROFILE: profile },
    });
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await interceptOpenExternal(app);
      const card = await askFirstQuestion(window);

      await pointAndClick(window, card.getByTestId("setup-chatgpt"));

      const line = card.getByTestId("chatgpt-error");
      await expect(line).toContainText(
        translate(language, "chatgpt.signIn.error.record-unreadable"),
      );
      expect(await urlsOpened(app)).toEqual([]);
      expect((await readFile(secretsFile)).equals(before)).toBe(true);

      // The User chooses to sign in again, then walks away: still nothing is written.
      await pointAndClick(window, line.getByTestId("chatgpt-replace-sign-in"));
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      await pointAndClick(window, window.getByTestId("chatgpt-cancel"));
      await expect(window.getByTestId("chatgpt-error")).toHaveCount(0);
      expect((await readFile(secretsFile)).equals(before)).toBe(true);

      // The same choice, this time finished: only now does the record change.
      await pointAndClick(window, card.getByTestId("setup-chatgpt"));
      await expect(window.getByTestId("chatgpt-error")).toContainText(
        translate(language, "chatgpt.signIn.error.record-unreadable"),
      );
      await pointAndClick(window, window.getByTestId("chatgpt-replace-sign-in"));
      await expect.poll(() => urlsOpened(app)).toHaveLength(2);
      const [authorize] = (await urlsOpened(app)).slice(-1);
      expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
      await window.getByTestId("chatgpt-welcome-ok").click();
      await expect(card.getByTestId("setup-ready-title")).toHaveText(
        translate(language, "setup.ready", { name: translate(language, "chatgpt.title") }),
        { timeout: 15_000 },
      );

      expect((await readFile(secretsFile)).equals(before)).toBe(false);
      const plan = await window.evaluate(() =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getChatGptPlan(),
      );
      expect(plan.account).toMatchObject({ state: "signed-in" });
    } finally {
      await app.close();
      await openai.close();
    }
  });
}
