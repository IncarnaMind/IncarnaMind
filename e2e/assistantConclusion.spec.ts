import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
 * A sentence the assistant wrote whose cited fact is supported and whose conclusion was left out
 * as an opinion (#3019): no ✓ on the page, the Note still Checked, the check card naming the
 * opinion left out in full view though it has no row, and the sentence's card saying why, with
 * Check anyway on the conclusion and no Check again. The check is written into the page, so no
 * model is involved. Set INCARNAMIND_SCREENSHOTS to a folder to save screenshots.
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
    opinion: "so the harbour should plan for them",
    join: ", ",
    stop: ".",
    quote: LINE,
    reason:
      "The cited fact is supported. The rest is the assistant’s own conclusion and wasn’t checked.",
    opinions: "1 opinion left out",
    anyway: "Check anyway",
  },
  "zh-CN": {
    fact: "大潮每月出现两次",
    opinion: "所以港口应当提前安排",
    join: "，",
    stop: "。",
    quote: LINE_ZH,
    reason: "引用的事实有依据。其余是助手自己的结论，未核对。",
    opinions: "1 处观点未纳入核对",
    anyway: "仍然核对",
  },
} as const;

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't drawn.");
  return found;
}

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
  test(`the assistant's own conclusion reads Not checked, and the check card names it in view (${language})`, async () => {
    test.setTimeout(120_000);
    const words = CASES[language];
    const sentence = `${words.fact}${words.join}${words.opinion}${words.stop}`;
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
    const evidence = {
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
    };
    const versions = [{ documentId: tides?.id, contentHash: tides?.contentHash }];
    const part = {
      says: null,
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      versions,
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
    };
    const start = sentence.indexOf(words.opinion);
    const check = {
      id: "check-1",
      request: "check-1",
      action: "check-against-documents",
      state: "not-checked",
      reason: "assistant-conclusion",
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
          evidence: [evidence],
          decidingEvidence: 0,
        },
        {
          ...part,
          span: { start, end: start + words.opinion.length },
          kind: "opinion",
          verdict: null,
          evidence: [],
          byAssistant: true,
        },
      ],
    };
    // The assistant's words, as AI text, with the check's mark.
    const marks = [{ type: "generated" }, { type: "claimCheck", attrs: check }];
    await newMind(window);
    // The check card open as the sentence's check lands, as when the User watches a check end:
    // it fits what lands though no row comes with it.
    const health = await checkCard(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
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
    // No ✓ on the page; the Note itself still reads Checked.
    await expect(window.getByTestId("check-badge")).toBeVisible();
    await expect(
      window.locator('[data-testid="claim-mark"][data-claim="check-1"]'),
    ).toHaveAttribute("data-check", "not-checked");

    // The card has no row for it, and names the opinion left out where it can be read.
    await expect(health).toBeVisible();
    await expect(health.getByTestId("health-all-checked")).toBeVisible();
    const line = health.getByTestId("opinions-line");
    await expect(line).toContainText(words.opinions);
    await motionSettled(window);
    const [onLine, onBody] = await Promise.all([
      box(line),
      box(health.locator(".check-card-body")),
    ]);
    expect(onLine.y).toBeGreaterThanOrEqual(onBody.y);
    expect(onLine.y + onLine.height).toBeLessThanOrEqual(onBody.y + onBody.height + 0.5);
    await screenshot(window, `assistant-conclusion-${language}-check-card`);

    // Show opens the sentence's card on its conclusion.
    await pointAndClick(window, health.getByTestId("opinions-show"));
    const card = window.getByTestId("claim-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("claim-reason")).toHaveText(words.reason);
    await expect(card.getByTestId("claim-part-check-anyway")).toHaveText(words.anyway);
    await expect(card.getByTestId("claim-check-again")).toHaveCount(0);
    await screenshot(window, `assistant-conclusion-${language}-card`);
    await app.close();
  });
}
