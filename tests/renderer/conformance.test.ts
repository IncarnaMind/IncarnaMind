import { beforeAll, describe, expect, test } from "vitest";
import {
  buildMenu,
  isMenuItem,
  type MenuEntry,
  type MenuItem,
  menuIds,
  menuKinds,
} from "../../src/renderer/src/commands/menus";
import {
  COMMAND_GROUPS,
  type Command,
  type CommandContext,
  commands,
  labelOf,
  menuLabelOf,
} from "../../src/renderer/src/commands/registry";
import { OBJECT_KINDS, type Translate } from "../../src/renderer/src/objects";
import { type MessageKey, translate } from "../../src/shared/i18n";
import { NO_MENU_YET } from "../helpers/conformance";

/*
 * What docs/agents/interaction.md asks of every object and every action, read
 * from the registries: a new kind of object or a new command is checked here
 * with no edit to this file. The source scans are in conformanceStatic.test.ts,
 * the same checks on the built app in e2e/conformance.spec.ts.
 */

const LANGUAGES = ["en", "zh-CN"] as const;
type Language = (typeof LANGUAGES)[number];
type Translators = Record<Language, Translate>;

const NOWHERE: CommandContext = { selection: [], focus: null, surface: "mind" };

const translators: Translators = {
  en: (key: MessageKey, params) => translate("en", key, params),
  "zh-CN": (key: MessageKey, params) => translate("zh-CN", key, params),
};

const HAN = /\p{Script=Han}/u;

/** What is wrong with the kinds' menus: a kind with none, or one excused that has one now. */
function menuProblems(
  kinds: readonly string[],
  withMenu: readonly string[],
  excused: Record<string, string>,
): string[] {
  return [
    ...kinds
      .filter((kind) => !withMenu.includes(kind) && !(kind in excused))
      .map((kind) => `${kind} has no registered menu`),
    ...Object.keys(excused)
      .filter((kind) => withMenu.includes(kind))
      .map((kind) => `${kind} has a menu now: take it off NO_MENU_YET`),
  ];
}

/** What is wrong with a label in one language: blank, unfilled, or, in Chinese, not Chinese. */
function labelProblem(text: unknown, language: Language, english: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "") return `no label in ${language}`;
  if (/\{\w+\}/.test(text)) return `a placeholder left in its ${language} label`;
  if (language === "zh-CN" && (!HAN.test(text) || text === english)) {
    return "its Chinese label isn't Chinese";
  }
  return null;
}

/** Whether translating throws, as a key with no text does. */
const said = (say: () => string): string | undefined => {
  try {
    return say();
  } catch {
    return undefined;
  }
};

/** What is wrong with the commands, by rule 4 (reversible or asks) and rule 7 (keys or ⌘K). */
function commandProblems(all: readonly Command[], t: Translators = translators): string[] {
  const problems: string[] = [];
  for (const command of all) {
    const wrong = (what: string) => problems.push(`${command.id}: ${what}`);
    const labels: [string, (to: Translate) => string][] = [
      ["label", (to) => labelOf(command, NOWHERE, to)],
    ];
    if (command.menuLabel) labels.push(["menu label", (to) => menuLabelOf(command, NOWHERE, to)]);
    for (const [name, label] of labels) {
      const english = said(() => label(t.en));
      for (const language of LANGUAGES) {
        const problem = labelProblem(
          said(() => label(t[language])),
          language,
          english,
        );
        if (problem) wrong(`${name}: ${problem}`);
      }
    }
    if (!COMMAND_GROUPS.includes(command.group)) wrong("it has no menu group");
    if (command.palette === false && !command.shortcut) wrong("it has no shortcut and no ⌘K entry");
    const { reversible } = command;
    if (reversible === true) continue;
    if (typeof reversible?.confirm !== "string") {
      wrong("it isn't marked reversible or asking first");
      continue;
    }
    for (const language of LANGUAGES) {
      const text = said(() => t[language](reversible.confirm));
      const label = said(() => labelOf(command, NOWHERE, t[language]));
      if (!text || text.trim() === "") wrong(`it asks first with no text in ${language}`);
      else if (text === label) wrong(`its ${language} confirmation only repeats its label`);
      else if (language === "zh-CN" && !HAN.test(text))
        wrong("its Chinese confirmation isn't Chinese");
    }
  }
  return problems;
}

/** Where a menu's rules and groups break rule 5's order. */
function orderProblems(kind: string, entries: readonly MenuEntry[]): string[] {
  const problems: string[] = [];
  let lastGroup = -1;
  let lastSection = -1;
  let afterRule = false;
  for (const entry of entries) {
    if (entry === "rule") {
      if (lastGroup < 0) problems.push(`${kind}: begins with a rule`);
      if (afterRule) problems.push(`${kind}: two rules in a row`);
      afterRule = true;
      continue;
    }
    const named = isMenuItem(entry) ? entry.command.id : "More";
    const group = COMMAND_GROUPS.indexOf(isMenuItem(entry) ? entry.command.group : "main");
    const newSection = entry.section !== lastSection;
    if (!newSection && group < lastGroup) problems.push(`${kind}: ${named} is out of order`);
    // A rule comes exactly where the group or the section changes.
    const needsRule = (newSection || group !== lastGroup) && lastGroup >= 0;
    if (afterRule !== needsRule) {
      problems.push(
        `${kind}: ${named} ${needsRule ? "needs a rule before it" : "has a rule it doesn't need"}`,
      );
    }
    lastSection = entry.section;
    lastGroup = group;
    afterRule = false;
  }
  if (afterRule) problems.push(`${kind}: ends with a rule`);
  return problems;
}

const itemOf = (command: Command, section = 0): MenuItem => ({ command, enabled: true, section });

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({
    minds: [{ id: "one" } as never],
    documents: [
      { id: "one", path: "/Contracts/MSA.pdf", web: null, fileStatus: "available" } as never,
    ],
    linkedFolders: [{ id: "one", path: "/Contracts", status: "idle" } as never],
  });
});

/** A window with one tab, on the Mind "one": what a tab's menu needs to offer anything. */
const ONE_TAB = {
  groups: [
    {
      id: "group",
      tabs: [{ id: "one", item: { kind: "mind", mindId: "one" } }],
      activeTabId: "one",
      width: 1,
    },
  ],
  focusedGroupId: "group",
  reopenable: 0,
} as never;

describe("every kind of object", () => {
  test("the app shows has a registered menu, made of commands that act on it", () => {
    expect(menuProblems(OBJECT_KINDS, menuKinds(), NO_MENU_YET)).toEqual([]);
    for (const kind of menuKinds()) {
      expect(menuIds(kind).length, kind).toBeGreaterThan(0);
      for (const id of menuIds(kind)) {
        const command = commands.get(id);
        expect(command, `${kind}: ${id}`).toBeDefined();
        // A command with no kinds acts on the window or on what is shown (the tab's own are such).
        if (command?.appliesTo) expect(command.appliesTo, `${kind}: ${id}`).toContain(kind);
      }
    }
  });

  test("shows its menu in the order of rule 5, with a rule between groups", async () => {
    expect(COMMAND_GROUPS).toEqual(["open", "main", "move", "tags", "edit", "file", "danger"]);
    const { useAppStore } = await import("../../src/renderer/src/store");
    try {
      for (const kind of menuKinds()) {
        // Only a tab's commands look for the window's layout, and without one they don't read the page.
        useAppStore.setState({ layout: kind === "tab" ? ONE_TAB : null });
        // Everything the row could do for it is on offer, so the whole menu shows what it can.
        const here = Object.fromEntries(menuIds(kind).map((id) => [id, () => undefined]));
        const entries = buildMenu(kind, {
          selection: [],
          focus: { kind, id: "one" },
          surface: "sidebar",
          here,
        });
        expect(entries.length, kind).toBeGreaterThan(0);
        expect(orderProblems(kind, entries), kind).toEqual([]);
      }
    } finally {
      useAppStore.setState({ layout: null });
    }
  });
});

describe("every command", () => {
  test("has English and Chinese labels, a group, a reversible mark, and a shortcut or a ⌘K entry", () => {
    expect(commands.all().length).toBeGreaterThan(0);
    expect(commandProblems(commands.all())).toEqual([]);
  });

  test("that deletes what rule 4 names asks nothing: it moves to Recently deleted", () => {
    const names = ["mind", "conversation", "document", "folder", "tag"];
    const deletes = commands
      .all()
      .filter((command) => names.includes(command.id.split(".")[0] ?? ""));
    expect(deletes.map((command) => command.id)).toEqual(
      expect.arrayContaining(["mind.delete", "document.delete", "folder.delete", "tag.delete"]),
    );
    for (const command of deletes.filter((each) => each.id.endsWith(".delete"))) {
      expect(command.reversible, command.id).toBe(true);
    }
  });
});

describe("the checks themselves", () => {
  const base = {
    label: "mind.open",
    group: "main",
    reversible: true,
    run: () => undefined,
  } as const;

  test("fail a kind of object registered with no menu, and a menu that makes its excuse stale", () => {
    expect(menuProblems(["mind", "thing"], ["mind"], {})).toEqual(["thing has no registered menu"]);
    expect(menuProblems(["mind", "thing"], ["mind"], { thing: "not yet" })).toEqual([]);
    expect(menuProblems(["mind", "tag"], ["mind", "tag"], { tag: "none yet" })).toEqual([
      "tag has a menu now: take it off NO_MENU_YET",
    ]);
  });

  test("fail a command with no Chinese label, in the registry itself", () => {
    const stop = commands.register({
      ...base,
      id: "test.noChinese",
      // A key the Chinese dictionary doesn't have: the type-check allows it only through a cast.
      label: "test.noChinese.label" as MessageKey,
    });
    try {
      expect(commandProblems(commands.all())).toEqual([
        "test.noChinese: label: no label in en",
        "test.noChinese: label: no label in zh-CN",
      ]);
    } finally {
      stop();
    }
    expect(commandProblems(commands.all())).toEqual([]);
  });

  test("fail a Chinese label that is blank, is the English, or has no Chinese in it", () => {
    const open: Command = { ...base, id: "test.open" };
    const chinese = (zh: (key: MessageKey) => string): Translators => ({
      en: translators.en,
      "zh-CN": (key) => zh(key),
    });
    expect(
      commandProblems(
        [open],
        chinese(() => ""),
      ),
    ).toEqual(["test.open: label: no label in zh-CN"]);
    expect(
      commandProblems(
        [open],
        chinese((key) => translators.en(key)),
      ),
    ).toEqual(["test.open: label: its Chinese label isn't Chinese"]);
    expect(
      commandProblems(
        [open],
        chinese(() => "Open {name}"),
      ),
    ).toEqual(["test.open: label: a placeholder left in its zh-CN label"]);
    expect(commandProblems([open])).toEqual([]);
  });

  test("fail a command with no group or no mark, none of its keys, and a confirmation that names nothing", () => {
    const wrong = {
      ...base,
      id: "test.wrong",
      group: "nowhere",
      reversible: undefined,
      palette: false,
    } as unknown as Command;
    expect(commandProblems([wrong])).toEqual([
      "test.wrong: it has no menu group",
      "test.wrong: it has no shortcut and no ⌘K entry",
      "test.wrong: it isn't marked reversible or asking first",
    ]);
    const asks: Command = { ...base, id: "test.asks", reversible: { confirm: "mind.open" } };
    expect(commandProblems([asks])).toEqual([
      "test.asks: its en confirmation only repeats its label",
      "test.asks: its zh-CN confirmation only repeats its label",
    ]);
  });

  test("fail a menu out of order, with a missing rule or a rule too many", () => {
    const open = itemOf({ ...base, id: "test.open", group: "open" });
    const main = itemOf({ ...base, id: "test.main", group: "main" });
    const danger = itemOf({ ...base, id: "test.danger", group: "danger" });
    expect(orderProblems("thing", [open, "rule", main, "rule", danger])).toEqual([]);
    expect(orderProblems("thing", [danger, "rule", open])).toEqual([
      "thing: test.open is out of order",
    ]);
    expect(orderProblems("thing", [open, main])).toEqual([
      "thing: test.main needs a rule before it",
    ]);
    expect(orderProblems("thing", [open, "rule", open])).toEqual([
      "thing: test.open has a rule it doesn't need",
    ]);
    expect(orderProblems("thing", ["rule", open, "rule"])).toEqual([
      "thing: begins with a rule",
      "thing: test.open has a rule it doesn't need",
      "thing: ends with a rule",
    ]);
  });
});
