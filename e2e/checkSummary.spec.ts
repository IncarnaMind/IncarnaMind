import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The card's one summary (#1941): what a check found and what is left, from the same counts its
 * rows show, in D276's words, under the one noun for a claim. "Everything checked" shows only
 * when nothing is left; a sentence with no Citation among what is left. A claim not checked yet
 * has no mark on the page and opens from the badge's row for it or from ⇧⌘K. The checks are
 * written into the page, so no model is involved.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const WORDS = {
  en: {
    label: "Claims and Citations",
    allChecked: "Everything checked",
    citedOnly: "4 claims supported · 3 claims with no Citation",
    look: "5 claims supported · 2 claims need a look: 1 contradicted, 1 Citation not found · 3 claims with no Citation",
    lookAndToCheck:
      "5 claims supported · 2 claims need a look: 1 contradicted, 1 Citation not found · 1 claim not checked yet · 3 claims with no Citation",
    lookOnly: "2 claims supported · 1 claim needs a look: 1 unsupported",
    noCitationRow: "3 claims with no Citation",
    needLookRow: "1 claim needs a look",
    sentences: {
      cited: "Harbours publish the times of high water every 12 months.",
      uncited: [
        "Spring tides rise twice a day.",
        "Gulls fly inland at dawn.",
        "The pier opens at six.",
      ],
      contradicted: "The agreement says the facilities end in 2027.",
      notFound: "Ferries run twice a day.",
      notChecked: "The model was not able to check this one.",
      unsupported: "Staff may work from home two days a week.",
      allChecked: "The lighthouse lights every night.",
    },
  },
  "zh-CN": {
    label: "说法和引用",
    allChecked: "已全部核对",
    citedOnly: "4 条说法有依据 · 3 条说法没有引用",
    look: "5 条说法有依据 · 2 条说法需要留意：1 条与文档矛盾、1 处引用未找到 · 3 条说法没有引用",
    lookAndToCheck:
      "5 条说法有依据 · 2 条说法需要留意：1 条与文档矛盾、1 处引用未找到 · 1 条说法待核对 · 3 条说法没有引用",
    lookOnly: "2 条说法有依据 · 1 条说法需要留意：1 条无依据",
    noCitationRow: "3 条说法没有引用",
    needLookRow: "1 条说法需要留意",
    sentences: {
      cited: "港口每 12 个月公布一次高潮时间。",
      uncited: ["春潮每天涨两次。", "海鸥天亮时飞往内陆。", "码头六点开门。"],
      contradicted: "协议规定这些贷款在 2027 年到期。",
      notFound: "渡轮每天开两班。",
      notChecked: "模型这次没能核对这一句。",
      unsupported: "员工每周可以在家办公两天。",
      allChecked: "岸边的灯塔每晚亮起。",
    },
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

const checked = (id: string, state: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  text,
  marks: [
    {
      type: "claimCheck",
      attrs: {
        id,
        request: "check-1",
        action: "check-against-documents",
        state,
        text,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: "2026-10-22T09:00:00.000Z",
        ...extra,
      },
    },
  ],
});
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const passageOf = (document: { id?: string; contentHash?: string } | undefined) => ({
  passageId: "passage-1",
  documentId: document?.id,
  documentName: "Tides",
  contentHash: document?.contentHash,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "Harbours publish the times of high water every 12 months.",
  check: "found",
  checkReason: null,
});

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];
  const { sentences } = words;
  test(`the card's summary names what is left, in its rows' words, and says everything checked only then (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const passage = passageOf(tides);
    const citation = (attrs: Record<string, unknown>) => ({
      type: "citation",
      attrs: { ...passage, ...attrs },
    });

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    const insert = (content: object[]) =>
      editor.evaluate((dom, nodes) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(
          (dom as unknown as { editor: Editor }).editor.state.doc.content.size,
          nodes,
        );
      }, content);
    // A note from an Answer: one sentence that cites, three that don't (#1941).
    await insert([
      paragraph(
        checked("check-1", "supported", sentences.cited, { evidence: passage }),
        citation({}),
      ),
      paragraph(checked("check-2", "supported", sentences.uncited[0] ?? "", { evidence: passage })),
      paragraph(checked("check-3", "supported", sentences.uncited[1] ?? "", { evidence: passage })),
      paragraph(checked("check-4", "supported", sentences.uncited[2] ?? "", { evidence: passage })),
    ]);
    const card = await checkCard(window);
    // One noun for a claim, from the title through the rows to the summary.
    await expect(card.locator(".check-card-title")).toHaveText(words.label);
    await expect(card.getByTestId("health-noCitation")).toContainText(words.noCitationRow);
    await expect(card.getByTestId("health-summary")).toHaveText(words.citedOnly);
    await expect(card.getByTestId("health-all-checked")).toHaveCount(0);

    // A Needs-a-look and a Citation not found join the summary, with their reasons.
    await insert([
      paragraph(
        checked("check-5", "contradicted", sentences.contradicted, {
          evidence: passage,
          says: "The agreement says the facilities end on 14 February 2029.",
        }),
      ),
      paragraph(
        checked("check-6", "supported", sentences.notFound, { evidence: passage }),
        citation({ check: "not-found", checkReason: "quote-not-on-pages" }),
      ),
    ]);
    await expect(card.getByTestId("health-summary")).toHaveText(words.look);
    await expect(card.getByTestId("health-all-checked")).toHaveCount(0);

    // A claim no check covers yet is named too, and has no mark on the page.
    await insert([
      paragraph(checked("check-7", "not-checked", sentences.notChecked, { reason: "refused" })),
    ]);
    await expect(card.getByTestId("health-summary")).toHaveText(words.lookAndToCheck);
    const unseen = window.locator('[data-testid="claim-mark"][data-claim="check-7"]');
    await expect(unseen).toBeHidden();
    await expect(unseen.locator("svg")).toHaveCount(0);

    // Its card still opens from the badge's row for the claims not checked yet.
    await pointAndClick(window, card.getByTestId("health-toCheck"));
    const claimCard = window.getByTestId("claim-card");
    await expect(claimCard).toHaveAttribute("data-check", "not-checked");
    await expect(claimCard.getByTestId("claim-sentence")).toHaveText(`“${sentences.notChecked}”`);
    await window.keyboard.press("Escape");
    await expect(claimCard).toHaveCount(0);

    // And from ⇧⌘K, with the cursor in its sentence.
    const line = editor.locator(":scope > p").filter({ hasText: sentences.notChecked });
    await pointAndClick(window, line);
    await expect(editor).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Shift+KeyK");
    await expect(claimCard).toHaveAttribute("data-check", "not-checked");
    await expect(claimCard.getByTestId("claim-sentence")).toHaveText(`“${sentences.notChecked}”`);
    await window.keyboard.press("Escape");
    await expect(claimCard).toHaveCount(0);

    // The summary holds at the widest window too.
    await setWindowSize(app, window, 1600, 900);
    const wide = await checkCard(window);
    await expect(wide.getByTestId("health-summary")).toHaveText(words.lookAndToCheck);
    const box = await wide.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1600);
    }
    await window.keyboard.press("Escape");
    await expect(wide).toHaveCount(0);

    // Everything checked, and only then: every claim holds and every one cites.
    await newMind(window);
    const clean = window.getByTestId("mind-editor");
    await clean.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        paragraph(
          checked("clean-1", "supported", sentences.cited, { evidence: passage }),
          citation({}),
        ),
        paragraph(
          checked("clean-2", "supported", sentences.allChecked, { evidence: passage }),
          citation({}),
        ),
      ],
    );
    const allCard = await checkCard(window);
    await expect(allCard.getByTestId("health-all-checked")).toHaveText(words.allChecked);
    await expect(allCard.getByTestId("health-summary")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(allCard).toHaveCount(0);

    // A Needs a look with everything else checked: the summary says only what needs it.
    await newMind(window);
    const looking = window.getByTestId("mind-editor");
    await looking.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        paragraph(
          checked("look-1", "supported", sentences.cited, { evidence: passage }),
          citation({}),
        ),
        paragraph(
          checked("look-2", "supported", sentences.allChecked, { evidence: passage }),
          citation({}),
        ),
        paragraph(checked("look-3", "unsupported", sentences.unsupported)),
      ],
    );
    const looked = await checkCard(window);
    await expect(looked.getByTestId("health-summary")).toHaveText(words.lookOnly);
    await expect(looked.getByTestId("health-unsupported")).toContainText(words.needLookRow);
    await expect(looked.getByTestId("health-all-checked")).toHaveCount(0);
    await app.close();
  });
}

test("the card keeps one height while a claim is being checked and as its result lands", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 900, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  const [tides] = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  const write = (state: string, extra: Record<string, unknown> = {}) =>
    editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.setContent(content);
      },
      [
        paragraph(
          checked("check-9", state, "Harbours publish the times of high water every 6 months.", {
            evidence: passageOf(tides),
            ...extra,
          }),
        ),
      ],
    );

  // A claim being checked keeps the summary's line, empty until its result lands: the card is
  // one height through it (#1312, #1941).
  await write("checking");
  const card = await checkCard(window);
  await expect(card.getByTestId("health-checking")).toBeVisible();
  const space = card.locator(".mind-health-summary");
  await expect(space).toHaveCount(1);
  await expect(space).toHaveText("");
  const running = await card.boundingBox();
  const spaceLine = await space.boundingBox();

  await write("contradicted", {
    says: "The agreement says the facilities end on 14 February 2029.",
  });
  await expect(card.getByTestId("health-summary")).toBeVisible();
  const done = await card.boundingBox();
  expect(running).not.toBeNull();
  expect(done).not.toBeNull();
  if (running && done) {
    expect(done.y).toBe(running.y);
    expect(done.height).toBe(running.height);
  }
  const summaryLine = await card.getByTestId("health-summary").boundingBox();
  expect(summaryLine?.height).toBe(spaceLine?.height);
  await app.close();
});
