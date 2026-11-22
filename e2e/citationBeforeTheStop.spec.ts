import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { callTool, connectCanvasAgent } from "./canvases";

/*
 * A Citation an outside agent adds to a sentence stands before the sentence's full stop, after the
 * Citations it already has, and a Passage the sentence already cites is not cited a second time
 * (the sentence the User sees reads "…every week [1][2]. …", never "…every week [1][2]. [1][2]").
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save stills of the paragraph.
 */

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

const CASES = {
  en: {
    file: "Recycling.md",
    title: "Recyclers",
    lines: [
      "Recyclers collect scrap metal and plastic from the harbour towns every week.",
      "Most of the plastic they collect was never used for food.",
      "At the time, the recyclers did not use any artificial intelligence.",
      "Smaller yards sorted by hand and kept their books on paper.",
    ],
    quotes: [
      "Recyclers collect scrap metal and plastic from the harbour towns every week",
      "Most of the plastic they collect was never used for food",
      "At the time, the recyclers did not use any artificial intelligence",
      "Smaller yards sorted by hand and kept their books on paper",
    ],
    first: "Recyclers collect scrap metal and plastic every week",
    second: "At the time they used no AI",
    stop: ".",
    space: " ",
    query: "recyclers plastic",
  },
  "zh-CN": {
    file: "回收.md",
    title: "回收商",
    lines: [
      "回收商每周从港口城镇收集废金属和塑料。",
      "他们收集的塑料大部分从未用于食品。",
      "当时回收商没有使用任何人工智能。",
      "较小的回收场靠手工分拣，账本也记在纸上。",
    ],
    quotes: [
      "回收商每周从港口城镇收集废金属和塑料",
      "他们收集的塑料大部分从未用于食品",
      "当时回收商没有使用任何人工智能",
      "较小的回收场靠手工分拣，账本也记在纸上",
    ],
    first: "回收商每周收集废金属和塑料",
    second: "当时他们没有使用人工智能",
    stop: "。",
    space: "",
    query: "回收商 塑料",
  },
} as const;

/** The Note's first paragraph: its words, each Citation as [the number its chip shows]. */
const written = (window: Page) =>
  window.getByTestId("mind-editor").evaluate((dom) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    const quotes = new Map<string, number>();
    let line = "";
    state.doc.child(1).forEach((node) => {
      if (node.type.name !== "citation") {
        line += node.text ?? "";
        return;
      }
      const quote = String(node.attrs.quote);
      if (!quotes.has(quote)) quotes.set(quote, quotes.size + 1);
      line += `[${quotes.get(quote)}]`;
    });
    return line;
  });

async function shot(window: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await motionSettled(window);
  await window
    .getByTestId("mind-editor")
    .locator("p")
    .first()
    .screenshot({ path: join(SHOTS, `${name}.png`) });
  await window.screenshot({ path: join(SHOTS, `${name}-window.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`an agent's added Citations stand before the stop and repeat none (${language})`, async () => {
    test.setTimeout(240_000);
    const words = CASES[language];
    const { app, window } = await launchApp(dataDir, { home });
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1100, 700);
      const path = join(sources, words.file);
      await writeFile(path, words.lines.join("\n\n"));
      await window.evaluate(async (file) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.addDocuments([file], {});
      }, path);
      await expectReadyDocuments(window, 1);
      const agent = await connectCanvasAgent(window);
      let cites: string[];
      let asWritten = "";
      try {
        const found = await callTool<{ passages: { passageId: string }[] }>(agent, "search", {
          query: words.query,
        });
        const cited = await callTool<{ citations: { cite: string | null }[] }>(agent, "cite", {
          citations: words.quotes.flatMap((quote) =>
            found.passages.map(({ passageId }) => ({ passageId, quote })),
          ),
        });
        // One Citation for each quote: the first Passage that holds it.
        cites = words.quotes.map((_, at) => {
          const own = cited.citations.slice(
            at * found.passages.length,
            (at + 1) * found.passages.length,
          );
          const token = own.find((each) => each.cite !== null)?.cite;
          if (!token) throw new Error(`No Passage holds quote ${at + 1}.`);
          return token;
        });
        const [one, two, three, four] = cites;
        const { mindId } = await callTool<{ mindId: string }>(agent, "create_mind", {
          title: words.title,
          markdown: `${words.first}${words.space}${one}${two}${words.stop}${words.space}${words.second}${words.space}${three}${words.stop}`,
        });
        await pointAndClick(
          window,
          window.getByTestId("mind-list-item").filter({ hasText: words.title }),
        );
        await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(3);
        await shot(window, `${language}-1-written`);
        asWritten = await written(window);

        // The agent has the Note checked, then adds the Passages it found, after the stops, as an
        // English footnote goes, and repeats the two its first sentence already cites.
        const read = await callTool<{ version: string }>(agent, "read_mind", {
          mindId,
          named: true,
        });
        await callTool(agent, "propose_changes", {
          mindId,
          version: read.version,
          changes: [
            {
              paragraph: "¶1",
              text: `${words.first}${words.space}${one}${two}${words.stop}${words.space}${one}${two}${words.space}${words.second}${words.space}${three}${words.stop}${words.space}${four}`,
            },
          ],
        });
      } finally {
        await agent.close();
      }
      await expect.poll(() => written(window)).not.toBe(asWritten);
      await shot(window, `${language}-2-agent-added`);

      const { first, second, stop, space } = words;
      expect(await written(window)).toBe(
        `${first}${space}[1][2]${stop}${space}${second}${space}[3][4]${stop}`,
      );
    } finally {
      await app.close();
    }
  });
}
