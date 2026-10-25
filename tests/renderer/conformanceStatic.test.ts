import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { commands } from "../../src/renderer/src/commands/registry";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/*
 * Rules of docs/agents/interaction.md that a scan of the source can hold: no
 * "Back to…" (rule 3), no confirmation that a command would take back (rule 4),
 * and no right-click or drag of its own (rule 13). New code that breaks one
 * fails here; what `main` already had is listed with the issue that ends it, and
 * a fix takes its line out.
 */

const ROOT = join(__dirname, "../..");

interface Source {
  /** From the repository's root, with "/" on every system. */
  path: string;
  text: string;
}

function sourcesIn(folder: string): Source[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sourcesIn(path);
    if (!/\.tsx?$/.test(name)) return [];
    return [{ path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }];
  });
}

/** What is new, and what is on the list of known ones but no longer there. */
function violations(
  found: readonly string[],
  allowed: readonly string[],
  known: Record<string, string>,
): string[] {
  return [
    ...found
      .filter((each) => !allowed.includes(each) && !(each in known))
      .map((each) => `${each}: breaks the rule`),
    ...Object.keys(known)
      .filter((each) => !found.includes(each))
      .map((each) => `${each}: fixed, so take it off the list of known ones`),
  ];
}

const filesWith = (files: readonly Source[], pattern: RegExp) =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

const renderer = sourcesIn(join(ROOT, "src/renderer/src"));

describe("the right-click", () => {
  // The object's menu opens from `useObjectMenu` alone, so a right-click opens the menu the ⋯
  // opens, in one order. Only that hook may handle it, not the rest of its file. A handler by
  // any name counts: the React prop, the attribute, the event. (The key called "ContextMenu"
  // opens the menu from the keyboard, and isn't one.)
  const OWNER = "src/renderer/src/components/ObjectMenu.tsx";
  const HOOK = /export function useObjectMenu\b[\s\S]*?\n}\n/;
  const RIGHT_CLICK = /onContextMenu|oncontextmenu|\bcontextmenu\b/;
  const KNOWN: Record<string, string> = {
    "src/renderer/src/editor/tableCommands.ts":
      "a table's right-click opens the Block's menu from the note's own listener (#608)",
  };

  const handlers = (files: readonly Source[]) =>
    filesWith(
      files.map((file) =>
        file.path === OWNER ? { ...file, text: file.text.replace(HOOK, "") } : file,
      ),
      RIGHT_CLICK,
    );

  test("is handled in one place: no onContextMenu outside useObjectMenu", () => {
    expect(violations(handlers(renderer), [], KNOWN)).toEqual([]);
  });

  test("fails a handler anywhere else, the hook's own file included, and a known one that is gone", () => {
    const hook = "export function useObjectMenu(target) {\n  return { onContextMenu() {} };\n}\n";
    const files = [
      { path: "a.tsx", text: "<li onContextMenu={open} />" },
      { path: "b.ts", text: "view.dom.addEventListener('contextmenu', open)" },
      { path: "c.ts", text: "export const open = 1" },
      { path: OWNER, text: hook },
    ];
    const found = handlers(files);
    expect(violations(found, [], {})).toEqual(["a.tsx: breaks the rule", "b.ts: breaks the rule"]);
    expect(violations(found, ["a.tsx"], { "b.ts": "an issue", "d.ts": "an issue" })).toEqual([
      "d.ts: fixed, so take it off the list of known ones",
    ]);
    const beside = `${hook}export function ObjectMenu() {\n  return <li onContextMenu={open} />;\n}\n`;
    expect(handlers([{ path: OWNER, text: beside }])).toEqual([OWNER]);
  });
});

describe("dragging", () => {
  // Dragging is built once, in the drag layer, so every target says what a drop does, shows
  // Undo and has a menu twin. The note's own dragging stays ProseMirror's, undone by the note's
  // ⌘Z: its block handle, and the Word blocks and pictures that move inside the text.
  const LAYER = [
    "src/renderer/src/dragDrop.ts",
    "src/renderer/src/editor/BlockHandle.tsx",
    "src/renderer/src/editor/wordSchema.ts",
  ];
  const KNOWN: Record<string, string> = {};
  // The attribute turned on; `draggable={false}` and `draggable: false` keep something still.
  const DRAGGABLE = /\bdraggable\b(?!\s*(?:=\s*\{\s*false\s*\}|:\s*false))/;

  test("is the drag layer's alone: no draggable outside it", () => {
    expect(violations(filesWith(renderer, DRAGGABLE), LAYER, KNOWN)).toEqual([]);
  });

  test("fails a row made draggable, and lets one be kept still", () => {
    const found = filesWith(
      [
        { path: "a.tsx", text: "<li draggable onDragStart={start} />" },
        { path: "b.tsx", text: "<li draggable={true} />" },
        { path: "c.tsx", text: '<img draggable={false} alt="" />' },
        { path: "d.ts", text: "export const schema = { draggable: false };" },
      ],
      DRAGGABLE,
    );
    expect(violations(found, [], {})).toEqual(["a.tsx: breaks the rule", "b.tsx: breaks the rule"]);
  });
});

describe("a label that says Back to", () => {
  // Nothing replaces the Mind the User is in, so nothing says how to go back to it.
  const ALLOWED: Record<string, string> = {
    // Expand lays one table over its own card, the note held still behind it, and Esc returns:
    // the owner's design (DESIGN.md, Comparison table).
    "comparison.back": "the comparison table's Expand",
    // A link in an exported HTML file, from a footnote back to its text: the file has no Mind.
    "export.html.back": "a footnote's link back in an exported file",
    // A composer chip's ×: the Search scope goes back, in place, to the one it narrowed; no
    // screen or Mind is left.
    "composer.scope.back": "a narrowed Search scope back to the one it narrowed",
    "composer.scope.backAll": "a narrowed Search scope back to All Documents",
  };
  const BACK_TO = { en: /^[←<\s]*Back to\b/i, "zh-CN": /^[←<\s]*返回(?!$)/u } as const;

  function backLabels(
    dictionaries: Record<keyof typeof BACK_TO, Record<string, string>>,
    allowed: readonly string[],
  ): string[] {
    return (Object.keys(BACK_TO) as (keyof typeof BACK_TO)[]).flatMap((language) =>
      Object.entries(dictionaries[language])
        .filter(([key, text]) => BACK_TO[language].test(text) && !allowed.includes(key))
        .map(([key, text]) => `${language} ${key}: ${text}`),
    );
  }

  test("is nowhere in the interface, in English or Chinese", () => {
    expect(backLabels({ en, "zh-CN": zhCN }, Object.keys(ALLOWED))).toEqual([]);
  });

  test("is allowed only for labels that are still there", () => {
    expect(Object.keys(ALLOWED).filter((key) => !(key in en))).toEqual([]);
  });

  test("is nowhere in the code either", () => {
    const literals = filesWith(renderer, /["'`>]\s*Back to\b/);
    expect(literals).toEqual([]);
  });

  test("fails one in either language, and one allowed by its key", () => {
    const dictionaries = {
      en: { "tab.back": "Back to Library", "card.back": "← Back to note", "tab.go": "Go back" },
      "zh-CN": { "tab.back": "返回资料库", "card.back": "返回笔记", "tab.go": "返回" },
    };
    expect(backLabels(dictionaries, [])).toEqual([
      "en tab.back: Back to Library",
      "en card.back: ← Back to note",
      "zh-CN tab.back: 返回资料库",
      "zh-CN card.back: 返回笔记",
    ]);
    expect(backLabels(dictionaries, ["tab.back", "card.back"])).toEqual([]);
  });
});

describe("a question about deleting", () => {
  // Deleting a Mind, Chat, Document, Folder or Tag asks nothing: it goes to Recently deleted,
  // with Undo. Only what can't be taken back asks, and says what is lost: a command marked
  // `reversible: { confirm }`, whose text and question share a key prefix
  // (`deleted.confirm.*`, `linkedFolders.unlink.*`). The one exception is a delete the
  // assistant starts, which always waits for the User (DESIGN.md, Approval; #1274).
  const KNOWN: Record<string, string> = {};
  const ASSISTANT_DELETES = [
    "commands.ask.change.document.delete",
    "commands.ask.change.document.delete.one",
    "commands.ask.change.mind.delete",
    "commands.ask.change.mind.delete.one",
  ];
  const ASKS = /^(Delete|Remove|Unlink|Empty|Erase)\b[^?]*\?/;

  function questions(
    messages: Record<string, string>,
    confirmKeys: readonly string[],
    known: Record<string, string>,
  ): string[] {
    const prefixes = confirmKeys.map((key) => key.slice(0, key.lastIndexOf(".") + 1));
    const found = Object.entries(messages)
      .filter(
        ([key, text]) => ASKS.test(text) && !prefixes.some((prefix) => key.startsWith(prefix)),
      )
      .map(([key]) => key);
    return violations(found, ASSISTANT_DELETES, known);
  }

  const asking = () =>
    commands
      .all()
      .flatMap((command) => (command.reversible === true ? [] : [command.reversible.confirm]));

  beforeAll(async () => {
    // The commands reach the store, which reads the bridge the preload exposes.
    const bridge = new Proxy({}, { get: () => () => () => undefined });
    (globalThis as unknown as { window: unknown }).window = {
      incarnamind: bridge,
      incarnamindFiles: bridge,
    };
    await import("../../src/renderer/src/commands/app");
  });

  test("has an irreversible command behind it", () => {
    expect(asking().length).toBeGreaterThan(0);
    expect(questions(en, asking(), KNOWN)).toEqual([]);
  });

  test("fails a question no command stands behind, and one that is no longer asked", () => {
    const messages = {
      "deleted.confirm.title.one": "Delete “{name}” permanently?",
      "folder.confirm.title": "Delete “{name}”?",
      "tag.removed": "Tag removed",
    };
    expect(questions(messages, ["deleted.confirm.foot"], {})).toEqual([
      "folder.confirm.title: breaks the rule",
    ]);
    expect(questions(messages, ["deleted.confirm.foot", "folder.confirm.body"], {})).toEqual([]);
    expect(questions({}, [], { "gone.confirm": "an issue" })).toEqual([
      "gone.confirm: fixed, so take it off the list of known ones",
    ]);
  });
});
