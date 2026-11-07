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
  clickEditItem,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  editItem,
  launchApp,
  leaveText,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  undoMenuItem,
} from "./app";

/*
 * Correct a confirmed contradiction from the Documents (#1481). The checks
 * are written into the page; the correction then checks the sentence again on
 * the scripted model like any edit (#2563), and one Undo restores the words and
 * marks. The card, badge and ⌘K all use the one correction path.
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
  await writeFile(
    join(sources, "Lease.txt"),
    language === "en"
      ? "The Tenant pays a break fee of $57,000.\nThe Landlord returns the deposit within 30 days.\nThe break fee is $57,000, and the deposit is returned within 30 days.\n"
      : "承租方支付解约费 57,000 美元。\n出租方在 30 天内退还押金。\n解约费为 57,000 美元，押金在 30 天内退还。\n",
  );
  // The corrected words, so the check that follows the correction finds them.
  const rates =
    language === "en"
      ? "The rate is 38.6%.\nThe first rate is 38.6%.\nThe second rate is 39.4%.\n"
      : "比率是 38.6%。\n第一个比率是 38.6%。\n第二个比率是 39.4%。\n";
  await writeFile(join(sources, "Rate card.txt"), rates);
  const running = await launchApp(dataDir, { fakeChat: true });
  const { app, window } = running;
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(window, [
    join(sources, "Acceptance scan.txt"),
    join(sources, "Annual report.txt"),
    join(sources, "Lease.txt"),
    join(sources, "Rate card.txt"),
  ]);
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const evidence = (
    name: string,
    wording: string,
    quote = `The accepted reviewer is ${wording}.`,
  ): CitationAttributes => {
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
      quote,
      check: "found",
      checkReason: null,
    };
  };
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  const checkedAt = new Date(Date.now() + 60_000).toISOString();
  type Correction = {
    from: string;
    choices: { wording: string; evidence: CitationAttributes }[];
  } | null;
  const result = (found: CitationAttributes[]) => ({
    reason: null,
    detail: null,
    evidence: found[0] ?? null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
  });
  // A sentence of contradicted parts, as a check of the Note writes it; each correction is its part's.
  const partsCheck = (
    id: string,
    text: string,
    parts: { start: number; end: number; correction: Correction }[],
  ) => ({
    type: "claimCheck",
    attrs: {
      id,
      request: `request-${id}`,
      action: "check-against-documents",
      state: "contradicted",
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      text,
      ...result([]),
      scope: { folderId: null, widened: false },
      checkedAt,
      parts: parts.map(({ start, end, correction }) => {
        const found = correction?.choices.map((choice) => choice.evidence) ?? [
          evidence("Acceptance scan", "王芳"),
        ];
        return {
          ...result(found),
          span: { start, end },
          kind: "fact",
          verdict: "contradicted",
          evidence: found,
          decidingEvidence: 0,
          ...(correction && { correction }),
        };
      }),
    },
  });
  const check = (id: string, text: string, correction: Correction) =>
    partsCheck(id, text, [{ start: 0, end: text.length, correction }]);
  return { app, window, editor, check, partsCheck, evidence };
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
    const rateLine = language === "en" ? "The rate is 38.6%." : "比率是 38.6%。";
    const short = check("short", shortText, {
      from: "36.8%",
      choices: [{ wording: "38.6%", evidence: evidence("Rate card", "38.6%", rateLine) }],
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
    await expect(marks.nth(0)).toHaveAttribute(
      "data-check",
      language === "en" ? "supported" : "unsupported",
      { timeout: 30_000 },
    );
    await expect(window.getByTestId("undo-line")).toContainText(
      translate(language, "claim.usedDocumentWording"),
    );
    await screenshot(window, `correction-applied-${language}`);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(firstLine).toContainText("36.8%");
    await expect(firstLine.getByTestId("citation")).toHaveCount(0);
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
    // Its two Documents' quotes are listed, so the change is on the part's row.
    await pointAndClick(window, card.getByTestId("claim-part-correct"));
    await expect(editor.locator(":scope > p").nth(2)).toContainText("王芳");
    await expect(editor.locator(":scope > p").nth(2)).not.toContainText("李明");
    await pointAndClick(window, window.getByTestId("undo-action"));

    await pointAndClick(window, marks.nth(3));
    // A check without a correction keeps what it offered before: Open and Keep as my view.
    await expect(card.getByTestId("claim-correct")).toHaveCount(0);
    await expect(card.getByTestId("claim-open")).toBeVisible();
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    await app.close();
  });

  // protects=a check's fix taken back with ⌘Z or Edit › Undo outside the note comes back with ⇧⌘Z or Edit › Redo, Citation and all, and the ⌘Z that then reaches the older add says which Documents it took out, with Redo that brings them back and the fix after them (#2402); fails_when=Redo is greyed after the fix's Undo, or the Documents leave without a line; no_claim=the note's own ⌘Z inside the text, which its own history keeps.
  test(`⌘Z and the Edit menu take back a fix and bring it back, and the next ⌘Z says which Documents it took out (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor, check, evidence } = await launched(language, width);
    const text = language === "en" ? "The rate is 36.8%." : "比率是 36.8%。";
    await insert(window, [
      paragraph(
        marked(
          text,
          check("rate", text, {
            from: "36.8%",
            choices: [
              {
                wording: "38.6%",
                evidence: evidence(
                  "Rate card",
                  "38.6%",
                  language === "en" ? "The rate is 38.6%." : "比率是 38.6%。",
                ),
              },
            ],
          }),
        ),
      ),
    ]);
    const mark = window.getByTestId("claim-mark").first();
    const line = editor.locator(":scope > p").first();
    const fixed = async () => {
      await expect(line).toContainText("38.6%");
      await expect(line.getByTestId("citation")).toHaveCount(1);
      await expect(line.getByTestId("citation")).toHaveAttribute("data-check", "found");
      await expect(mark).toHaveAttribute(
        "data-check",
        language === "en" ? "supported" : "unsupported",
        { timeout: 30_000 },
      );
    };
    const before = async () => {
      await expect(line).toContainText("36.8%");
      await expect(line.getByTestId("citation")).toHaveCount(0);
      await expect(mark).toHaveAttribute("data-check", "contradicted");
    };
    const library = async () =>
      (await coreOf(window)).evaluate(async (core) => (await core.listDocuments()).length);
    await pointAndClick(window, mark);
    await pointAndClick(window, window.getByTestId("claim-card").getByTestId("claim-correct"));
    await fixed();

    // Outside the note, as after the card closes: ⌘Z and ⇧⌘Z reach the window's changes.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await before();
    await expect.poll(async () => (await editItem(app, "edit.redo"))?.enabled).toBe(true);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await fixed();
    await clickEditItem(app, "edit.undo");
    await before();
    await clickEditItem(app, "edit.redo");
    await fixed();

    await window.keyboard.press("ControlOrMeta+z");
    await before();
    const addDocuments = translate(language, "undo.name.addDocuments");
    await expect
      .poll(() => undoMenuItem(app))
      .toEqual({
        label: translate(language, "menu.undo.named", { action: addDocuments }),
        enabled: true,
      });
    await window.keyboard.press("ControlOrMeta+z");
    const undoLine = window.getByTestId("undo-line");
    await expect(undoLine).toContainText(
      translate(language, "undo.documentsRemoved", { count: "4" }),
    );
    await expect.poll(library).toBe(0);
    await screenshot(window, `correction-add-undone-${language}`);

    await pointAndClick(window, undoLine.getByTestId("redo-action"));
    await expect.poll(library).toBe(4);
    await expect(undoLine).toContainText(
      translate(language, "undo.documentsAdded", { count: "4" }),
    );
    await before();
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await fixed();
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
      choices: [
        {
          wording: "38.6%",
          evidence: evidence(
            "Rate card",
            "38.6%",
            language === "en" ? "The first rate is 38.6%." : "第一个比率是 38.6%。",
          ),
        },
      ],
    });
    const second = check("second", secondText, {
      from: "36.8%",
      choices: [
        {
          wording: "39.4%",
          evidence: evidence(
            "Rate card",
            "39.4%",
            language === "en" ? "The second rate is 39.4%." : "第二个比率是 39.4%。",
          ),
        },
      ],
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

    const judged = language === "en" ? "supported" : "unsupported";
    await expect(marks.nth(0)).toHaveAttribute("data-check", judged);
    await expect(marks.nth(1)).toHaveAttribute("data-check", judged);
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

  test(`the foot keeps its height with a correction in its row (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window, check, evidence } = await launched(language, width);
    const text = language === "en" ? "The first rate is 36.8%." : "第一个比率是 36.8%。";
    await insert(window, [
      paragraph(
        marked(
          text,
          check("first", text, {
            from: "36.8%",
            choices: [{ wording: "38.6%", evidence: evidence("Acceptance scan", "王芳") }],
          }),
        ),
      ),
    ]);
    const card = await checkCard(window);
    const correct = card.getByTestId("badge-correct-contradictions");
    await expect(correct).toBeVisible();
    const foot = card.getByTestId("check-card-foot");
    const before = { card: await card.boundingBox(), foot: await foot.boundingBox() };
    if (!before.card || !before.foot) throw new Error("The card isn't drawn.");

    // The run's words take Check's row while the correction stays where it was, disabled.
    await app.evaluate(() => {
      (
        globalThis as unknown as { incarnamindSlowCheck: { hold: boolean } }
      ).incarnamindSlowCheck.hold = true;
    });
    await pointAndClick(window, card.getByTestId("badge-check-mind"));
    // The press asks first while the estimate lands, and with nothing changed offers every
    // sentence again; either way one more press runs it.
    const ask = card.getByTestId("mind-check-check");
    const every = card.getByTestId("mind-check-every");
    await expect
      .poll(
        async () =>
          (await card.getByTestId("card-foot-progress").count()) +
          (await ask.count()) +
          (await every.count()),
      )
      .toBeGreaterThan(0);
    if ((await ask.count()) > 0) await pointAndClick(window, ask);
    if ((await every.count()) > 0) await pointAndClick(window, every);
    await expect(card.getByTestId("card-foot-progress")).toBeVisible();
    const after = { card: await card.boundingBox(), foot: await foot.boundingBox() };
    if (!after.card || !after.foot) throw new Error("The card went at the press.");
    expect(after.card.height).toBeCloseTo(before.card.height, 0);
    expect(after.foot.height).toBeCloseTo(before.foot.height, 0);
    await app.evaluate(() => {
      const slow = (
        globalThis as unknown as { incarnamindSlowCheck: { hold: boolean; release(): void } }
      ).incarnamindSlowCheck;
      slow.hold = false;
      slow.release();
    });
    await app.close();
  });

  test(`each contradicted part of a two-part sentence is corrected from its row (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window, editor, partsCheck, evidence } = await launched(language, width);
    const fee = language === "en" ? "The break fee is $75,000" : "解约费为 75,000 美元";
    const days =
      language === "en" ? "the deposit is returned within 60 days" : "押金在 60 天内退还";
    const text = language === "en" ? `${fee}, and ${days}.` : `${fee}，${days}。`;
    const daysAt = text.indexOf(days);
    const sentence = partsCheck("two", text, [
      {
        start: 0,
        end: fee.length,
        correction: {
          from: language === "en" ? "$75,000" : "75,000",
          choices: [
            {
              wording: language === "en" ? "$57,000" : "57,000",
              evidence: evidence(
                "Lease",
                "",
                language === "en"
                  ? "The Tenant pays a break fee of $57,000."
                  : "承租方支付解约费 57,000 美元。",
              ),
            },
          ],
        },
      },
      {
        start: daysAt,
        end: daysAt + days.length,
        correction: {
          from: language === "en" ? "60 days" : "60 天",
          choices: [
            {
              wording: language === "en" ? "30 days" : "30 天",
              evidence: evidence(
                "Lease",
                "",
                language === "en"
                  ? "The Landlord returns the deposit within 30 days."
                  : "出租方在 30 天内退还押金。",
              ),
            },
          ],
        },
      },
    ]);
    await insert(window, [paragraph(marked(text, sentence))]);
    const mark = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");
    const line = editor.locator(":scope > p").nth(0);

    await pointAndClick(window, mark);
    const rows = card.getByTestId("claim-part");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByTestId("claim-part-correct")).toHaveText(
      translate(language, "claim.correction", {
        wording: language === "en" ? "$57,000" : "57,000",
      }),
    );
    await expect(rows.nth(1).getByTestId("claim-part-correct")).toHaveText(
      translate(language, "claim.correction", { wording: language === "en" ? "30 days" : "30 天" }),
    );
    await withinCard(window);
    await screenshot(window, `correction-parts-${language}`);
    const firstId = await mark.getAttribute("data-claim");
    await pointAndClick(window, rows.nth(1).getByTestId("claim-part-correct"));
    await expect(line).toContainText(language === "en" ? "30 days" : "30 天");
    await expect(line).toContainText(language === "en" ? "$75,000" : "75,000");
    // The check the correction asks for lands, and Undo brings back the check with both parts.
    await expect(mark).not.toHaveAttribute("data-claim", firstId ?? "", { timeout: 30_000 });
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(mark).toHaveAttribute("data-claim", firstId ?? "");

    await pointAndClick(window, mark);
    const again = card.getByTestId("claim-part");
    await expect(again).toHaveCount(2);
    await pointAndClick(window, again.nth(0).getByTestId("claim-part-correct"));
    await expect(line).toContainText(language === "en" ? "$57,000" : "57,000");
    await expect(mark).not.toHaveAttribute("data-claim", firstId ?? "", { timeout: 30_000 });
    await expect(line.getByTestId("citation")).toHaveCount(1);

    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(line).toContainText(language === "en" ? "$75,000" : "75,000");
    await expect(mark).toHaveAttribute("data-check", "contradicted");
    await app.close();
  });
}
