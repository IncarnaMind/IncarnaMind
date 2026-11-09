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
 * The card counts sentences, each once, by its one state (#2831): what needs a look, what is
 * supported, what is being checked and what isn't checked, each a row a click moves to (#2313),
 * and no row of Citations. The badge's "Checked" line shows only when nothing is left. A sentence not
 * checked yet has no mark on the page and opens from the card's row for it or from ⇧⌘K. The
 * checks are written into the page, so no model is involved.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const WORDS = {
  en: {
    label: "Checks",
    allChecked: /^Checked \S/,
    supported: "4 supported",
    allSupported: "2 supported",
    lookOnly: "2 supported",
    twoLook: "2 need a look",
    needLookRow: "1 needs a look",
    toCheck: "1 not checked",
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
    label: "核对",
    allChecked: /^已核对 \S/,
    supported: "4 句有依据",
    allSupported: "2 句有依据",
    lookOnly: "2 句有依据",
    twoLook: "2 句需要留意",
    needLookRow: "1 句需要留意",
    toCheck: "1 句未核对",
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
    // One noun, sentence, from the title through the rows: four supported, cited or not, in one row,
    // and a supported sentence with no Citation counts as done (#2831).
    await expect(card.locator(".check-card-title")).toHaveText(words.label);
    await expect(card.getByTestId("health-supported")).toContainText(words.supported);
    await expect(card.getByTestId("health-noCitation")).toHaveCount(0);
    await expect(card.getByTestId("health-found")).toHaveCount(0);
    await expect(card.getByTestId("health-all-checked")).toHaveText(words.allChecked);

    // A contradicted sentence and one whose Citation isn't found each need a look, in one row.
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
    await expect(card.getByTestId("health-look")).toContainText(words.twoLook);
    await expect(card.getByTestId("health-supported")).toContainText(words.supported);
    await expect(card.getByTestId("health-all-checked")).toHaveCount(0);

    // A claim no check covers yet is named too, and has no mark on the page.
    await insert([
      paragraph(checked("check-7", "not-checked", sentences.notChecked, { reason: "stopped" })),
    ]);
    await expect(card.getByTestId("health-supported")).toContainText(words.supported);
    // Each count shows once in the card: the row names the one not checked yet (#2313).
    await expect(card.getByTestId("health-toCheck")).toContainText(words.toCheck);
    await expect(card.getByText(words.toCheck, { exact: true })).toHaveCount(1);
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

    // The rows hold at the widest window too.
    await setWindowSize(app, window, 1600, 900);
    const wide = await checkCard(window);
    await expect(wide.getByTestId("health-supported")).toContainText(words.supported);
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
    await expect(allCard.getByTestId("health-supported")).toContainText(words.allSupported);
    await window.keyboard.press("Escape");
    await expect(allCard).toHaveCount(0);

    // A Needs a look with everything else checked: one row each.
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
    await expect(looked.getByTestId("health-supported")).toContainText(words.lookOnly);
    await expect(looked.getByTestId("health-look")).toContainText(words.needLookRow);
    await expect(looked.getByTestId("health-all-checked")).toHaveCount(0);
    await app.close();
  });
}

test("the card keeps one height as a result lands, its body taking what it needs", async () => {
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

  // No line is reserved empty at rest: the card takes its first paint's height (#2313).
  await write("checking");
  const card = await checkCard(window);
  await expect(card.getByTestId("health-checking")).toBeVisible();
  await expect(card.locator(".mind-health-summary")).toHaveCount(0);
  const running = await card.boundingBox();

  await write("contradicted", {
    says: "The agreement says the facilities end on 14 February 2029.",
  });
  // The result lands in the same card: the card keeps the height it opened with, so it does not
  // jump; its body holds what the result needs and scrolls if that is more (#2313).
  await expect(card.locator(".mind-health-summary")).toHaveCount(0);
  await expect(card.getByTestId("health-look")).toContainText("1 needs a look");
  const done = await card.boundingBox();
  expect(running).not.toBeNull();
  expect(done).not.toBeNull();
  if (running && done) {
    expect(done.y).toBeCloseTo(running.y, 0);
    expect(done.height).toBeCloseTo(running.height, 0);
  }
  const body = card.locator(".check-card-body");
  await expect(body).toHaveCount(1);
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await app.close();
});
