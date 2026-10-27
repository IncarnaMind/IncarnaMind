/**
 * Not part of CI: records lane #2084's built flow, with the mouse and the keyboard, as frames
 * for a GIF (the feel check's screencast, e2e/feel.ts).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  assistantAnswers,
  createDataFolder,
  interceptOpenDialog,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  welcomeStep as step,
} from "./app";

const OUT = resolve(__dirname, "../.claude/lane-2084-ready-question/rec");
const SLOW = buildPdf(
  Array.from({ length: 250 }, (_none, page) => ({
    lines: [
      `Harbour times, page ${page + 1}`,
      "Harbours publish the times of high water every 12 months.",
    ],
  })),
);

test("record: add a file, its Question, its Answer and its Citation", async () => {
  test.setTimeout(300_000);
  const dataDir = await createDataFolder();
  const sources = await createDataFolder();
  const file = join(sources, "Harbour times.pdf");
  await writeFile(file, SLOW);
  await mkdir(join(OUT, "frames"), { recursive: true });
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  const session = await window.context().newCDPSession(window);
  const frames: { file: string; at: number }[] = [];
  const writing: Promise<void>[] = [];
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const name = `${String(frames.length).padStart(5, "0")}.jpg`;
    frames.push({ file: name, at: metadata.timestamp ?? 0 });
    writing.push(writeFile(join(OUT, "frames", name), Buffer.from(data, "base64")));
    void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");
    await useLocalChatModel(window);
    await session.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    await window.waitForTimeout(1200);

    // The keyboard: the card's first step, then Add files.
    const add = step(window, "files").getByTestId("first-open-step-do");
    await add.focus();
    await interceptOpenDialog(app, file);
    await window.waitForTimeout(600);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(900);
    // The line says the file is reading, then holds while it is not yet read.
    await window.waitForTimeout(1500);

    const ready = step(window, "question").getByTestId("first-open-ready");
    await expect(ready).toBeVisible({ timeout: 90_000 });
    await window.waitForTimeout(1200);
    // The mouse: the Question, then its Answer's Citation.
    await pointAndClick(window, ready);
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await window.waitForTimeout(800);
    const chip = answer.getByTestId("citation-chip").first();
    await pointAndClick(window, chip);
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await window.waitForTimeout(2000);
  } finally {
    await session.send("Page.stopScreencast").catch(() => undefined);
    await new Promise((done) => setTimeout(done, 500));
    await Promise.all(writing);
    const list = frames.flatMap((frame, index) => {
      const next = frames[index + 1];
      return [
        `file '${frame.file}'`,
        `duration ${next ? Math.max(next.at - frame.at, 0.001) : 0.6}`,
      ];
    });
    const last = frames.at(-1);
    if (last) list.push(`file '${last.file}'`);
    await writeFile(join(OUT, "frames", "frames.txt"), `${list.join("\n")}\n`);
    await session.detach().catch(() => undefined);
    await app.close();
    await removeDataFolder(dataDir);
    await removeDataFolder(sources);
  }
});
