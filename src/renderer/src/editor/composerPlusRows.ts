import type { Skill } from "../../../core/api";
import { skillsInListOrder } from "../skillText";

export type PlusRowId = "files" | "note" | "research" | "skills" | "compare";

export interface PlusRow {
  id: PlusRowId;
  /** The key that does the same from the text: "@" or "/", shown on the row to teach it. */
  key?: "@" | "/";
  ruleBefore?: true;
  disabled?: true;
}

/**
 * The + menu's rows, in order. Each calls what "/" or ⌘K already does, so only what decides
 * whether a row is there or can be used is here: Add files… waits while the system's file picker
 * is open, and Compare Documents… is there when its ⌘K command is.
 */
export function plusRows({ picking, compare }: { picking: boolean; compare: boolean }): PlusRow[] {
  return [
    { id: "files", ...(picking && { disabled: true as const }) },
    { id: "note", key: "@" },
    { id: "research", key: "/", ruleBefore: true },
    { id: "skills", key: "/" },
    ...(compare ? [{ id: "compare" as const }] : []),
  ];
}

export type PlusSkillItem =
  | { kind: "heading"; of: "yours" | "builtIn" }
  | { kind: "skill"; skill: Skill };

/**
 * The Skills submenu: the Skills turned on, as "/" lists them: the User's own first, then the
 * built-in ones, each group under its heading when both are there.
 */
export function plusSkillItems(skills: readonly Skill[]): PlusSkillItem[] {
  const on = skillsInListOrder(skills.filter((skill) => skill.enabled));
  const grouped = on.some((skill) => skill.builtIn) && on.some((skill) => !skill.builtIn);
  return on.flatMap((skill, index): PlusSkillItem[] => {
    const starts = grouped && (index === 0 || on[index - 1]?.builtIn !== skill.builtIn);
    return starts
      ? [
          { kind: "heading", of: skill.builtIn ? "builtIn" : "yours" },
          { kind: "skill", skill },
        ]
      : [{ kind: "skill", skill }];
  });
}
