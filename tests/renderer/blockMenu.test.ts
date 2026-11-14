/**
 * A Block's one menu (#608): the handle's ⋯, a right-click and the context-menu key open the
 * menu registered for the `block` kind, whose items are commands with their own keys and ⌘K
 * entries. Each command here does what the handle's own items did: Include in context turns a
 * Block of the User's text out of the Question context and back, and Delete takes a Block away,
 * one step of the Note's Undo each.
 */
import { Editor, type Extension, type JSONContent } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { DOMParser } from "linkedom";
import { afterEach, beforeAll, expect, test } from "vitest";
import { INCLUDE_IN_CONTEXT_ATTRIBUTE, QUESTION_BLOCK } from "../../src/core/api";
import { readMindHandle } from "../../src/renderer/src/commands/handles";
import { buildMenu, isMenuItem } from "../../src/renderer/src/commands/menus";
import "../../src/renderer/src/commands/objectMenus";
import {
  type Command,
  type CommandContext,
  commands,
  offered,
} from "../../src/renderer/src/commands/registry";
import { BlockCommands } from "../../src/renderer/src/editor/blockCommands";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { BRIDGE_KEY, FILES_BRIDGE_KEY } from "../../src/shared/bridge";

function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}
const page = domDocument();
// The note's commands reach the store, which reads the bridge the preload exposes.
const bridge = new Proxy({}, { get: () => () => () => undefined });
Object.assign(page.defaultView, { [BRIDGE_KEY]: bridge, [FILES_BRIDGE_KEY]: bridge });
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const paragraph = (id: string, text: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text }],
});
const question = (id: string, text: string): JSONContent => ({
  type: QUESTION_BLOCK,
  attrs: { id },
  content: [{ type: "text", text }],
});

const editors: Editor[] = [];
let NoteKeymap: Extension;
let blockCommands: readonly Command[];
let blockIn: typeof import("../../src/renderer/src/commands/blocks").blockIn;
// The commands and the note's keys reach the bridge as they load, so they load once it is set.
beforeAll(async () => {
  const [keymap, blocks, footnotes] = await Promise.all([
    import("../../src/renderer/src/editor/noteKeymap"),
    import("../../src/renderer/src/commands/blocks"),
    import("../../src/renderer/src/commands/footnotes"),
  ]);
  NoteKeymap = keymap.NoteKeymap;
  blockCommands = blocks.blockCommands;
  blockIn = blocks.blockIn;
  for (const command of [...blocks.blockCommands, ...footnotes.footnoteCommands]) {
    commands.register(command);
  }
});
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  readMindHandle.current = null;
});

async function editorWith(blocks: JSONContent[]): Promise<Editor> {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...noteExtensions(), BlockCommands, NoteKeymap, UndoRedo],
    content: { type: "doc", content: blocks },
  });
  editors.push(editor);
  // The editor is made at once and tells its extensions so on the next turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return editor;
}

/** What the handle's menu is given: the Block it stands by as the focus. */
const menuOf = (id: string): CommandContext => ({
  selection: [],
  focus: { kind: "block", id },
  surface: "mind",
});

/** What ⌘K is given with the cursor in the Note in front. */
function paletteIn(editor: Editor): CommandContext {
  readMindHandle.current = { editor, mindId: "mind-1" } as unknown as NonNullable<
    typeof readMindHandle.current
  >;
  return {
    selection: [],
    focus: { kind: "mind", id: "mind-1" },
    surface: "palette",
    place: "note",
  };
}

const idsOf = (ctx: CommandContext) =>
  buildMenu("block", ctx).map((entry) => (isMenuItem(entry) ? entry.command.id : "—"));

const texts = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.forEach((node) => {
    found.push(node.textContent);
  });
  return found;
};

test("a Block's menu holds Include in context and Insert footnote, then Delete after a rule", async () => {
  const editor = await editorWith([paragraph("a", "First"), paragraph("b", "Second")]);
  expect(idsOf(menuOf("a"))).toEqual([
    "block.includeInContext",
    "footnote.insert",
    "—",
    "block.delete",
  ]);
  expect(editor.state.doc.childCount).toBe(2);
});

test("a Question has no context flag, so its menu is Delete and Insert footnote", async () => {
  const editor = await editorWith([
    question("q", "When do spring tides happen?"),
    paragraph("a", "Text"),
  ]);
  expect(idsOf(menuOf("q"))).not.toContain("block.includeInContext");
  expect(idsOf(menuOf("q")).at(-1)).toBe("block.delete");
  expect(editor.state.doc.childCount).toBe(2);
});

test("Include in context switches your text out of the Question context and back, one ⌘Z each", async () => {
  const editor = await editorWith([paragraph("a", "First"), paragraph("b", "Second")]);
  const command = blockCommands.find((each) => each.id === "block.includeInContext");
  if (!command) throw new Error("No command.");
  const ctx = menuOf("a");
  const included = () => editor.state.doc.child(0).attrs[INCLUDE_IN_CONTEXT_ATTRIBUTE];
  expect(command.checked?.(ctx)).toBe(true);

  await commands.run("block.includeInContext", ctx);
  expect(included()).toBe(false);
  expect(command.checked?.(ctx)).toBe(false);
  // The other Block is the same as it was.
  expect(editor.state.doc.child(1).attrs[INCLUDE_IN_CONTEXT_ATTRIBUTE]).not.toBe(false);

  editor.commands.undo();
  expect(included()).not.toBe(false);
  expect(command.checked?.(ctx)).toBe(true);
});

test("⌘K offers Include in context and Delete on the Block the cursor is in, only from the Note", async () => {
  const editor = await editorWith([paragraph("a", "First"), paragraph("b", "Second")]);
  editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 2);
  const palette = paletteIn(editor);
  const listed = commands.list(palette).map((command) => command.id);
  expect(listed).toContain("block.includeInContext");
  expect(listed).toContain("block.delete");
  // From a field, or with Documents picked, the cursor's Block isn't what is meant.
  expect(commands.list({ ...palette, place: "field" }).map((each) => each.id)).not.toContain(
    "block.delete",
  );
  expect(commands.list({ ...palette, place: null }).map((each) => each.id)).not.toContain(
    "block.includeInContext",
  );
  expect(
    commands
      .list({ ...palette, selection: [{ kind: "document", id: "d" }] })
      .map((each) => each.id),
  ).not.toContain("block.delete");
});

test("Delete from ⌘K takes away the Block the cursor is in, and one ⌘Z brings it back", async () => {
  const editor = await editorWith([paragraph("a", "First"), paragraph("b", "Second")]);
  editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 2);
  await commands.run("block.delete", paletteIn(editor));
  expect(texts(editor)).toEqual(["First"]);
  editor.commands.undo();
  expect(texts(editor)).toEqual(["First", "Second"]);
});

test("Delete from the keys takes away the Block at the cursor, as the menu names it", async () => {
  const editor = await editorWith([paragraph("a", "First"), paragraph("b", "Second")]);
  editor.commands.setTextSelection(2);
  const command = blockCommands.find((each) => each.id === "block.delete");
  if (!command) throw new Error("No command.");
  expect(offered(command, menuOf("b"))).toBe(true);
  await commands.run("block.delete", menuOf("a"));
  expect(texts(editor)).toEqual(["Second"]);
});

test("Delete from the keys acts in the pane the key was pressed in, with the same Note open in two panes", async () => {
  const blocks = [paragraph("a", "First"), paragraph("b", "Second")];
  const left = await editorWith(blocks);
  const right = await editorWith(blocks);
  const inFirst = 2;
  const inSecond = left.state.doc.child(0).nodeSize + 2;
  left.commands.setTextSelection(inFirst);
  right.commands.setTextSelection(inSecond);
  // Typing in the right pane: it has the focus, the left, which holds the Note first, hasn't.
  Object.defineProperty(right.view, "hasFocus", { value: () => true, configurable: true });
  const at = blockIn(menuOf("b"));
  Reflect.deleteProperty(right.view, "hasFocus");
  expect(at?.editor).toBe(right);
  at?.editor.commands.deleteBlock();
  expect(texts(left)).toEqual(["First", "Second"]);
  expect(texts(right)).toEqual(["First"]);
});

test("a menu that gives its own Delete deletes the Block it stands by, wherever the cursor is", async () => {
  const editor = await editorWith([paragraph("a", "First"), paragraph("b", "Second")]);
  editor.commands.setTextSelection(2);
  const second = editor.state.doc.child(0).nodeSize;
  await commands.run("block.delete", {
    ...menuOf("b"),
    here: { "block.delete": () => editor.commands.deleteBlock(second) },
  });
  expect(texts(editor)).toEqual(["First"]);
});

test("Delete is offered to no one outside the Note: a Block the window doesn't hold", async () => {
  const editor = await editorWith([paragraph("a", "First")]);
  const command = blockCommands.find((each) => each.id === "block.delete");
  if (!command) throw new Error("No command.");
  expect(offered(command, menuOf("gone"))).toBe(false);
  expect(editor.state.doc.childCount).toBe(1);
});
