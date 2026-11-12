import { describe, expect, test } from "vitest";
import type { Skill } from "../../src/core/api";
import { plusRows, plusSkillItems } from "../../src/renderer/src/editor/composerPlusRows";
import { skillsInListOrder } from "../../src/renderer/src/skillText";

const skill = (name: string, over: Partial<Skill> = {}): Skill => ({
  id: name,
  name,
  description: `${name} does its work.`,
  license: null,
  compatibility: null,
  enabled: true,
  builtIn: false,
  files: [],
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  ...over,
});

describe("The chat box's + menu rows (#2924)", () => {
  // protects=the + menu lists its rows in the issue's order, each with the key that does the same from the text; fails_when=a row moves, goes, or shows another key; no_claim=what a row does.
  test("lists Add files…, Add a note or Document, a rule, Research…, Skills and Compare Documents… with their keys", () => {
    expect(plusRows({ picking: false, compare: true })).toEqual([
      { id: "files" },
      { id: "note", key: "@" },
      { id: "research", key: "/", ruleBefore: true },
      { id: "skills", key: "/" },
      { id: "compare" },
    ]);
  });

  // protects=Compare Documents… is there exactly when its ⌘K command is; fails_when=the row stays without its command, or hides with it; no_claim=what the command opens.
  test("has Compare Documents… only while its ⌘K command is offered", () => {
    const ids = (compare: boolean) => plusRows({ picking: false, compare }).map((row) => row.id);
    expect(ids(true)).toContain("compare");
    expect(ids(false)).not.toContain("compare");
    expect(ids(false)).toEqual(["files", "note", "research", "skills"]);
  });

  // protects=Add files… waits while the system's picker is open, so a second click can't open another; fails_when=it stays usable during a pick, or another row waits too; no_claim=the picker.
  test("holds Add files… while the picker is open, and no other row", () => {
    const rows = plusRows({ picking: true, compare: true });
    expect(rows.filter((row) => row.disabled).map((row) => row.id)).toEqual(["files"]);
    expect(plusRows({ picking: false, compare: true }).some((row) => row.disabled)).toBe(false);
  });

  // protects=the rule sits once, before Research…, between what adds to the Question and what changes how it is answered; fails_when=a rule is added or moved; no_claim=how the rule is drawn.
  test("has one rule, before Research…", () => {
    const withRules = plusRows({ picking: false, compare: true }).filter((row) => row.ruleBefore);
    expect(withRules.map((row) => row.id)).toEqual(["research"]);
  });
});

describe("The + menu's Skills submenu (#2924)", () => {
  // protects=the submenu lists the Skills turned on and no others; fails_when=a Skill that is off is offered; no_claim=the order.
  test("lists the Skills turned on, never one turned off", () => {
    const items = plusSkillItems([
      skill("tide-tables"),
      skill("old-report", { enabled: false }),
      skill("covenant-summary", { builtIn: true }),
      skill("chronology", { builtIn: true, enabled: false }),
    ]);
    const names = items.flatMap((item) => (item.kind === "skill" ? [item.skill.name] : []));
    expect(names).toEqual(["tide-tables", "covenant-summary"]);
  });

  // protects=the User's own Skills come first, then the built-in ones, each under its heading, as "/" lists them; fails_when=the order or the headings differ from "/"; no_claim=the words of the headings.
  test("puts the User's own Skills first and the built-in ones after, each under a heading, when both are there", () => {
    const items = plusSkillItems([
      skill("covenant-summary", { builtIn: true }),
      skill("summarise-document", { builtIn: true }),
      skill("tide-tables"),
      skill("fee-letter"),
    ]);
    expect(items.map((item) => (item.kind === "heading" ? item.of : item.skill.name))).toEqual([
      "yours",
      "tide-tables",
      "fee-letter",
      "builtIn",
      "covenant-summary",
      "summarise-document",
    ]);
  });

  // protects=one kind of Skill alone has no headings; fails_when=a heading shows over a list that has one group; no_claim=the order inside the group.
  test("shows no headings when only one kind is turned on", () => {
    const own = plusSkillItems([skill("tide-tables"), skill("fee-letter")]);
    expect(own.every((item) => item.kind === "skill")).toBe(true);
    const builtIn = plusSkillItems([skill("covenant-summary", { builtIn: true })]);
    expect(builtIn).toHaveLength(1);
    expect(builtIn[0]?.kind).toBe("skill");
  });

  // protects=with no Skill turned on the submenu is empty, so only Manage Skills… is left in it; fails_when=a stale Skill is listed; no_claim=how Manage Skills… is drawn.
  test("is empty when no Skill is turned on", () => {
    expect(plusSkillItems([])).toEqual([]);
    expect(plusSkillItems([skill("tide-tables", { enabled: false })])).toEqual([]);
  });

  // protects=the + menu and "/" order Skills by one function; fails_when=either orders them differently; no_claim=the list's headings.
  test("orders Skills as the shared list order does", () => {
    const skills = [
      skill("b", { builtIn: true }),
      skill("a"),
      skill("c", { builtIn: true }),
      skill("d"),
    ];
    expect(skillsInListOrder(skills).map((each) => each.name)).toEqual(["a", "d", "b", "c"]);
    const shown = plusSkillItems(skills).flatMap((item) =>
      item.kind === "skill" ? [item.skill.name] : [],
    );
    expect(shown).toEqual(["a", "d", "b", "c"]);
  });
});
