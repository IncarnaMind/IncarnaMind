import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A sentence whose cited fact is supported and whose other part says something is missing, on
 * Documents too long to read whole (#3019): its card says the fact is supported and what it says
 * is missing wasn't checked. The check is written into the page, so no model is involved. Set
 * INCARNAMIND_SCREENSHOTS to a folder to save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const LINE = "Spring tides come twice a month, at new and full moon.";
const LINE_ZH = "大潮每月出现两次，分别在新月和满月。";
const TIDES = ["# Tides", "", LINE, "", LINE_ZH, ""].join("\n");

const CASES = {
  en: {
    fact: "Spring tides come twice a month",
    absence: "the paper never gives their height",
    join: ", and ",
    stop: ".",
    quote: LINE,
    reason:
      "The cited fact is supported. What the sentence says is missing wasn’t checked: the Documents are too long to read whole.",
  },
  "zh-CN": {
    fact: "大潮每月出现两次",
    absence: "文中没有给出潮高",
    join: "，",
    stop: "。",
    quote: LINE_ZH,
    reason: "引用的事实有依据。句中说没有的内容未核对：文档太长，无法通读。",
  },
} as const;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a cited fact beside what the sentence says is missing names both on its card (${language})`, async () => {
    test.setTimeout(120_000);
    const words = CASES[language];
    const sentence = `${words.fact}${words.join}${words.absence}${words.stop}`;
    await writeFile(join(sources, "Tides.md"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 760);
    await addDocuments(window, [join(sources, "Tides.md")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const versions = [{ documentId: tides?.id, contentHash: tides?.contentHash }];
    const part = {
      says: null,
      unsupported: null,
      calculation: null,
      detail: null,
      versions,
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
    };
    const start = sentence.indexOf(words.absence);
    const check = {
      id: "check-1",
      request: "check-1",
      action: "check-against-documents",
      state: "not-checked",
      reason: "absence-read-limit",
      detail: null,
      providerId: null,
      modelId: "fake-model",
      text: sentence,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions,
      excluded: [],
      checkedAt: "2026-11-13T09:00:00.000Z",
      parts: [
        {
          ...part,
          span: { start: 0, end: words.fact.length },
          kind: "fact",
          verdict: "supported",
          reason: null,
          evidence: [
            {
              passageId: "passage-1",
              documentId: tides?.id,
              documentName: "Tides",
              contentHash: tides?.contentHash,
              pageFrom: null,
              pageTo: null,
              location: null,
              quote: words.quote,
              check: "found",
              checkReason: null,
            },
          ],
          decidingEvidence: 0,
        },
        {
          ...part,
          span: { start, end: start + words.absence.length },
          kind: "fact",
          verdict: "not-checked",
          reason: "absence-read-limit",
          evidence: [],
        },
      ],
    };
    const marks = [{ type: "claimCheck", attrs: check }];
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        { type: "paragraph", content: [{ type: "text", text: "Tides" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: sentence.slice(0, -1), marks },
            {
              type: "citation",
              attrs: {
                documentId: tides?.id,
                documentName: "Tides",
                contentHash: tides?.contentHash,
                quote: words.quote,
                check: "found",
                checkReason: null,
              },
            },
            { type: "text", text: sentence.slice(-1), marks },
          ],
        },
      ],
    );
    const mark = window.locator('[data-testid="claim-mark"][data-claim="check-1"]');
    await expect(mark).toHaveAttribute("data-check", "not-checked");
    // The check card's row of sentences not checked opens its card, as a User reaches it.
    await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
    const card = window.getByTestId("claim-card");
    await expect(card).toBeVisible();
    await screenshot(window, `absence-beside-fact-${language}-card`);
    await expect(card.getByTestId("claim-reason")).toHaveText(words.reason);
    await app.close();
  });
}
