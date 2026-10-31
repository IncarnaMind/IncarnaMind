import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CitationAttributes, CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  checkCard,
  useLocalChatModel as chooseScriptedModel,
  clickEndOf,
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
} from "./app";

/*
 * Correct a confirmed contradiction from the Documents (#1481). The checks
 * are written into the page, so no model is involved: the card, badge and ⌘K
 * all use the one correction path, and one Undo restores the words and marks.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

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

const marked = (text: string, mark: object) => ({ type: "text", text, marks: [mark] });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

async function launched(language: "en" | "zh-CN", width: number) {
  await writeFile(join(sources, "Acceptance scan.txt"), "The accepted reviewer is 王芳.\n");
  await writeFile(join(sources, "Annual report.txt"), "The accepted reviewer is 王强.\n");
  const running = await launchApp(dataDir, { fakeChat: true });
  const { app, window } = running;
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(window, [
    join(sources, "Acceptance scan.txt"),
    join(sources, "Annual report.txt"),
  ]);
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const evidence = (name: string, wording: string): CitationAttributes => {
    const document = documents.find((each) => each.name === name);
    if (!document) throw new Error(`No Document ${name}.`);
    return {
      passageId: `passage-${name}`,
      documentId: document.id,
      documentName: name,
      contentHash: document.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: `The accepted reviewer is ${wording}.`,
      check: "found",
      checkReason: null,
    };
  };
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  const checkedAt = new Date(Date.now() + 60_000).toISOString();
  const check = (
    id: string,
    text: string,
    correction: {
      from: string;
      choices: { wording: string; evidence: CitationAttributes }[];
    } | null,
  ) => ({
    type: "claimCheck",
    attrs: {
      id,
      request: `request-${id}`,
      action: "check-against-documents",
      state: "contradicted",
      reason: null,
      detail: null,
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      text,
      evidence: correction?.choices[0]?.evidence ?? null,
      correction,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt,
    },
  });
  return { app, window, editor, check, evidence };
}

async function insert(window: Page, blocks: object[]) {
  await window.getByTestId("mind-editor").evaluate((dom, content) => {
    (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
  }, blocks);
}

async function withinCard(window: Page) {
  const card = window.getByTestId("claim-card");
  const box = await card.boundingBox();
  const actions = await card.locator(".citation-card-actions").boundingBox();
  if (!box || !actions) throw new Error("The correction card isn't drawn.");
  expect(actions.x).toBeGreaterThanOrEqual(box.x);
  expect(actions.x + actions.width).toBeLessThanOrEqual(box.x + box.width + 1);
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`single, long, conflicting and older checks on the card (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor, check, evidence } = await launched(language, width);
    const shortText = language === "en" ? "The rate is 36.8%." : "比率是 36.8%。";
    const longText = "The detailed conclusion is old wording.";
    const conflictText = "The accepted reviewer is 李明.";
    const legacyText = "The legacy rate is 36.8%.";
    const short = check("short", shortText, {
      from: "36.8%",
      choices: [{ wording: "38.6%", evidence: evidence("Acceptance scan", "王芳") }],
    });
    const long = check("long", longText, {
      from: "old wording",
      choices: [
        {
          wording:
            "the complete replacement wording from the Document, which is too long for a button",
          evidence: evidence("Acceptance scan", "王芳"),
        },
      ],
    });
    const conflict = check("conflict", conflictText, {
      from: "李明",
      choices: [
        { wording: "王芳", evidence: evidence("Acceptance scan", "王芳") },
        { wording: "王强", evidence: evidence("Annual report", "王强") },
      ],
    });
    const legacy = check("legacy", legacyText, null);
    await insert(window, [
      paragraph(marked(shortText, short)),
      paragraph(marked(longText, long)),
      paragraph(marked(conflictText, conflict)),
      paragraph(marked(legacyText, legacy)),
    ]);
    const marks = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");
    await expect(marks).toHaveCount(4);

    await pointAndClick(window, marks.nth(0));
    const correct = card.getByTestId("claim-correct");
    await expect(correct).toHaveText(translate(language, "claim.correction", { wording: "38.6%" }));
    const actions = card.locator(".citation-card-actions button");
    await expect(actions.nth(0)).toHaveAttribute("data-testid", "claim-correct");
    await expect(actions.nth(1)).toHaveAttribute("data-testid", "claim-open");
    await expect(actions.nth(2)).toHaveAttribute("data-testid", "claim-keep");
    await withinCard(window);
    await screenshot(window, `correction-card-${language}`);
    await pointAndClick(window, correct);
    const firstLine = editor.locator(":scope > p").nth(0);
    await expect(firstLine).toContainText("38.6%");
    await expect(firstLine).not.toContainText("36.8%");
    await expect(firstLine.getByTestId("citation")).toHaveCount(1);
    await expect(firstLine.locator("[data-generated]")).toHaveText("38.6%");
    await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
    await expect(window.getByTestId("undo-line")).toContainText(
      translate(language, "claim.usedDocumentWording"),
    );
    await screenshot(window, `correction-applied-${language}`);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(firstLine).toContainText("36.8%");
    await expect(firstLine.getByTestId("citation")).toHaveCount(0);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");

    await clickEndOf(window, firstLine);
    await runCommand(
      window,
      "check.correctContradiction",
      translate(language, "claim.correction.command"),
    );
    await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");

    await pointAndClick(window, marks.nth(1));
    await expect(card.getByTestId("claim-correct")).toHaveText(
      translate(language, "claim.useDocumentWording"),
    );
    await withinCard(window);
    await window.keyboard.press("Escape");

    await pointAndClick(window, marks.nth(2));
    await expect(card.getByTestId("claim-correction-conflict")).toContainText("Acceptance scan");
    await expect(card.getByTestId("claim-correction-conflict")).toContainText("王芳");
    await expect(card.getByTestId("claim-correction-conflict")).toContainText("Annual report");
    await expect(card.getByTestId("claim-correction-conflict")).toContainText("王强");
    await pointAndClick(window, card.getByTestId("claim-correct"));
    await expect(editor.locator(":scope > p").nth(2)).toContainText("王芳");
    await expect(editor.locator(":scope > p").nth(2)).not.toContainText("李明");
    await pointAndClick(window, window.getByTestId("undo-action"));

    await pointAndClick(window, marks.nth(3));
    await expect(card.getByTestId("claim-correct")).toHaveCount(0);
    await expect(card.getByTestId("claim-open")).toHaveCount(0);
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    await app.close();
  });

  test(`the badge corrects every ready contradiction in one Undo (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor, check, evidence } = await launched(language, width);
    const firstText = language === "en" ? "The first rate is 36.8%." : "第一个比率是 36.8%。";
    const secondText = language === "en" ? "The second rate is 36.8%." : "第二个比率是 36.8%。";
    const legacyText = "The legacy rate is 36.8%.";
    const first = check("first", firstText, {
      from: "36.8%",
      choices: [{ wording: "38.6%", evidence: evidence("Acceptance scan", "王芳") }],
    });
    const second = check("second", secondText, {
      from: "36.8%",
      choices: [{ wording: "39.4%", evidence: evidence("Annual report", "王强") }],
    });
    const legacy = check("legacy", legacyText, null);
    await insert(window, [
      paragraph(marked(firstText, first)),
      paragraph(marked(secondText, second)),
      paragraph(marked(legacyText, legacy)),
    ]);
    const marks = window.getByTestId("claim-mark");
    const card = await checkCard(window);
    const correct = card.getByTestId("badge-correct-contradictions");
    await expect(correct).toHaveText(translate(language, "claim.correction.badge", { count: 2 }));
    await screenshot(window, `correction-badge-${language}`);
    await pointAndClick(window, correct);

    await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
    await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
    await expect(marks.nth(2)).toHaveAttribute("data-check", "contradicted");
    await expect(editor.locator(":scope > p").nth(0)).toContainText("38.6%");
    await expect(editor.locator(":scope > p").nth(1)).toContainText("39.4%");
    await expect(editor.getByTestId("citation")).toHaveCount(2);
    await expect(window.getByTestId("undo-line")).toContainText(
      translate(language, "claim.correction.doneMany", { count: 2 }),
    );
    await screenshot(window, `correction-bulk-applied-${language}`);

    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(marks.nth(0)).toHaveAttribute("data-check", "contradicted");
    await expect(marks.nth(1)).toHaveAttribute("data-check", "contradicted");
    await expect(editor.locator(":scope > p").nth(0)).toContainText("36.8%");
    await expect(editor.locator(":scope > p").nth(1)).toContainText("36.8%");
    await expect(editor.getByTestId("citation")).toHaveCount(0);
    await app.close();
  });
}
