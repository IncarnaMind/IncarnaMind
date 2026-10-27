import { beforeAll, describe, expect, test, vi } from "vitest";
import { keysForm, keysLabel, keysOn, pressed } from "../../src/renderer/src/commands/keys";
import {
  type Command,
  type CommandContext,
  commands,
  labelOf,
  offered,
} from "../../src/renderer/src/commands/registry";
import type { ObjectRef } from "../../src/renderer/src/objects";
import { windowKeyForms } from "../../src/renderer/src/windowKeys";
import { MENU_COMMANDS, type MenuCommandId } from "../../src/shared/commands";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { defaultHelpKeys, HELP_SHORTCUTS } from "../../src/shared/meetingHelp";

/*
 * Every command the app has: no key bound twice where both commands could act,
 * and the keys of text kept for text (docs/agents/interaction.md, rule 7), and
 * what a few commands do. What each command says and is marked as is in
 * conformance.test.ts.
 */

const LANGUAGES = ["en", "zh-CN"] as const;
const SYSTEMS = [
  { name: "macOS", mac: true },
  { name: "Windows and Linux", mac: false },
] as const;
const NOWHERE: CommandContext = { selection: [], focus: null, surface: "mind" };

const translator =
  (language: (typeof LANGUAGES)[number]) => (key: MessageKey, params?: MessageParams) =>
    translate(language, key, params);

/** Keys that mean something while the User types: editing, moving the caret, and the note's formatting. */
const TEXT_KEYS = [
  "CmdOrCtrl+A",
  "CmdOrCtrl+C",
  "CmdOrCtrl+V",
  "CmdOrCtrl+X",
  "CmdOrCtrl+Z",
  "CmdOrCtrl+Shift+Z",
  "CmdOrCtrl+Y",
  "CmdOrCtrl+Backspace",
  "CmdOrCtrl+Delete",
  "CmdOrCtrl+Left",
  "CmdOrCtrl+Right",
  "CmdOrCtrl+Up",
  "CmdOrCtrl+Down",
  "Alt+Backspace",
  "Alt+Left",
  "Alt+Right",
  "CmdOrCtrl+B",
  "CmdOrCtrl+I",
  "CmdOrCtrl+Shift+S",
  "CmdOrCtrl+Shift+H",
];

let all: Command[];

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  all = commands.all();
});

describe("New Folder with these", () => {
  const selecting = (...refs: [ObjectRef["kind"], string][]): CommandContext => ({
    selection: refs.map(([kind, id]) => ({ kind, id })),
    focus: null,
    surface: "sidebar",
  });
  const command = () => {
    const found = commands.get("folder.newWith");
    if (!found) throw new Error("There is no New Folder with these.");
    return found;
  };
  const saysIn = (ctx: CommandContext, language: (typeof LANGUAGES)[number]) =>
    labelOf(command(), ctx, translator(language));

  test("is offered for Documents and Minds, and only when there are some", () => {
    expect(offered(command(), NOWHERE)).toBe(false);
    expect(offered(command(), selecting(["document", "a"]))).toBe(true);
    expect(offered(command(), selecting(["mind", "m"], ["document", "a"]))).toBe(true);
    expect(offered(command(), selecting(["folder", "f"]))).toBe(false);
    expect(offered(command(), selecting(["document", "a"], ["tag", "t"]))).toBe(false);
  });

  test("says how many it takes, in English and in Chinese", () => {
    const three = selecting(["document", "a"], ["document", "b"], ["document", "c"]);
    expect(saysIn(NOWHERE, "en")).toBe("New Folder with these");
    expect(saysIn(selecting(["document", "a"]), "en")).toBe("New Folder with this Document");
    expect(saysIn(selecting(["mind", "m"]), "en")).toBe("New Folder with this note");
    expect(saysIn(three, "en")).toBe("New Folder with 3 Documents");
    expect(saysIn(selecting(["mind", "m"], ["mind", "n"]), "en")).toBe("New Folder with 2 notes");
    expect(saysIn(selecting(["mind", "m"], ["document", "a"]), "en")).toBe(
      "New Folder with 2 items",
    );
    expect(saysIn(three, "zh-CN")).toBe("新建文件夹并放入 3 个文档");
    expect(saysIn(selecting(["mind", "m"], ["document", "a"]), "zh-CN")).toBe(
      "新建文件夹并放入 2 项",
    );
  });

  describe("from the keys on a row", () => {
    const row = (kind: ObjectRef["kind"], id: string, surface: CommandContext["surface"]) => ({
      selection: [],
      focus: { kind, id },
      surface,
    });

    test("act for the sidebar's selection when it holds the row, and for the row alone when not", async () => {
      const { useSelection } = await import("../../src/renderer/src/selection");
      const { useAppStore } = await import("../../src/renderer/src/store");
      const createFolder = vi.fn(async () => "n");
      useAppStore.setState({ createFolder });
      const { choose, toggle } = useSelection.getState();
      choose("sidebar", { kind: "document", id: "a" });
      toggle("sidebar", { kind: "mind", id: "m" });
      toggle("sidebar", { kind: "document", id: "b" });

      expect(saysIn(row("document", "a", "sidebar") as CommandContext, "en")).toBe(
        "New Folder with 3 items",
      );
      expect(saysIn(row("document", "z", "sidebar") as CommandContext, "en")).toBe(
        "New Folder with this Document",
      );
      // The selection belongs to the sidebar: from the Library the row stands alone.
      expect(saysIn(row("document", "a", "library") as CommandContext, "en")).toBe(
        "New Folder with this Document",
      );

      await commands.run("folder.newWith", row("mind", "m", "sidebar") as CommandContext);
      expect(createFolder).toHaveBeenCalledWith({ mindIds: ["m"], documentIds: ["a", "b"] });
      // Once its items are in the Folder the selection is spent.
      expect(useSelection.getState().items).toEqual([]);
    });

    test("do nothing from a place that isn't a row, or for a Folder", () => {
      expect(offered(command(), { selection: [], focus: null, surface: "sidebar" })).toBe(false);
      expect(offered(command(), row("folder", "f", "sidebar"))).toBe(false);
    });
  });
});

describe("Output location", () => {
  const command = () => {
    const found = commands.get("settings.outputLocation");
    if (!found) throw new Error("There is no Output location command.");
    return found;
  };

  test("is in ⌘K named for the switches it opens, and says where they are, in both languages", () => {
    expect(labelOf(command(), NOWHERE, translator("en"))).toBe("New files in Linked folders");
    expect(command().purpose && translator("en")(command().purpose as MessageKey)).toBe(
      "Output location",
    );
    expect(labelOf(command(), NOWHERE, translator("zh-CN"))).toBe("在关联文件夹中添加文件");
  });

  test("opens where files are saved, as a Linked folder's not-checked line does", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    const openSettings = useAppStore.getState().openSettings;
    const opened = vi.fn();
    useAppStore.setState({ openSettings: opened });
    try {
      await commands.run("settings.outputLocation", NOWHERE);
      expect(opened.mock.calls).toEqual([["general", "output-location"]]);
    } finally {
      useAppStore.setState({ openSettings });
    }
  });
});

/**
 * In the note, the note's own keymap tries a Block's command first, and the window's acts where
 * it isn't offered: ⌘K edits the link on selected text, and opens ⌘K anywhere else.
 */
const blockFirst = (window: Command, block: Command) =>
  !window.appliesTo &&
  block.appliesTo?.every((kind) => kind === "block") === true &&
  block.when !== undefined;

describe("shortcuts", () => {
  test.each(SYSTEMS)("no keys are bound twice where both commands can act, on $name", ({ mac }) => {
    const bound = all.filter((command) => command.shortcut);
    const formsOf = (command: Command) => {
      const shortcut = command.shortcut;
      if (!shortcut || (shortcut.macOnly && !mac)) return [];
      const keys = [
        keysOn(shortcut.keys, mac),
        ...(!mac && shortcut.alsoOther ? [shortcut.alsoOther] : []),
        ...(shortcut.also ? [shortcut.also] : []),
      ];
      return keys.map((each) => keysForm(each, mac));
    };
    for (const [index, one] of bound.entries()) {
      for (const other of bound.slice(index + 1)) {
        const sameKeys = formsOf(one).some((form) => formsOf(other).includes(form));
        // Commands for different kinds of object never act on the same focus.
        const overlap =
          !blockFirst(one, other) &&
          !blockFirst(other, one) &&
          (!one.appliesTo ||
            !other.appliesTo ||
            one.appliesTo.some((kind) => other.appliesTo?.includes(kind)));
        expect(sameKeys && overlap, `${one.id} and ${other.id}`).toBe(false);
      }
    }
  });

  test.each(SYSTEMS)(
    "no default meeting key is one of the window's own (commands, menu and note editor), and Windows and Linux have none, on $name",
    ({ mac }) => {
      const own = windowKeyForms(mac);
      expect(own.has(keysForm("CmdOrCtrl+Shift+P", mac)), "a command's keys").toBe(true);
      expect(own.has(keysForm("CmdOrCtrl+Shift+E", mac)), "the menu's keys").toBe(true);
      expect(own.has(keysForm("CmdOrCtrl+B", mac)), "the editor's keys").toBe(true);
      expect(own.has("ctrl+shift+Digit9") || mac, "the editor's checklist key").toBe(true);
      for (const shortcut of HELP_SHORTCUTS) {
        const keys = defaultHelpKeys(shortcut, mac);
        if (keys === null) {
          expect(mac, `${shortcut} has no default on Windows and Linux only`).toBe(false);
          continue;
        }
        expect(own.has(keysForm(keys, mac)), `${shortcut}: ${keys}`).toBe(false);
      }
    },
  );

  test.each(SYSTEMS)(
    "that act while the User types keep the keys of text to it, on $name",
    ({ mac }) => {
      const text = new Set(TEXT_KEYS.map((keys) => keysForm(keys, mac)));
      for (const command of all) {
        if (!command.shortcut || command.shortcut.list || (command.shortcut.macOnly && !mac)) {
          continue;
        }
        const form = keysForm(keysOn(command.shortcut.keys, mac), mac);
        // A plain key, or one with Shift, types; a function key doesn't.
        expect(/(meta|ctrl|alt)\+|(^|\+)f\d+$/i.test(form), command.id).toBe(true);
        // Undo and Redo take the keys of text only where the focus isn't in text.
        if (command.shortcut.outsideText) {
          expect(command.appliesTo, command.id).toBeUndefined();
          continue;
        }
        // A key of text is taken only on a Block, where the command says it applies.
        if (command.shortcut.inText) {
          expect(command.appliesTo, command.id).toEqual(["block"]);
          expect(command.when, command.id).toBeDefined();
          expect(command.when?.({ selection: [], focus: null, surface: "mind" }), command.id).toBe(
            false,
          );
          continue;
        }
        expect(text.has(form), command.id).toBe(false);
      }
    },
  );

  test("New Folder is ⇧⌘N, and New Folder with these is Finder's ⌃⌘N on macOS only", () => {
    const newFolder = commands.get("folder.new")?.shortcut;
    const newWith = commands.get("folder.newWith")?.shortcut;
    expect(newFolder && keysLabel(keysOn(newFolder.keys, true), true)).toBe("⇧⌘N");
    expect(newFolder && keysLabel(keysOn(newFolder.keys, false), false)).toBe("Ctrl+Shift+N");
    expect(newFolder?.macOnly).toBeUndefined();
    expect(newWith && keysLabel(keysOn(newWith.keys, true), true)).toBe("⌃⌘N");
    expect(newWith?.macOnly).toBe(true);
  });

  test("Add Documents is ⌘O and waits for the focus to leave text; Link a folder has no keys", () => {
    const add = commands.get("documents.add")?.shortcut;
    expect(add && keysLabel(keysOn(add.keys, true), true)).toBe("⌘O");
    expect(add && keysLabel(keysOn(add.keys, false), false)).toBe("Ctrl+O");
    expect(commands.get("linkedFolder.add")?.shortcut).toBeUndefined();
  });

  test("the application menu's items are commands, with the menu's label and keys", () => {
    for (const id of Object.keys(MENU_COMMANDS) as MenuCommandId[]) {
      const command = commands.get(id);
      expect(command, id).toBeDefined();
      expect(command?.shortcut?.keys).toBe(MENU_COMMANDS[id].keys);
      if (typeof command?.label === "string") expect(command.label).toBe(MENU_COMMANDS[id].label);
    }
  });
});

describe("keys", () => {
  const press = (
    key: string,
    code: string,
    held: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>>,
  ) => ({
    key,
    code,
    metaKey: held.meta ?? false,
    ctrlKey: held.ctrl ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false,
  });

  test("CmdOrCtrl is ⌘ on macOS and Ctrl elsewhere, with exactly the modifiers written", () => {
    expect(pressed("CmdOrCtrl+J", press("j", "KeyJ", { meta: true }), true)).toBe(true);
    expect(pressed("CmdOrCtrl+J", press("j", "KeyJ", { ctrl: true }), true)).toBe(false);
    expect(pressed("CmdOrCtrl+J", press("j", "KeyJ", { ctrl: true }), false)).toBe(true);
    expect(pressed("CmdOrCtrl+J", press("J", "KeyJ", { meta: true, shift: true }), true)).toBe(
      false,
    );
    expect(
      pressed("CmdOrCtrl+Shift+D", press("D", "KeyD", { meta: true, shift: true }), true),
    ).toBe(true);
    expect(pressed("Ctrl+Tab", press("Tab", "Tab", { ctrl: true }), true)).toBe(true);
    expect(pressed("Ctrl+Shift+Tab", press("Tab", "Tab", { ctrl: true, shift: true }), false)).toBe(
      true,
    );
    expect(pressed("CmdOrCtrl+\\", press("\\", "Backslash", { meta: true }), true)).toBe(true);
    expect(pressed("CmdOrCtrl+1", press("1", "Digit1", { ctrl: true }), false)).toBe(true);
  });

  test("letters follow the User's keyboard layout, and the physical key stands in where it types none", () => {
    // AZERTY: Z is where QWERTY has W, so ⌘Z stays the text's undo, and the key marked W closes the tab.
    expect(pressed("CmdOrCtrl+W", press("z", "KeyW", { meta: true }), true)).toBe(false);
    expect(pressed("CmdOrCtrl+W", press("w", "KeyZ", { meta: true }), true)).toBe(true);
    expect(pressed("CmdOrCtrl+1", press("&", "Digit1", { meta: true }), true)).toBe(true);
    // Cyrillic, and a German Mac's key where US layouts have \.
    expect(pressed("CmdOrCtrl+W", press("ц", "KeyW", { ctrl: true }), false)).toBe(true);
    expect(pressed("CmdOrCtrl+\\", press("#", "Backslash", { meta: true }), true)).toBe(true);
  });

  test("a sign typed with AltGr is text, though Windows reports AltGr as Ctrl+Alt", async () => {
    // The keymap reaches the store, which reads the bridge set up above.
    const { runShortcut } = await import("../../src/renderer/src/commands/keymap");
    let ran = 0;
    const stop = commands.register({
      id: "test.altGr",
      label: "menu.newMind",
      group: "main",
      reversible: true,
      shortcut: { keys: "Ctrl+Alt+\\" },
      run: () => {
        ran += 1;
      },
    });
    const globals = globalThis as unknown as { document?: unknown };
    const page = globals.document;
    globals.document = { querySelector: () => null };
    // A German keyboard types \ with AltGr+ß.
    const typed = (altGr: boolean) =>
      ({
        ...press("\\", "Minus", { ctrl: true, alt: true }),
        target: null,
        getModifierState: (key: string) => altGr && key === "AltGraph",
        preventDefault: () => undefined,
      }) as unknown as KeyboardEvent;
    try {
      expect(runShortcut(typed(true), NOWHERE)).toBe(false);
      expect(runShortcut(typed(false), NOWHERE)).toBe(true);
      expect(ran).toBe(1);
    } finally {
      stop();
      globals.document = page;
    }
  });

  test("are written as each system writes them", () => {
    expect(keysLabel("CmdOrCtrl+J", true)).toBe("⌘J");
    expect(keysLabel("CmdOrCtrl+J", false)).toBe("Ctrl+J");
    expect(keysLabel("CmdOrCtrl+\\", true)).toBe("⌘\\");
    expect(keysLabel("CmdOrCtrl+\\", false)).toBe("Ctrl+\\");
    expect(keysLabel("CmdOrCtrl+Shift+Backspace", true)).toBe("⇧⌘⌫");
    expect(keysLabel("CmdOrCtrl+Alt+\\", true)).toBe("⌥⌘\\");
    expect(keysLabel("CmdOrCtrl+Alt+\\", false)).toBe("Ctrl+Alt+\\");
    expect(keysLabel("CmdOrCtrl+Shift+Backspace", false)).toBe("Ctrl+Shift+Backspace");
    expect(keysLabel("Ctrl+Tab", true)).toBe("⌃⇥");
  });

  test("a platform's own keys apply on that platform only", () => {
    const rename = { mac: "Enter", other: "F2" };
    expect(keysOn(rename, true)).toBe("Enter");
    expect(keysOn(rename, false)).toBe("F2");
  });

  test("keys the keymap can't bind are refused when the command is added", () => {
    const base = { group: "main", reversible: true, run: () => undefined } as const;
    expect(() =>
      commands.register({
        ...base,
        id: "test.lower",
        label: "menu.newMind",
        shortcut: { keys: "CmdOrCtrl+n" },
      }),
    ).toThrow();
    expect(() =>
      commands.register({
        ...base,
        id: "test.hyper",
        label: "menu.newMind",
        shortcut: { keys: "Hyper+N" },
      }),
    ).toThrow();
  });
});

describe("the registry", () => {
  const base = { label: "menu.newMind", group: "main", reversible: true } as const;

  test("offers a command for objects only when the selection or focus is of its kinds", async () => {
    let ran: readonly string[] = [];
    const stop = commands.register({
      ...base,
      id: "test.documents",
      appliesTo: ["document"],
      run: (ctx) => {
        ran = ctx.selection.map((ref) => ref.id);
      },
    });
    try {
      const documents: CommandContext = {
        ...NOWHERE,
        selection: [
          { kind: "document", id: "a" },
          { kind: "document", id: "b" },
        ],
      };
      expect(commands.list(NOWHERE).map((command) => command.id)).not.toContain("test.documents");
      expect(commands.list(documents).map((command) => command.id)).toContain("test.documents");
      const mixed = { ...NOWHERE, selection: [...documents.selection, { kind: "mind", id: "m" }] };
      expect(commands.list(mixed as CommandContext).map((command) => command.id)).not.toContain(
        "test.documents",
      );

      await commands.run("test.documents", NOWHERE);
      expect(ran).toEqual([]);
      await commands.run("test.documents", documents);
      expect(ran).toEqual(["a", "b"]);
    } finally {
      stop();
    }
    expect(commands.get("test.documents")).toBeUndefined();
  });

  test("doesn't run a command that isn't enabled, and returns what can undo one that ran", async () => {
    const undo = { said: () => "Did it", undo: async () => undefined };
    const stops = [
      commands.register({
        ...base,
        id: "test.disabled",
        enabled: () => ({ reason: "menu.newMind" }),
        run: () => undo,
      }),
      commands.register({ ...base, id: "test.undoable", run: async () => undo }),
    ];
    try {
      expect(await commands.run("test.disabled")).toBeUndefined();
      expect(await commands.run("test.undoable")).toBe(undo);
    } finally {
      for (const stop of stops) stop();
    }
  });

  test("a row's own action that hands back a frame's handle puts nothing on the undo line", async () => {
    const stop = commands.register({
      ...base,
      id: "test.here",
      // As `requestAnimationFrame` hands back: a number.
      run: () => 42 as unknown as undefined,
    });
    try {
      expect(await commands.run("test.here")).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("refuses two commands with one ID", () => {
    expect(() => commands.register({ ...base, id: "mind.new", run: () => undefined })).toThrow();
  });
});
