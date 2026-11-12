import { expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * ⌘Z takes back what the User typed, never a check's result that landed since (#2988), in the
 * built app, whose editor syncs through y-tiptap as patched at install. A Note's paragraph holds
 * two checked sentences; the User types in the first; a newer result lands on the second; ⌘Z.
 * The second keeps the newer result, in the editor and in the core. A build without the fix fails
 * here before it can ship.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const check = (id: string, text: string, state: string, checkedAt: string) => ({
  id,
  request: "check-note",
  action: "check-against-documents",
  state,
  reason: null,
  detail: null,
  providerId: "provider",
  modelId: "model",
  text,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: true },
  versions: [],
  excluded: [],
  checkedAt,
});

/** The Note's document as the core holds it now. */
async function stored(window: Page, mindId: string): Promise<Y.Doc> {
  const state = await (await coreOf(window)).evaluate(
    async (core, id) => Array.from((await core.openMind(id)).state),
    mindId,
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(state));
  return doc;
}

/** The paragraph's text in a stored document, and where `words` start in it, or -1. */
function placeOf(doc: Y.Doc, words: string): { text: Y.XmlText | null; at: number } {
  for (const block of doc.getXmlFragment("blocks").toArray()) {
    const text = block instanceof Y.XmlElement ? block.get(0) : null;
    if (!(text instanceof Y.XmlText)) continue;
    const all = (text.toDelta() as { insert: string }[]).map((run) => run.insert).join("");
    if (all.includes(words)) return { text, at: all.indexOf(words) };
  }
  return { text: null, at: -1 };
}

/** The state of the check the core holds on `sentence`. */
async function stateOn(window: Page, mindId: string, sentence: string): Promise<string | null> {
  const { text, at } = placeOf(await stored(window, mindId), sentence);
  let offset = 0;
  for (const run of (text?.toDelta() ?? []) as {
    insert: string;
    attributes?: { claimCheck?: { state?: string } };
  }[]) {
    if (offset <= at && at < offset + run.insert.length)
      return run.attributes?.claimCheck?.state ?? null;
    offset += run.insert.length;
  }
  return null;
}

/** Sends a change to the core as one Yjs update, as a check's result lands or a Note is made. */
async function send(window: Page, mindId: string, update: Uint8Array) {
  await (await coreOf(window)).evaluate(
    async (core: CoreBridge, [id, change]) => core.applyMindUpdate(id, new Uint8Array(change)),
    [mindId, Array.from(update)] as const,
  );
}

for (const [language, first, second, gap, typed] of [
  ["en", "Revenue was 10 in May.", "Costs were 8 in May.", " ", "about "],
  ["zh-CN", "五月收入为10亿元。", "五月成本为8亿元。", "", "约"],
] as const) {
  test(`⌘Z after typing in a checked sentence leaves the result that landed on the next one since (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1280, 860);
      await dismissChatSetup(window);
      await setLanguage(window, language);

      // A Note whose paragraph holds the two sentences, each checked Supported, as the core
      // stores a check.
      const mindId = await (await coreOf(window)).evaluate(
        async (core) => (await core.createMind({ title: "Results" })).id,
      );
      const made = new Y.Doc();
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute("id", "results");
      const words = new Y.XmlText(`${first}${gap}${second}`);
      paragraph.insert(0, [words]);
      made.getXmlFragment("blocks").insert(0, [paragraph]);
      const at = "2026-11-12T09:00:00.000Z";
      words.format(0, first.length, { claimCheck: check("first", first, "supported", at) });
      words.format(first.length + gap.length, second.length, {
        claimCheck: check("second", second, "supported", at),
      });
      await send(window, mindId, Y.encodeStateAsUpdate(made));
      await (await coreOf(window)).evaluate(async (core, id) => core.closeMind(id), mindId);

      await window.getByTestId("mind-list-item").filter({ hasText: "Results" }).click();
      const editor = window.getByTestId("mind-editor");
      await expect(editor).toContainText(second);
      const secondMark = window.locator('[data-testid="claim-mark"][data-claim="second"]');
      await expect(secondMark).toHaveAttribute("data-check", "supported");

      // The User clicks just before the first sentence's figure and types.
      const point = await editor.evaluate((root, sentence) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent?.indexOf(sentence) ?? -1;
          if (at < 0) continue;
          const range = document.createRange();
          const figure = at + sentence.indexOf("10");
          range.setStart(node, figure);
          range.setEnd(node, figure + 1);
          const box = range.getBoundingClientRect();
          return { x: box.left + 1, y: box.top + box.height / 2 };
        }
        return null;
      }, first);
      if (!point) throw new Error("The first sentence isn't shown.");
      await window.mouse.move(point.x, point.y, { steps: 6 });
      await window.mouse.click(point.x, point.y);
      await window.keyboard.type(typed);
      await expect(editor).toContainText(`${typed}10`);
      await expect
        .poll(async () => placeOf(await stored(window, mindId), `${typed}10`).at)
        .not.toBe(-1);

      // A newer result lands on the second sentence.
      const doc = await stored(window, mindId);
      const before = Y.encodeStateVector(doc);
      const landing = placeOf(doc, second);
      landing.text?.format(landing.at, second.length, {
        claimCheck: check("second", second, "contradicted", "2026-11-12T09:01:00.000Z"),
      });
      await send(window, mindId, Y.encodeStateAsUpdate(doc, before));
      await expect(secondMark).toHaveAttribute("data-check", "contradicted");

      await window.keyboard.press("ControlOrMeta+z");
      await expect(editor).not.toContainText(`${typed}10`);
      await expect(editor).toContainText(first);
      await expect(secondMark).toHaveAttribute("data-check", "contradicted");
      await expect.poll(() => stateOn(window, mindId, second)).toBe("contradicted");
    } finally {
      await app.close();
    }
  });
}
