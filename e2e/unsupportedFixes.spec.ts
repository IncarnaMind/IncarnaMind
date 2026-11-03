import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  checkCard,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * A cited sentence found unsupported offers three fixes in its card (#1111):
 * Cut the unsupported part (an Edit with AI applied at once), Search all
 * Documents while its check searched only the Mind's Folder, and Keep as my
 * view; each is also in ⌘K, and the ones that change the Mind take one ⌘Z.
 * A sentence with no Citation keeps its card. The scripted model (src/main/fakeChat/checks.ts) finds the tutorial's
 * sentence partly supported and cuts it as `PARTLY` says.
 */
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

const QUOTE_ONE = "QN methods are much faster than GD algorithms";
const QUOTE_TWO = "First-order methods converge more slowly";
const UNCITED = "Penguins nest on the harbour cliffs.";

const LANGUAGES = {
  en: {
    tutorial:
      "The tutorial discusses the trade-off between training speed, robustness and memory needs: experiments usually show quasi-Newton methods are faster than gradient descent; first-order methods are usually more robust but slower.",
    cut: "Experiments usually show quasi-Newton methods are faster than gradient descent, and first-order methods are slower.",
    first: "The tutorial discusses",
    cutAction: "Cut the unsupported part",
    searchAll: "Search all Documents",
    keep: "Keep as my view",
    keepCommand: "Keep as my view",
    nothing: "I didn’t find this in “Tutorials”.",
  },
  "zh-CN": {
    tutorial:
      "教程讨论了训练速度、鲁棒性和内存需求之间的权衡：已有实验通常显示，拟牛顿方法比梯度下降更快；一阶优化方法通常更加稳健，但速度较慢。",
    cut: "已有实验通常显示，拟牛顿方法比梯度下降更快，一阶优化方法速度较慢。",
    first: "教程讨论了",
    cutAction: "删去无依据的部分",
    searchAll: "搜索全部文档",
    keep: "保留为我的观点",
    keepCommand: "保留为我的观点",
    nothing: "未在“Tutorials”中找到。",
  },
} as const;

/** Whether the first box sits inside the second. */
const inside = async (inner: Locator, outer: Locator) => {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  if (!a || !b) return false;
  return (
    a.x >= b.x - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y >= b.y - 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
};

/** A line's words, without its Citations' numbers. */
const wordsOf = (line: Locator) =>
  line.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const citation of copy.querySelectorAll('[data-testid="citation"]')) citation.remove();
    return (copy.textContent ?? "").trim();
  });

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];
  test(`a cited unsupported sentence's card cuts the part, searches all Documents and keeps it as the User's view, each with Undo and from ⌘K; one with no Citation keeps its card (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tutorial one.md"), `# One\n\n${QUOTE_ONE} in practice.\n`);
    await writeFile(join(sources, "Tutorial two.md"), `# Two\n\n${QUOTE_TWO} than QN methods.\n`);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await addDocuments(window, [
      join(sources, "Tutorial one.md"),
      join(sources, "Tutorial two.md"),
    ]);
    const documents = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const cite = (name: string, quote: string) => {
      const document = documents.find((each) => each.name === name);
      return {
        type: "citation",
        attrs: {
          passageId: "passage-1",
          documentId: document?.id,
          documentName: name,
          contentHash: document?.contentHash,
          pageFrom: 1,
          pageTo: 1,
          location: null,
          quote,
          check: "found",
          checkReason: null,
        },
      };
    };
    const text = (value: string) => ({ type: "text", text: value });

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        {
          type: "paragraph",
          content: [
            text(words.tutorial),
            cite("Tutorial one", QUOTE_ONE),
            cite("Tutorial two", QUOTE_TWO),
          ],
        },
        { type: "paragraph", content: [text(UNCITED)] },
      ],
    );
    // In a Folder, so its check searches the Folder and Search all Documents has more to search.
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await core.createLibraryGroup({ name: "Tutorials", description: "" });
      await core.moveToFolder({
        documentIds: (await core.listDocuments()).map((each) => each.id),
        mindIds: (await core.listMinds()).map((each) => each.id),
        folderId: folder.id,
      });
    });
    const lines = editor.locator(":scope > p");
    const tutorial = lines.nth(0);
    const marks = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");
    const tutorialMark = () => marks.first();
    const openCard = async (mark: Locator) => {
      await motionSettled(window);
      await pointAndClick(window, mark);
      await expect(card).toBeVisible();
    };
    // The sentence's verdict never changes its Citations' markers: two found Citations stay bare
    // and neutral through every fix, and the margin holds the one mark per sentence.
    const markers = tutorial.getByTestId("citation-chip");
    const expectFoundMarkers = async () => {
      await expect(markers).toHaveCount(2);
      for (const marker of await markers.all()) {
        await expect(marker).toHaveAttribute("data-check", "found");
        await expect(marker.locator(".citation-marker-icon")).toBeHidden();
      }
    };
    // ⌘Z in the Mind, where each fix leaves the focus.
    const undo = async () => {
      await focusSettled(window, editor);
      await window.keyboard.press("ControlOrMeta+z");
    };

    await slideSelect(window, tutorial, words.first, { line: lines.nth(1), words: "cliffs." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    await expect(marks).toHaveCount(2);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "unsupported");
    await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
    await expectFoundMarkers();

    // No Citation: its own card, with nothing of a Citation's part to cut (e2e/notFoundCard.spec.ts).
    await openCard(marks.nth(1));
    await expect(card.getByTestId("claim-nothing")).toHaveText(words.nothing);
    // Find sources waits in the card's ⋯: the Mind cites no paper or book.
    await expect(card.getByTestId("claim-find-sources")).toHaveCount(0);
    await pointAndClick(window, card.getByTestId("check-menu"));
    await expect(card.getByTestId("check.findSources")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(card.getByTestId("claim-remove")).toBeVisible();
    await expect(card.getByTestId("claim-cut")).toHaveCount(0);
    await expect(card.getByTestId("claim-cut-sentence")).toBeVisible();
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    await window.keyboard.press("Escape");

    // With Citations: the three fixes, the first the primary one, inside the card at both widths.
    for (const width of [1600, 1100]) {
      await setWindowSize(app, window, width, 900);
      await openCard(tutorialMark());
      await expect(card.getByTestId("claim-covers")).toBeVisible();
      const fixes = [
        card.getByTestId("claim-cut"),
        card.getByTestId("claim-search-all"),
        card.getByTestId("claim-keep"),
      ];
      await expect(fixes[0] as Locator).toHaveText(words.cutAction);
      await expect(fixes[1] as Locator).toHaveText(words.searchAll);
      await expect(fixes[2] as Locator).toHaveText(words.keep);
      await expect(fixes[0] as Locator).toHaveClass(/citation-card-action--primary/);
      for (const fix of fixes) expect(await inside(fix, card)).toBe(true);
      for (const gone of [
        "claim-cut-sentence",
        "claim-find-sources",
        "check.findSources",
        "claim-search-web",
        "claim-remove",
        "check-menu",
      ]) {
        await expect(card.getByTestId(gone)).toHaveCount(0);
      }
      await window.keyboard.press("Escape");
    }

    // Cut the unsupported part: applied at once, the Citations kept; ⌘Z puts the sentence back.
    // Wide, so the Mind keeps the focus once a card closes (one group gives it up, #963).
    await setWindowSize(app, window, 1600, 900);
    await openCard(tutorialMark());
    await pointAndClick(window, card.getByTestId("claim-cut"));
    await expect.poll(() => wordsOf(tutorial)).toBe(words.cut);
    await expect(tutorial.getByTestId("citation")).toHaveCount(2);
    await expect(tutorialMark()).toHaveAttribute("data-check", "needs-recheck");
    await expectFoundMarkers();
    await undo();
    await expect.poll(() => wordsOf(tutorial)).toBe(words.tutorial);
    await expect(tutorialMark()).toHaveAttribute("data-check", "unsupported");
    await expectFoundMarkers();

    // Keep as my view: the mark goes, and ⌘Z brings it back.
    await openCard(tutorialMark());
    await pointAndClick(window, card.getByTestId("claim-keep"));
    await expect(marks).toHaveCount(1);
    await expectFoundMarkers();
    await undo();
    await expect(marks).toHaveCount(2);
    await expect(tutorialMark()).toHaveAttribute("data-check", "unsupported");
    await expectFoundMarkers();

    // Search all Documents: the sentence is checked again in every Document, after which the card doesn't offer it.
    const before = await tutorialMark().getAttribute("data-claim");
    await openCard(tutorialMark());
    await pointAndClick(window, card.getByTestId("claim-search-all"));
    await expect(tutorialMark()).not.toHaveAttribute("data-claim", before ?? "");
    await expect(tutorialMark()).toHaveAttribute("data-check", "unsupported");
    await expectFoundMarkers();
    await openCard(tutorialMark());
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    await expect(card.getByTestId("claim-search-all")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // From ⌘K, with the cursor in the sentence.
    await clickEndOf(window, tutorial);
    await runCommand(window, "check.keepAsView", words.keepCommand);
    await expect(marks).toHaveCount(1);
    await undo();
    await expect(marks).toHaveCount(2);
    await clickEndOf(window, tutorial);
    await runCommand(window, "check.cutUnsupported", words.cutAction);
    await expect.poll(() => wordsOf(tutorial)).toBe(words.cut);
    await app.close();
  });
}

test("a sentence past the most one write checks says why, in English and Chinese, and Check now checks it alone", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tutorial one.md"), `# One\n\n${QUOTE_ONE} in practice.\n`);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  await addDocuments(window, [join(sources, "Tutorial one.md")]);
  const documentIds = await window.evaluate(async () =>
    (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()).map(
      (each) => each.id,
    ),
  );
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  // As a write of the assistant's leaves the sentences past the most it checks.
  const pastCap = (id: string, text: string, ...citations: object[]) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text,
        marks: [
          {
            type: "claimCheck",
            attrs: {
              id,
              request: "write-1",
              action: "check-against-documents",
              state: "not-checked",
              reason: "too-many",
              text,
              scope: { folderId: null, widened: false },
              versions: [],
              excluded: [],
              checkedAt: "2026-10-18T09:00:00.000Z",
            },
          },
        ],
      },
      ...citations,
    ],
  });
  const missing = {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: documentIds[0],
      documentName: "Tutorial one",
      pageFrom: 1,
      pageTo: 1,
      quote: "A quote the page doesn't hold.",
      check: "not-found",
      checkReason: "quote-not-on-pages",
    },
  };
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [pastCap("past-1", UNCITED), pastCap("past-2", "Gulls nest on the harbour walls.", missing)],
  );
  const marks = window.getByTestId("claim-mark");
  const card = window.getByTestId("claim-card");
  /** Opens the card of the claim not checked yet from the badge's row for them (#1941). */
  const openCardFor = async () => {
    await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
    await expect(card).toBeVisible();
    await motionSettled(window);
  };
  await expect(marks).toHaveCount(2);
  // A sentence the write left unchecked has no mark on the page, and its Citation that
  // isn't found has its own state on its marker: the two never disagree.
  await expect(marks.last()).toHaveAttribute("data-check", "not-checked");
  await expect(marks.last()).toBeHidden();
  const marker = editor.getByTestId("citation-chip");
  await expect(marker).toHaveAttribute("data-check", "not-found");
  await expect(marker.locator(".citation-marker-icon")).toBeVisible();
  for (const [language, reason, now] of [
    [
      "en",
      "Not checked yet: only the first 12 cited sentences are checked as they’re written",
      "Check now",
    ],
    ["zh-CN", "尚未核对：写入时只核对前 12 句带引用的话", "立即核对"],
  ] as const) {
    await setLanguage(window, language);
    await motionSettled(window);
    await openCardFor();
    await expect(card.getByTestId("claim-reason")).toContainText(reason);
    await expect(card.getByTestId("claim-check-now")).toHaveText(now);
    await expect(card.getByTestId("claim-check-again")).toHaveCount(0);
    await window.keyboard.press("Escape");
  }

  await motionSettled(window);
  await openCardFor();
  await pointAndClick(window, card.getByTestId("claim-check-now"));
  await expect(marks.first()).not.toHaveAttribute("data-claim", "past-1");
  await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
  await expect(marks.last()).toHaveAttribute("data-claim", "past-2");
  await expect(marks.last()).toHaveAttribute("data-check", "not-checked");
  await app.close();
});
