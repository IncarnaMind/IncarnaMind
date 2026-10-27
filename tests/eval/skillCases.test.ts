import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CASES, SKILLS } from "../../eval/skills/cases";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOCUMENTS = join(ROOT, "eval", "skills", "documents");
const FICTION = { en: /are\s+fictional/, "zh-CN": /均为虚构/ } as const;
const LANGUAGES = ["en", "zh-CN"] as const;

describe("The finance and law Skills' case table (#1938)", () => {
  test("covers each of the six Skills once in English and once in Chinese", () => {
    expect(SKILLS.length).toBe(6);
    for (const skill of SKILLS) {
      expect(
        CASES.filter((one) => one.skill === skill)
          .map((one) => one.language)
          .sort(),
        skill,
      ).toEqual([...LANGUAGES]);
    }
  });

  test("the covenant conclusion is read as met, never as not met", () => {
    const conclusion = (id: string) => {
      const one = CASES.find((each) => each.id === id);
      if (!one) throw new Error(`No ${id} case.`);
      const fact = one.facts.at(-1);
      if (!fact) throw new Error(`No conclusion fact for ${id}.`);
      return fact;
    };
    const holds = (id: string, text: string) =>
      conclusion(id).some((pattern) => pattern.test(text));
    expect(holds("covenant-summary-en", "The covenant was met.")).toBe(true);
    expect(holds("covenant-summary-en", "The covenant was not met.")).toBe(false);
    expect(holds("covenant-summary-zh", "该项约定已满足。")).toBe(true);
    expect(holds("covenant-summary-zh", "该项约定未满足。")).toBe(false);
  });

  test("every case's invented Documents exist, say they are fictional, and name their licence", () => {
    for (const one of CASES) {
      expect(one.documents.length, one.id).toBeGreaterThan(0);
      expect(one.request.trim(), one.id).not.toBe("");
      expect(one.facts.length, one.id).toBeGreaterThan(0);
      expect(one.citationsAtLeast, one.id).toBeGreaterThan(0);
      for (const file of one.documents) {
        const path = join(DOCUMENTS, one.language, file);
        expect(existsSync(path), `${one.id}: ${path}`).toBe(true);
        const text = readFileSync(path, "utf8");
        expect(text, path).toMatch(FICTION[one.language]);
        expect(text, path).toContain("CC0 1.0");
      }
    }
  });

  test("every Document in the folders is one of a case, so a case can't lose its evidence", () => {
    for (const language of LANGUAGES) {
      const files = readdirSync(join(DOCUMENTS, language))
        .filter((file) => file.endsWith(".md"))
        .sort();
      const used = [
        ...new Set(
          CASES.filter((one) => one.language === language).flatMap((one) => one.documents),
        ),
      ].sort();
      expect(used, language).toEqual(files);
    }
    const readme = readFileSync(join(DOCUMENTS, "README.md"), "utf8");
    expect(readme).toContain("fictional");
    expect(readme).toContain("CC0 1.0");
  });
});
