import { describe, expect, it } from "vitest";
import { pathFromHome } from "../../src/shared/homePath";

describe("a path from the home folder", () => {
  it("writes the home folder as ~", () => {
    expect(pathFromHome("/Users/priya/.agents/skills/incarnamind/SKILL.md", "/Users/priya")).toBe(
      "~/.agents/skills/incarnamind/SKILL.md",
    );
    expect(pathFromHome("/Users/priya", "/Users/priya")).toBe("~");
    expect(pathFromHome("/Users/priya/.claude/skills", "/Users/priya/")).toBe("~/.claude/skills");
  });

  it("leaves a path outside the home folder as it is, a folder that only starts like it among them", () => {
    expect(pathFromHome("/opt/skills/SKILL.md", "/Users/priya")).toBe("/opt/skills/SKILL.md");
    expect(pathFromHome("/Users/priyanka/.agents/SKILL.md", "/Users/priya")).toBe(
      "/Users/priyanka/.agents/SKILL.md",
    );
    expect(pathFromHome("/anywhere", "")).toBe("/anywhere");
  });

  it("keeps a Windows path's own separators and ignores its letters' case", () => {
    expect(pathFromHome("C:\\Users\\Priya\\.agents\\skills\\SKILL.md", "C:\\Users\\Priya")).toBe(
      "~\\.agents\\skills\\SKILL.md",
    );
    expect(pathFromHome("c:\\users\\priya\\.claude\\skills", "C:\\Users\\Priya")).toBe(
      "~\\.claude\\skills",
    );
    expect(pathFromHome("C:\\Users\\Priya2\\SKILL.md", "C:\\Users\\Priya")).toBe(
      "C:\\Users\\Priya2\\SKILL.md",
    );
  });
});
