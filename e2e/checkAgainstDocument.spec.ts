import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const RECORDING = process.env.INCARNAMIND_RECORDING;

const OWN = "Harbours publish the times of high water every week.";
const ELSEWHERE = "Penguins nest on the harbour cliffs every spring.";
const ABSENT = "Whales sing in the deep bay.";
const SLOW_ABSENT = "Whales sing in the deep bay slowly.";
const LONG = Array.from({ length: 6000 }, (_, index) => `Unrelated lease paragraph ${index}.`).join(
  "\n",
);

async function capture(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function film(window: Page, run: () => Promise<void>) {
  if (!RECORDING) return run();
  await mkdir(RECORDING, { recursive: true });
  const session = await window.context().newCDPSession(window);
  const writes: Promise<void>[] = [];
  const stamps: string[] = [];
  let frame = 0;
  session.on("Page.screencastFrame", (event) => {
    const name = `frame-${String(frame++).padStart(5, "0")}.jpg`;
    stamps.push(`${name} ${Date.now()}`);
    writes.push(writeFile(join(RECORDING, name), Buffer.from(event.data, "base64")));
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 85,
    maxWidth: 1440,
    maxHeight: 900,
    everyNthFrame: 2,
  });
  try {
    await run();
  } finally {
    await session.send("Page.stopScreencast");
    await Promise.all(writes);
    await writeFile(join(RECORDING, "frames.txt"), stamps.join("\n"));
    await session.detach();
  }
}

let dataDirs: string[];
let sources: string;
test.beforeEach(async () => {
  dataDirs = [];
  sources = await createDataFolder();
});
test.afterEach(async () => {
  for (const dataDir of dataDirs) await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function launchClaim(
  claim: string,
  scope: string,
  language: "en" | "zh-CN",
  files: readonly { name: string; contents: string | Uint8Array }[],
  width = 1440,
) {
  for (const file of files) await writeFile(join(sources, file.name), file.contents);
  const dataDir = await createDataFolder();
  dataDirs.push(dataDir);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(
    window,
    files.map((file) => join(sources, file.name)),
  );
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(claim);
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(`@${scope}`);
  await expect(window.getByTestId("scope-picker")).toBeVisible();
  await window.keyboard.press("Enter");
  const lines = editor.locator(":scope > p");
  const words = claim.split(" ");
  await slideSelect(window, lines.last(), words.slice(0, 2).join(" "), {
    line: lines.last(),
    words: words.slice(-2).join(" "),
  });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const mark = window.getByTestId("claim-mark");
  await expect(mark).toHaveAttribute("data-check", "unsupported");
  await motionSettled(window);
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  await capture(window, `after-offer-${language}-${width}`);
  return { app, window, card };
}

async function choose(window: Page, name: string) {
  const picker = window.getByTestId("document-or-folder-picker");
  await expect(picker).toBeVisible();
  const search = window.getByTestId("document-or-folder-search");
  await search.fill(name);
  const option = picker.getByText(name, { exact: true });
  await expect(option).toBeVisible();
  await pointAndClick(window, option);
  const ask = window.getByTestId("document-check-ask");
  const next = ask
    .or(window.getByTestId("consent-dialog"))
    .or(window.getByTestId("document-check-progress"));
  await expect(next.filter({ visible: true }).first()).toBeVisible();
  if (await ask.isVisible()) await pointAndClick(window, ask.getByTestId("document-check-read"));
}

const FILES = [
  { name: "Harbour times.txt", contents: OWN },
  { name: "Seabirds.txt", contents: ELSEWHERE },
];

for (const language of ["en", "zh-CN"] as const) {
  test(`a chosen Document supports and fully rules out a sentence (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window, card } = await launchClaim(OWN, "Seabirds", language, FILES);
    await pointAndClick(window, card.getByTestId("claim-check-document"));
    await capture(window, `after-picker-${language}-1440`);
    await choose(window, "Harbour times");
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-source")).toContainText("Harbour times");
    await expect(card.getByTestId("claim-quote")).toContainText("Harbours publish");
    await capture(window, `after-supported-${language}-1440`);
    await app.close();

    const absent = await launchClaim(ABSENT, "Seabirds", language, FILES);
    await pointAndClick(absent.window, absent.card.getByTestId("claim-check-document"));
    await choose(absent.window, "Harbour times");
    await expect(absent.card.getByTestId("claim-nothing")).toHaveText(
      language === "en"
        ? "I read all of “Harbour times” and didn’t find this."
        : "我已通读“Harbour times”，没有找到。",
    );
    await setWindowSize(absent.app, absent.window, 900, 900);
    await capture(absent.window, `after-absence-${language}-900`);
    await runCommand(
      absent.window,
      "check.againstDocument",
      language === "en" ? "Check against a Document…" : "对照指定文档核对…",
    );
    await expect(absent.window.getByTestId("document-or-folder-picker")).toBeVisible();
    await absent.window.keyboard.press("Escape");
    await absent.app.close();
  });
}

test("a partial read says exactly which pages it read, and Stop keeps the old mark", async () => {
  test.setTimeout(240_000);
  const partial = buildPdf([
    { printed: [{ text: "Unrelated lease text" }] },
    { printed: [] },
    { printed: [] },
  ]);
  const { app, window, card } = await launchClaim(
    ABSENT,
    "Seabirds",
    "en",
    [
      { name: "Harbour times.pdf", contents: partial },
      { name: "Seabirds.txt", contents: ELSEWHERE },
    ],
    900,
  );
  await pointAndClick(window, card.getByTestId("claim-check-document"));
  await choose(window, "Harbour times");
  await expect(card.getByTestId("claim-nothing")).toHaveText(
    "I read 1 of 3 pages in “Harbour times” and didn’t find this.",
  );
  await capture(window, "after-partial-en-900");
  await app.close();

  const stopped = await launchClaim(SLOW_ABSENT, "Seabirds", "en", [
    { name: "Long harbour.txt", contents: LONG },
    { name: "Seabirds.txt", contents: ELSEWHERE },
  ]);
  await pointAndClick(stopped.window, stopped.card.getByTestId("claim-check-document"));
  await choose(stopped.window, "Long harbour");
  const progress = stopped.card.getByTestId("document-check-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Reading “Long harbour”");
  await expect(progress).not.toContainText(" 0 of ");
  await expect(progress).toContainText("· Stop");
  // While it reads, the card is the read's: nothing that would start another beside it.
  for (const offered of [
    "claim-nothing",
    "claim-check-document",
    "claim-check-again",
    "claim-read-continue",
  ]) {
    await expect(stopped.card.getByTestId(offered)).toHaveCount(0);
  }
  await capture(stopped.window, "after-progress-en-1440");
  await pointAndClick(stopped.window, stopped.card.getByTestId("document-check-stop"));
  await expect(stopped.card.getByTestId("claim-nothing")).toHaveText(
    "I didn’t find this in “Seabirds”.",
  );
  await stopped.app.close();
});

test("⌘K opens the same picker, and consent is asked before a cloud whole read", async () => {
  test.setTimeout(240_000);
  const { app, window, card } = await launchClaim(OWN, "Seabirds", "en", FILES);
  await acceptPlainTextKeys(window);
  await film(window, async () => {
    await window.evaluate(() => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
    });
    await runCommand(window, "check.againstDocument", "Check against a Document…");
    await choose(window, "Harbour times");
    const consent = window.getByTestId("consent-dialog");
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("whole text");
    await capture(window, "after-consent-en-1440");
    await pointAndClick(window, consent.getByTestId("consent-allow"));
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-quote")).toContainText("Harbours publish");
  });
  await app.close();
});
