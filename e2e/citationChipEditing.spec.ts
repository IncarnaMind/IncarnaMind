import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { callTool, connectCanvasAgent } from "./canvases";

/*
 * What a User can do with a Citation's chip in a Note's text, by the keys and the mouse: an arrow
 * key reaches it, Shift with an arrow selects it, a drag across it selects it, and Backspace,
 * Delete, cut and paste take it away or move it, so a Citation after a full stop can be put back
 * before it. A run of Citations that shows as one chip steps past in one press and goes whole with
 * Backspace or Delete, and a drag across it selects it. A click opens a chip's card.
 */

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

/** Four quotes: the last three are in one paragraph of the file, so their Citations are one place. */
const QUOTES = [
  "Recyclers collect scrap metal and plastic from the harbour towns every week",
  "Most of the plastic they collect was never used for food",
  "At the time, the recyclers did not use any artificial intelligence",
  "Smaller yards sorted by hand and kept their books on paper",
];
const FILE = [`${QUOTES[0]}.`, `${QUOTES[1]}. ${QUOTES[2]}. ${QUOTES[3]}.`].join("\n\n");

/** The Note's paragraphs as text, each Citation as [n] for the n-th line it quotes. */
const paragraphs = (window: Page) =>
  window.getByTestId("mind-editor").evaluate((dom, lines) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    const found: string[] = [];
    state.doc.forEach((block, _offset, index) => {
      if (index === 0) return;
      let line = "";
      block.forEach((node) => {
        const at = lines.findIndex((each) =>
          String(node.attrs.quote).startsWith(each.slice(0, 30)),
        );
        line += node.type.name === "citation" ? `[${at + 1}]` : (node.text ?? "");
      });
      found.push(line);
    });
    return found;
  }, QUOTES);

const selection = (window: Page) =>
  window.getByTestId("mind-editor").evaluate((dom) => {
    const { selection: chosen, doc } = (dom as unknown as { editor: Editor }).editor.state;
    return {
      kind: String(chosen.toJSON().type),
      from: chosen.from,
      to: chosen.to,
      text: doc.textBetween(chosen.from, chosen.to, "|", "#"),
    };
  });

/** Where the paragraph at `index` starts, and where its Citations are. */
const placesIn = (window: Page, index: number) =>
  window.getByTestId("mind-editor").evaluate((dom, at) => {
    const { doc } = (dom as unknown as { editor: Editor }).editor.state;
    let start = 0;
    const citations: number[] = [];
    doc.forEach((block, offset, position) => {
      if (position !== at) return;
      start = offset + 1;
      block.forEach((node, inside) => {
        if (node.type.name === "citation") citations.push(offset + 1 + inside);
      });
    });
    return { start, citations };
  }, index);

/** The caret put where a click would leave it; the keys and the drags after it are real. */
async function caretTo(window: Page, at: number) {
  const editor = window.getByTestId("mind-editor");
  await editor.evaluate((dom, pos) => {
    (dom as unknown as { editor: Editor }).editor.chain().focus().setTextSelection(pos).run();
  }, at);
  await expect(editor).toBeFocused();
}

async function openNote(language: "en" | "zh-CN") {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, 1100, 700);
  const path = join(sources, "Recycling.md");
  await writeFile(path, FILE);
  await window.evaluate(async (file) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.addDocuments([file], {});
  }, path);
  await expectReadyDocuments(window, 1);
  const agent = await connectCanvasAgent(window);
  try {
    const found = await callTool<{ passages: { passageId: string }[] }>(agent, "search", {
      query: "recyclers plastic",
    });
    const cited = await callTool<{ citations: { cite: string | null }[] }>(agent, "cite", {
      citations: QUOTES.flatMap((quote) =>
        found.passages.map(({ passageId }) => ({ passageId, quote })),
      ),
    });
    const cites = QUOTES.map((_, at) => {
      const own = cited.citations.slice(
        at * found.passages.length,
        (at + 1) * found.passages.length,
      );
      return own.find((each) => each.cite !== null)?.cite ?? "";
    });
    await callTool(agent, "create_mind", {
      title: "Chips",
      markdown: [
        `One chip stands here ${cites[0]} in the middle of a sentence.`,
        `A run of three stands at the end ${cites[1]}${cites[2]}${cites[3]}.`,
        "Plain closing words with no chip at all.",
      ].join("\n\n"),
    });
  } finally {
    await agent.close();
  }
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: "Chips" }));
  const editor = window.getByTestId("mind-editor");
  await expect(editor.getByTestId("citation")).toHaveCount(4);
  return { app, window, editor };
}

const FIRST = "One chip stands here [1] in the middle of a sentence.";
const RUN = "A run of three stands at the end [2][3][4].";
const LAST = "Plain closing words with no chip at all.";

test("one chip: the keys and the mouse select it, and cut, paste, Backspace and Delete move or take it", async () => {
  test.setTimeout(240_000);
  const { app, window, editor } = await openNote("en");
  try {
    const mod = "ControlOrMeta";
    const one = await placesIn(window, 1);
    const [chip] = one.citations;
    if (chip === undefined) throw new Error("The first paragraph has no Citation.");
    expect(await paragraphs(window)).toEqual([FIRST, RUN, LAST]);

    // An arrow key reaches the chip: one press selects it, the next steps past it.
    await caretTo(window, chip);
    await window.keyboard.press("ArrowRight");
    expect(await selection(window)).toMatchObject({ kind: "node", from: chip, to: chip + 1 });
    await window.keyboard.press("ArrowRight");
    expect(await selection(window)).toMatchObject({ kind: "text", from: chip + 1, to: chip + 1 });

    // Shift with an arrow selects it, from either side; Backspace takes it with one Undo.
    await caretTo(window, chip + 1);
    await window.keyboard.press("Shift+ArrowLeft");
    expect(await selection(window)).toMatchObject({ from: chip, to: chip + 1 });
    await window.keyboard.press("Backspace");
    expect(await paragraphs(window)).toEqual([FIRST.replace("[1]", ""), RUN, LAST]);
    await window.keyboard.press(`${mod}+z`);
    expect(await paragraphs(window)).toEqual([FIRST, RUN, LAST]);

    // Backspace after it and Delete before it each take it.
    await caretTo(window, chip + 1);
    await window.keyboard.press("Backspace");
    await expect(editor.getByTestId("citation")).toHaveCount(3);
    await window.keyboard.press(`${mod}+z`);
    await caretTo(window, chip);
    await window.keyboard.press("Delete");
    await expect(editor.getByTestId("citation")).toHaveCount(3);
    await window.keyboard.press(`${mod}+z`);
    await expect(editor.getByTestId("citation")).toHaveCount(4);

    // Cut and paste move it, and it stays a Citation: put back before the full stop of the sentence.
    await caretTo(window, chip);
    await window.keyboard.press("Shift+ArrowRight");
    await window.keyboard.press(`${mod}+x`);
    expect((await paragraphs(window))[0]).toBe(
      "One chip stands here  in the middle of a sentence.",
    );
    const end =
      (await placesIn(window, 1)).start +
      "One chip stands here  in the middle of a sentence".length;
    await caretTo(window, end);
    await window.keyboard.press(`${mod}+v`);
    expect((await paragraphs(window))[0]).toBe(
      "One chip stands here  in the middle of a sentence[1].",
    );

    // A drag across it selects it with the words around it.
    for (let undone = 0; undone < 6 && (await paragraphs(window))[0] !== FIRST; undone++) {
      await window.keyboard.press(`${mod}+z`);
    }
    expect((await paragraphs(window))[0]).toBe(FIRST);
    const box = await editor
      .getByTestId("citation-chip")
      .filter({ visible: true })
      .first()
      .boundingBox();
    if (!box) throw new Error("The chip isn't shown.");
    const y = box.y + box.height / 2;
    await window.mouse.move(box.x - 25, y);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width + 30, y, { steps: 8 });
    await window.mouse.up();
    const dragged = await selection(window);
    expect(dragged.text).toContain("#");
    expect(dragged.from).toBeLessThan(chip);
    expect(dragged.to).toBeGreaterThan(chip + 1);
  } finally {
    await app.close();
  }
});

test("a run that shows as one chip: one press steps past it, Backspace and Delete take it whole, and a drag across it selects it for cut and paste", async () => {
  test.setTimeout(240_000);
  const { app, window, editor } = await openNote("en");
  try {
    const mod = "ControlOrMeta";
    const { citations } = await placesIn(window, 2);
    const [first, , last] = citations;
    if (first === undefined || last === undefined) throw new Error("The run isn't there.");

    await caretTo(window, first);
    await window.keyboard.press("ArrowRight");
    expect((await selection(window)).from).toBe(last + 1);

    await caretTo(window, last + 1);
    await window.keyboard.press("Backspace");
    await expect(editor.getByTestId("citation")).toHaveCount(1);
    expect((await paragraphs(window))[1]).toBe("A run of three stands at the end .");
    await window.keyboard.press(`${mod}+z`);
    await expect(editor.getByTestId("citation")).toHaveCount(4);
    await caretTo(window, first);
    await window.keyboard.press("Delete");
    await expect(editor.getByTestId("citation")).toHaveCount(1);
    await window.keyboard.press(`${mod}+z`);

    // A drag across the chip selects the run whole, and cut and paste move it as it is.
    const box = await editor
      .getByTestId("citation-chip")
      .filter({ visible: true })
      .nth(1)
      .boundingBox();
    if (!box) throw new Error("The run's chip isn't shown.");
    const y = box.y + box.height / 2;
    await window.mouse.move(box.x - 25, y);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width + 12, y, { steps: 8 });
    await window.mouse.up();
    await window.keyboard.press(`${mod}+x`);
    await expect(editor.getByTestId("citation")).toHaveCount(1);
    const third = await placesIn(window, 3);
    await caretTo(window, third.start + 5);
    await window.keyboard.press(`${mod}+v`);
    await expect(editor.getByTestId("citation")).toHaveCount(4);
    expect((await paragraphs(window))[2]).toContain("[2][3][4]");
  } finally {
    await app.close();
  }
});
