import { beforeAll, describe, expect, test } from "vitest";
import type { ConversationMatch, Mind } from "../../src/core/api";
import type { FindableKind, FoundObject } from "../../src/renderer/src/finding";
import type { ObjectKind, ObjectRef } from "../../src/renderer/src/objects";
import type * as Palette from "../../src/renderer/src/palette";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

let palette: typeof Palette;

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  palette = await import("../../src/renderer/src/palette");
});

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);
const AT = "2026-10-13T09:00:00.000Z";

const kindOf = (kind: ObjectKind, group: string, title: MessageKey): FindableKind => ({
  kind,
  group: { id: group, title },
  objects: () => [],
  subscribe: () => () => undefined,
  open: () => undefined,
});

const object = (kind: ObjectKind, id: string, name: string, meta = ""): FoundObject => ({
  ref: { kind, id },
  name,
  meta,
  icon: () => null,
});

const mind = (id: string, title: string, updatedAt = AT): Mind => ({
  id,
  title,
  autoTitle: "",
  kind: "mind",
  createdAt: AT,
  updatedAt,
  folderId: null,
});

const minds = [
  mind("m-contract", "Contract checklist", "2026-10-12T09:00:00.000Z"),
  mind("m-finance", "财务月报：九月"),
  mind("m-standup", "Stand-up, 6 October", "2026-10-11T09:00:00.000Z"),
];

function findingsOf(groups: [FindableKind, FoundObject[]][]): Palette.Findings {
  const names = new Map<string, string>();
  for (const [, objects] of groups) {
    for (const each of objects) names.set(`${each.ref.kind}:${each.ref.id}`, each.name);
  }
  return { kinds: groups.map(([kind, objects]) => ({ kind, objects })), names };
}

const found = findingsOf([
  [
    kindOf("mind", "minds", "palette.group.minds"),
    minds.map((each) => object("mind", each.id, each.title, "Mind")),
  ],
  [
    kindOf("conversation", "conversations", "palette.group.conversations"),
    [object("conversation", "c-carriers", "Carrier contracts ending in 2027")],
  ],
  [
    kindOf("document", "documents", "palette.group.documents"),
    [
      object("document", "d-register", "Contracts register 2026", "PDF"),
      object("document", "d-msa", "Aldermoor MSA", "PDF"),
      object("document", "d-report", "2026 财务报表", "PDF · 财务"),
      object("document", "d-agreement", "供应商合同", "Word"),
    ],
  ],
  [
    kindOf("folder", "foldersAndTags", "palette.group.foldersAndTags"),
    [
      object("folder", "f-finance", "财务", "Folder · 1 Document"),
      object("folder", "f-contracts", "Contracts & agreements"),
    ],
  ],
  [
    kindOf("tag", "foldersAndTags", "palette.group.foldersAndTags"),
    [object("tag", "t-contract", "Contract", "Tag · on 2 Documents")],
  ],
]);

const shown = (groups: Palette.PaletteGroup[]) =>
  groups.map((group) => [group.id, group.items.map((item) => item.name)]);
const names = (query: string) => shown(palette.nameGroups(palette.readQuery(query).words, found));

describe("⌘K's names", () => {
  test("each registered kind, in the order registered, kinds sharing a group ranked together", () => {
    expect(names("contract")).toEqual([
      ["minds", ["Contract checklist"]],
      ["conversations", ["Carrier contracts ending in 2027"]],
      ["documents", ["Contracts register 2026"]],
      ["foldersAndTags", ["Contract", "Contracts & agreements"]],
    ]);
    const [, , , foldersAndTags] = palette.nameGroups(["contract"], found);
    expect(foldersAndTags?.title).toBe("palette.group.foldersAndTags");
  });

  test("Chinese names by their characters, their pinyin and its initials, and a name with a typo", () => {
    const finance = [
      ["minds", ["财务月报：九月"]],
      ["documents", ["2026 财务报表"]],
      ["foldersAndTags", ["财务"]],
    ];
    expect(names("财务")).toEqual(finance);
    expect(names("caiwu")).toEqual(finance);
    expect(names("cw")).toEqual(finance);
    expect(names("hetong")).toEqual([["documents", ["供应商合同"]]]);
    expect(names("contarct")).toEqual([
      ["minds", ["Contract checklist"]],
      ["conversations", ["Carrier contracts ending in 2027"]],
      ["documents", ["Contracts register 2026"]],
      ["foldersAndTags", ["Contract", "Contracts & agreements"]],
    ]);
  });

  test("with nothing typed, the Minds edited last", () => {
    expect(shown(palette.recentGroup(minds, found))).toEqual([
      ["recent", ["财务月报：九月", "Contract checklist", "Stand-up, 6 October"]],
    ]);
    expect(palette.recentGroup([], found)).toEqual([]);
    expect(shown(palette.recentGroup(minds, found, "m-finance"))).toEqual([
      ["recent", ["Contract checklist", "Stand-up, 6 October"]],
    ]);
  });
});

describe("⌘K's actions", () => {
  const actions = (query: string, language: "en" | "zh-CN" = "en") =>
    shown(
      palette.actionGroup(
        palette.readQuery(query).words,
        { selection: [], focus: null, surface: "palette" },
        language,
        found.names,
      ),
    );

  test("are the registry's, found by their name or keywords in English or in Chinese", () => {
    expect(actions("settings models")).toEqual([["actions", ["Settings: Models"]]]);
    expect(actions("new mind")).toEqual([["actions", ["New Mind"]]]);
    expect(actions("设置 模型")).toEqual([["actions", ["Settings: Models"]]]);
    expect(actions("设置 模型", "zh-CN")).toEqual([["actions", ["设置：模型"]]]);
    expect(actions("settings models", "zh-CN")).toEqual([["actions", ["设置：模型"]]]);
    expect(actions("zzqx")).toEqual([]);
  });

  test("a word inside another word, or one typo across two, doesn't find an action (#1372)", () => {
    expect(actions("ew mind")).toEqual([]);
    expect(actions("theme")).toEqual([]);
    expect(actions("new mind")).toEqual([["actions", ["New Mind"]]]);
    // A typo of a word's start still finds the action.
    expect(actions("neww mind")).toEqual([["actions", ["New Mind"]]]);
  });

  test("act on the selection, saying how many, or on the one thing in front, naming it", () => {
    const [withTwo] = palette.actionGroup(
      ["new", "folder"],
      {
        selection: [
          { kind: "document", id: "d-register" },
          { kind: "document", id: "d-msa" },
        ],
        focus: null,
        surface: "palette",
      },
      "en",
      found.names,
    );
    expect(withTwo?.items.map((item) => item.name)).toContain("New Folder with 2 Documents");
    const one: ObjectRef = { kind: "document", id: "d-msa" };
    const [onOne] = palette.actionGroup(
      [],
      { selection: [], focus: one, surface: "palette" },
      "en",
      found.names,
      true,
    );
    expect(onOne?.items.find((item) => item.key === "command:document.delete")?.meta).toBe(
      "Aldermoor MSA",
    );
  });

  const noop = () => undefined;
  /** What the place showing the object offers: rename in its row, a picker beside it (see commands/here). */
  const HERE = {
    "mind.rename": noop,
    "mind.moveTo": noop,
    "document.rename": noop,
    "document.moveTo": noop,
    "document.tags": noop,
    "folder.rename": noop,
  };
  const list = (words: string[], focus: ObjectRef | null = null, all = false) =>
    palette
      .actionGroup(
        words,
        { selection: [], focus, surface: "palette", ...(focus && { here: HERE }) },
        "en",
        found.names,
        all,
      )
      .flatMap((group) => group.items.map((item) => item.key));

  test("with nothing typed, are the few that are on top, in their own order, and never ⌘K itself", () => {
    expect(list([])).toEqual(["command:mind.new", "command:library.open"]);
    expect(list([])).not.toContain("command:palette.open");
  });

  test("with something in focus, the top ones for it come with the ones for the window, six at most", () => {
    const names = (focus: ObjectRef) => list([], focus);
    const mind = names({ kind: "mind", id: "m-contract" });
    const document = names({ kind: "document", id: "d-msa" });
    const folder = names({ kind: "folder", id: "f-finance" });
    for (const keys of [mind, document, folder]) {
      expect(keys.length).toBeLessThanOrEqual(6);
      expect(keys).toContain("command:library.open");
      // New Mind first, Open the Library last.
      expect(keys.indexOf("command:mind.new")).toBeLessThan(keys.indexOf("command:library.open"));
      expect(keys.at(-1)).toBe("command:library.open");
    }
    expect(mind).toEqual(expect.arrayContaining(["command:mind.rename"]));
    expect(document).toEqual(
      expect.arrayContaining([
        "command:document.moveTo",
        "command:document.tags",
        "command:document.rename",
      ]),
    );
    expect(folder).toEqual(expect.arrayContaining(["command:folder.rename"]));
    // Move to…, Tags…, then Rename.
    expect(document.indexOf("command:document.moveTo")).toBeLessThan(
      document.indexOf("command:document.tags"),
    );
    expect(document.indexOf("command:document.tags")).toBeLessThan(
      document.indexOf("command:document.rename"),
    );
  });

  test("a Mind in front lists Export… after Check and before New Mind, as the prototype does", () => {
    const mind = list([], { kind: "mind", id: "m-contract" });
    expect(mind.indexOf("command:mind.exportMenu")).toBeGreaterThanOrEqual(0);
    expect(mind.indexOf("command:mind.exportMenu")).toBeLessThan(mind.indexOf("command:mind.new"));
    expect(mind.indexOf("command:mind.check")).toBeLessThan(
      mind.indexOf("command:mind.exportMenu"),
    );
  });

  test("Rename is found by its pinyin as it is read in 重命名, and the Library by 资料库's", () => {
    const rename = { kind: "mind", id: "m-contract" } as const;
    expect(list(["chongmingming"], rename)).toContain("command:mind.rename");
    expect(list(["cmm"], rename)).toContain("command:mind.rename");
    expect(list(["ziliaoku"])).toContain("command:library.open");
    expect(list(["zlk"])).toContain("command:library.open");
  });

  test("a row shows the keys of what it does, F2 for Rename and ⇧⌘M for Move to…", () => {
    const [group] = palette.actionGroup(
      [],
      { selection: [], focus: { kind: "document", id: "d-msa" }, surface: "palette", here: HERE },
      "en",
      found.names,
    );
    const keys = (id: string) => {
      const item = group?.items.find((each) => each.key === `command:${id}`);
      return item?.kind === "command" ? item.shortcut : undefined;
    };
    expect(keys("document.rename")).toBe("F2");
    expect(keys("document.moveTo")).toMatch(/M$/);
  });

  test("the interface language is named for the other one, in either language, and found by its words", () => {
    expect(actions("interface language")).toEqual([["actions", ["Interface language: 中文"]]]);
    expect(actions("界面语言", "zh-CN")).toEqual([["actions", ["界面语言：English"]]]);
    expect(actions("yuyan", "zh-CN")).toEqual([["actions", ["界面语言：English"]]]);
    expect(actions("language")).toEqual([["actions", ["Interface language: 中文"]]]);
  });

  test("Add Documents… and Link a folder… are found by name", () => {
    expect(actions("add documents")).toEqual([["actions", ["Add Documents…"]]]);
    expect(actions("link a folder")).toEqual([["actions", ["Link a folder…"]]]);
    expect(actions("添加文档", "zh-CN")[0]?.[1]).toContain("添加文档…");
  });

  test('">" lists every action that applies, and typing finds any of them', () => {
    const everything = list([], null, true);
    expect(everything.length).toBeGreaterThan(15);
    expect(everything).toContain("command:deleted.empty");
    expect(list(["recently", "deleted"])).toContain("command:deleted.show");
    expect(list(["open", "the", "library"])[0]).toBe("command:library.open");
  });
});

describe("what is typed", () => {
  test('">" asks for actions only; the words inside are searched for from two letters, or one Chinese character', () => {
    expect(palette.readQuery("> settings")).toEqual({
      text: "settings",
      words: ["settings"],
      actionsOnly: true,
    });
    expect(palette.readQuery(" Contract ").actionsOnly).toBe(false);
    expect(palette.searchesWords("c")).toBe(false);
    expect(palette.searchesWords("co")).toBe(true);
    expect(palette.searchesWords("财")).toBe(true);
  });

  test("Enter's row: the one chosen, else the first found; the Ask row only once the search for words inside is over", () => {
    const name = (key: string): Palette.PaletteItem => ({
      kind: "command",
      id: "library.open",
      key,
      name: key,
      meta: "",
      shortcut: null,
      ranges: [],
    });
    const [ask] = palette.askGroup("Rotterdam", "New chat", en).flatMap((group) => group.items);
    if (!ask) throw new Error("no Ask row");
    const found = [name("a"), name("b")];

    expect(palette.activeOf([ask], null, true)).toBeUndefined();
    expect(palette.activeOf([ask], null, false)).toBe(ask);
    expect(palette.activeOf([...found, ask], null, true)).toBe(found[0]);
    expect(palette.activeOf([...found, ask], "b", true)).toBe(found[1]);
    expect(palette.activeOf([ask], "ask", true)).toBe(ask);
  });

  test("words in conversations show the first message that holds them, and asking names the conversation", () => {
    const match: ConversationMatch = {
      conversation: {
        id: "c-carriers",
        title: "",
        autoTitle: "Which carriers end in 2027?",
        folderId: null,
        askedFrom: [],
        createdAt: AT,
        updatedAt: AT,
      },
      titleHighlights: [],
      messages: [
        {
          messageId: "a-1",
          kind: "answer",
          excerpt: "Leeds Docks ends its lease on 31 December.",
          highlights: [{ start: 22, end: 27 }],
        },
      ],
    };
    const [group] = palette.conversationTextGroup([match, { ...match, messages: [] }]);
    expect(group?.items).toEqual([
      expect.objectContaining({
        kind: "said",
        conversationId: "c-carriers",
        answerId: "a-1",
        name: "Which carriers end in 2027?",
        excerpt: "Leeds Docks ends its lease on 31 December.",
      }),
    ]);
    expect(shown(palette.askGroup("how long is the warranty", "New chat", en))).toEqual([
      ["ask", ["Ask “how long is the warranty”"]],
    ]);
    const [ask] = palette.askGroup("保修期多长", "供应商审查", zh);
    expect(ask?.items[0]).toMatchObject({ name: "提问“保修期多长”", meta: "在“供应商审查”里" });
  });
});
