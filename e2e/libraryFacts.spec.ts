import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor, JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckPart,
  CoreBridge,
  LibraryFact,
  LibrarySource,
} from "../src/core/api";
import { writeContradictionWatch } from "../src/shared/contradictionWatch";
import { factVersion, LIBRARY_FACTS, SOURCE_KEY, sourceValue } from "../src/shared/libraryFacts";
import { sentenceKey, writeMindCheck } from "../src/shared/mindCheck";
import { writeOpinionSentences } from "../src/shared/opinions";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Sentences about the Library itself (#2525), as a note shows them once checked: the card's row
 * names the Library fact that decided the sentence and where it came from, a description the facts
 * can't settle says why it can't be checked, the badge's green line names it, the sentences about
 * the note itself are named on the left-out line, and a change to the Library puts a sentence back
 * to needs re-check. What the assistant wrote that waits for the User to allow what checks send now
 * says so on its card, whose Review… asks, then checks the whole write. The marks are written as a
 * check writes them. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

/** When the marks say they were checked: after the Document the test adds first. */
let checkedAt = "";

const ofLibrary = (
  fact: LibraryFact,
  source: LibrarySource,
  quote: string,
): CitationAttributes => ({
  passageId: `${LIBRARY_FACTS}:shown`,
  documentId: LIBRARY_FACTS,
  documentName: "Library facts",
  contentHash: `${LIBRARY_FACTS}:shown`,
  quote,
  pageFrom: null,
  pageTo: null,
  location: { kind: "library", source, fact },
  check: "found",
  checkReason: null,
});

const part = (
  start: number,
  end: number,
  kind: ClaimCheckPart["kind"],
  evidence: CitationAttributes[] = [],
  itself = false,
): ClaimCheckPart => ({
  span: { start, end },
  kind,
  ...(itself && { itself: true }),
  verdict: kind === "opinion" ? null : "supported",
  evidence,
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

const checked = (
  id: string,
  text: string,
  extra: Partial<ClaimCheckAttributes>,
): ClaimCheckAttributes => ({
  id,
  text,
  request: "library-smoke",
  action: "check-against-documents",
  state: "supported",
  reason: null,
  detail: null,
  providerId: null,
  modelId: null,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt,
  ...extra,
});

const paragraph = (id: string, text: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text, ...(check && { marks: [{ type: "claimCheck", attrs: check }] }) },
  ],
});

async function setContent(window: Page, content: JSONContent[]) {
  await window.getByTestId("mind-editor").evaluate((dom, blocks) => {
    const editor = (dom as unknown as { editor: Editor }).editor;
    editor.commands.setContent(blocks);
    editor.commands.setTextSelection(1);
  }, content);
}

/** Writes the note's left-out sentences and its last check into its settings, as a check does. */
async function applySettings(window: Page, update: number[]) {
  const mindId = await window.getByTestId("mind-pane").last().getAttribute("data-mind-id");
  if (!mindId) throw new Error("The test note is not open.");
  const state = await window.evaluate(
    async (id) =>
      Array.from(
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.openMind(id))
          .state,
      ),
    mindId,
  );
  const current = new Y.Doc();
  Y.applyUpdate(current, new Uint8Array(state));
  const vector = Y.encodeStateVector(current);
  const patch = new Y.Doc();
  Y.applyUpdate(patch, new Uint8Array(update));
  current.transact(() => {
    for (const [key, value] of patch.getMap("settings")) current.getMap("settings").set(key, value);
  });
  const change = Array.from(Y.encodeStateAsUpdate(current, vector));
  await window.evaluate(
    async ({ id, update }) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
        id,
        new Uint8Array(update),
      );
    },
    { id: mindId, update: change },
  );
}

/** Whether `inner`'s box sits inside `outer`'s. */
const inside = async (inner: Locator, outer: Locator) => {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  return (
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
};

const WORDS = {
  en: {
    count: "Your Library lists 1 uploaded Document.",
    folder: "The Research Folder holds 6 Documents.",
    described: "The files are mostly fieldwork material.",
    whole: "This is an overview of your files.",
    fact: "You also have saved notes",
    itself: "listed separately below",
    rows: {
      count: "Your Library: 1 Document",
      folder: "All Documents · 1 Folder left out: 6 Documents in “Research”",
      notes: "Your Library: 2 other notes",
      itself: "About this note, not the Documents: left out",
    },
    reason: "Only your Library’s counts, names and kinds can be checked.",
    green: "1 sentence can’t be checked",
    left: "2 sentences about this note left out",
    changed: "Your Library has changed since this was checked.",
  },
  "zh-CN": {
    count: "你的资料库里有 1 个上传的文档。",
    folder: "Research 文件夹里有 6 个文档。",
    described: "这些文件大多是野外调查资料。",
    whole: "这是一份文件概览。",
    fact: "你还保存了其他笔记",
    itself: "列在下文",
    rows: {
      count: "你的资料库：1 个文档",
      folder: "全部文档 · 已排除 1 个文件夹：“Research”中有 6 个文档",
      notes: "你的资料库：另有 2 篇笔记",
      itself: "关于本笔记本身，未纳入核对",
    },
    reason: "只能核对资料库的数量、名称和类型。",
    green: "1 句无法核对",
    left: "2 句关于本笔记的说明未纳入核对",
    changed: "核对之后，资料库有了变动。",
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
  test(`a checked overview note names its Library facts, what can't be checked and what it says of itself; a Library change asks for a re-check (${language})`, async () => {
    const words = WORDS[language];
    await writeFile(join(sources, "Harbour survey.txt"), "Harbour survey: the north wall.");
    await writeFile(join(sources, "Tide log.txt"), "Tide log: high water at 04:12.");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Harbour survey.txt")]);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);

    const source = { kind: "library" } as const;
    checkedAt = new Date().toISOString();
    const mixed = `${words.fact}${language === "en" ? ", " : "，"}${words.itself}${language === "en" ? "." : "。"}`;
    const itselfAt = mixed.indexOf(words.itself);
    await setContent(window, [
      paragraph(
        "count",
        words.count,
        checked("count-check", words.count, {
          evidence: ofLibrary({ kind: "documents", count: 1 }, source, "Documents in all: 1"),
          // As a check keeps them: the fact it rests on, and where the facts came from.
          versions: [
            factVersion(null, "documents", "1"),
            factVersion(null, SOURCE_KEY, sourceValue(source)),
          ],
        }),
      ),
      paragraph(
        "folder",
        words.folder,
        checked("folder-check", words.folder, {
          evidence: ofLibrary(
            { kind: "folder", name: "Research", count: 6 },
            { kind: "left-out", folders: 1 },
            "Documents in the Folder “Research” and the Folders inside it: 6",
          ),
        }),
      ),
      paragraph(
        "described",
        words.described,
        checked("described-check", words.described, {
          state: "not-checked",
          reason: "library-unsettled",
        }),
      ),
      paragraph(
        "mixed",
        mixed,
        checked("mixed-check", mixed, {
          parts: [
            part(0, words.fact.length, "fact", [
              ofLibrary({ kind: "notes", count: 2 }, source, "Notes besides this one: 2"),
            ]),
            part(itselfAt, itselfAt + words.itself.length, "opinion", [], true),
          ],
        }),
      ),
      paragraph("whole", words.whole),
    ]);
    const settings = new Y.Doc();
    writeOpinionSentences(settings, [
      {
        id: "whole-check",
        blockId: "whole",
        text: words.whole,
        occurrence: 0,
        parts: [part(0, words.whole.length, "opinion", [], true)],
      },
    ]);
    writeMindCheck(settings.getMap("settings"), {
      at: checkedAt,
      sentences: 5,
      stop: null,
      skipped: [sentenceKey(words.whole)],
      unexamined: [],
    });
    await applySettings(window, Array.from(Y.encodeStateAsUpdate(settings)));

    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(4);
    // A description the facts can't settle doesn't hold back the ✓, and the green line names it.
    const badge = window.getByTestId("check-badge");
    await expect(badge).toHaveAttribute("data-state", "checked");
    await expect(badge).toContainText(words.green);
    // The left-out line counts the sentences about the note itself in their own words.
    const health = await checkCard(window);
    await expect(health.getByTestId("opinions-line").first()).toContainText(words.left);
    await screenshot(window, `library-health-${language}`);
    await window.keyboard.press("Escape");

    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 900);
      const card = window.getByTestId("claim-card");

      await pointAndClick(window, marks.nth(0));
      const countRow = card.getByTestId("claim-library");
      await expect(countRow).toHaveText(words.rows.count);
      expect(await inside(countRow, card)).toBe(true);
      // The facts are no Document's: nothing to open, and no Citation to add.
      await expect(card.getByTestId("claim-open")).toHaveCount(0);
      await expect(card.getByTestId("claim-add-citation")).toHaveCount(0);
      await screenshot(window, `library-count-${language}-${width}`);
      await window.keyboard.press("Escape");

      await pointAndClick(window, marks.nth(1));
      const folderRow = card.getByTestId("claim-library");
      await expect(folderRow).toHaveText(words.rows.folder);
      expect(await inside(folderRow, card)).toBe(true);
      await window.keyboard.press("Escape");

      // A sentence not checked has no mark on the page: the health card's row for the sentences
      // a check can't settle opens its card (#2313).
      await pointAndClick(window, (await checkCard(window)).getByTestId("health-cantCheck"));
      await expect(card).toHaveAttribute("data-check", "not-checked");
      await expect(card.getByTestId("claim-reason")).toHaveText(words.reason);
      await expect(card.getByTestId("claim-cut")).toHaveCount(0);
      // No check can change a description: none is offered.
      await expect(card.getByTestId("claim-check-again")).toHaveCount(0);
      expect(await inside(card.getByTestId("claim-reason"), card)).toBe(true);
      await screenshot(window, `library-unsettled-${language}-${width}`);
      await window.keyboard.press("Escape");

      await pointAndClick(window, marks.nth(3));
      const rows = card.getByTestId("claim-part");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).getByTestId("claim-part-library")).toHaveText(words.rows.notes);
      await expect(rows.nth(1)).toContainText(words.rows.itself);
      expect(await inside(rows.nth(0).getByTestId("claim-part-library"), card)).toBe(true);
      await screenshot(window, `library-parts-${language}-${width}`);
      await window.keyboard.press("Escape");
    }

    // A Document added after the check: the sentence its count decided needs a re-check.
    await setWindowSize(app, window, 1440, 900);
    await window.getByTestId("add-documents-input").setInputFiles([join(sources, "Tide log.txt")]);
    await expectReadyDocuments(window, 2);
    await expect(marks.nth(0)).toHaveAttribute("data-check", "needs-recheck");
    // The others rest on no fact the change touched.
    await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
    await pointAndClick(window, marks.nth(0));
    await expect(window.getByTestId("claim-card").getByTestId("claim-reason")).toHaveText(
      words.changed,
    );
    await screenshot(window, `library-changed-${language}`);
    await app.close();
  });
}

const WAITING = {
  en: {
    supported: "The harbour survey covers the north wall.",
    unsupported: "High water came at 04:12.",
    reason: "Checks now send more than when you allowed them",
    review: "Review…",
  },
  "zh-CN": {
    supported: "Harbour survey 记录了 north wall。",
    unsupported: "高潮出现在 04:12。",
    reason: "核对现在发送的内容比你当初允许的更多",
    review: "查看…",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`what the assistant wrote waits for the User to allow what checks send now: its card says why, and Review… asks, then checks the whole write (${language})`, async () => {
    const words = WAITING[language];
    await writeFile(join(sources, "Harbour survey.txt"), "Harbour survey: the north wall.");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    // Checks to the chosen service aren't allowed as they send now: Review… is where they're asked.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await bridge.saveChatProvider({
        kind: "openai",
        modelId: "gpt-6.1-sol",
        apiKey: "key-not-real",
      });
      if (provider.service) await bridge.revokeConsent("checks", provider.service.id);
    });
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Harbour survey.txt")]);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);

    checkedAt = new Date().toISOString();
    const waiting = (id: string, text: string) =>
      paragraph(
        id,
        text,
        checked(`${id}-check`, text, {
          request: "waiting-write",
          state: "not-checked",
          reason: "consent-widened",
        }),
      );
    await setContent(window, [
      waiting("first", words.supported),
      waiting("second", words.unsupported),
    ]);

    const badge = window.getByTestId("check-badge");
    await expect(badge).not.toHaveAttribute("data-state", "checked");
    // The contradiction watch waited too, as a new version of a Document records it.
    const settings = new Y.Doc();
    writeContradictionWatch(settings.getMap("settings"), {
      at: checkedAt,
      documentName: "Harbour survey",
      claims: 2,
      checked: 0,
      contradicted: 0,
      cost: null,
      stop: { reason: "consent-widened" },
      smallModel: false,
    });
    await applySettings(window, Array.from(Y.encodeStateAsUpdate(settings)));
    const watched = (await checkCard(window)).getByTestId("contradictions-watched");
    await expect(watched).toContainText(words.reason);
    await expect(watched.getByTestId("contradictions-watched-review")).toHaveText(words.review);
    await screenshot(window, `waiting-watch-${language}`);
    await window.keyboard.press("Escape");
    const card = window.getByTestId("claim-card");
    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 900);
      // A sentence not checked has no mark on the page: the health card's Next opens its card.
      await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
      await expect(card).toHaveAttribute("data-check", "not-checked");
      const reason = card.getByTestId("claim-reason");
      await expect(reason).toContainText(words.reason);
      const review = card.getByTestId("claim-review-consent");
      await expect(review).toHaveText(words.review);
      await expect(card.getByTestId("claim-check-again")).toHaveCount(0);
      expect(await inside(reason, card)).toBe(true);
      expect(await inside(review, card)).toBe(true);
      await screenshot(window, `waiting-consent-${language}-${width}`);
      if (width === 1440) await window.keyboard.press("Escape");
    }

    await pointAndClick(window, card.getByTestId("claim-review-consent"));
    const consent = window.getByTestId("consent-dialog");
    await expect(consent).toBeVisible();
    await screenshot(window, `waiting-consent-dialog-${language}`);
    await pointAndClick(window, consent.getByTestId("consent-allow"));

    // Allowed, both sentences of the write are checked, not only the one whose card asked.
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(2, { timeout: 30_000 });
    await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
    await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
    await app.close();
  });
}

// protects=once the User allows what checks send in Settings › Privacy, a write that waited is only not checked, with Check again, and the watch's line only says it checked nothing, with Close; Check again checks the whole write; fails_when="Checks now send more than when you allowed them · Review…" stays after the User allowed it.
test("allowed in Settings › Privacy, what waited is only not checked, and Check again checks it", async () => {
  const words = WAITING.en;
  await writeFile(join(sources, "Harbour survey.txt"), "Harbour survey: the north wall.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  const serviceId = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await bridge.saveChatProvider({
      kind: "openai",
      modelId: "gpt-6.1-sol",
      apiKey: "key-not-real",
    });
    if (provider.service) await bridge.revokeConsent("checks", provider.service.id);
    return provider.service?.id ?? null;
  });
  if (!serviceId) throw new Error("The cloud model has no service.");
  await addDocuments(window, [join(sources, "Harbour survey.txt")]);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  checkedAt = new Date().toISOString();
  const waiting = (id: string, text: string) =>
    paragraph(
      id,
      text,
      checked(`${id}-check`, text, {
        request: "waiting-write",
        state: "not-checked",
        reason: "consent-widened",
      }),
    );
  await setContent(window, [
    waiting("first", words.supported),
    waiting("second", words.unsupported),
  ]);
  const settings = new Y.Doc();
  writeContradictionWatch(settings.getMap("settings"), {
    at: checkedAt,
    documentName: "Harbour survey",
    claims: 2,
    checked: 0,
    contradicted: 0,
    cost: null,
    stop: { reason: "consent-widened" },
    smallModel: false,
  });
  await applySettings(window, Array.from(Y.encodeStateAsUpdate(settings)));
  const watched = (await checkCard(window)).getByTestId("contradictions-watched");
  await expect(watched.getByTestId("contradictions-watched-review")).toHaveText(words.review);
  await window.keyboard.press("Escape");

  await window.evaluate(
    async (id) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.allowDataFlow(
        "checks",
        id,
      ),
    serviceId,
  );
  const health = await checkCard(window);
  await expect(health.getByTestId("contradictions-watched-close")).toBeVisible();
  await expect(health.getByTestId("contradictions-watched")).not.toContainText(words.reason);
  await pointAndClick(window, health.getByTestId("health-toCheck"));
  const card = window.getByTestId("claim-card");
  await expect(card).toHaveAttribute("data-check", "not-checked");
  await expect(card.getByTestId("claim-review-consent")).toHaveCount(0);
  await expect(card).not.toContainText(words.reason);
  await screenshot(window, "allowed-not-checked-en");
  await pointAndClick(window, card.getByTestId("claim-check-again"));

  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(2, { timeout: 30_000 });
  await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
  await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
  await app.close();
});
