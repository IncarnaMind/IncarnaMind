import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/*
 * A string's values are not typed by its placeholders, so a call that still passes a renamed one
 * (`{ service }` for "{provider}") prints the placeholder itself to the User (#463). Every call
 * with its values written out must give each placeholder of the string, in both languages.
 */

const ROOT = join(__dirname, "../..");
const CALL = /\bt\(\s*"([\w.-]+)",\s*\{([^{}]*)\}\s*\)/g;

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const placeholders = (template: string) =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");

function calls(file: string): { key: string; missing: string[] }[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(CALL)].flatMap(([, key = "", body = ""]) => {
    if (!Object.hasOwn(en, key)) return [];
    const values = body.replace(/\/\/[^\n]*/g, "");
    if (values.includes("...")) return [];
    const given = new Set(values.split(",").map((value) => value.split(":")[0]?.trim() ?? ""));
    const templates = [en[key as keyof typeof en], zhCN[key as keyof typeof zhCN]];
    const missing = [...new Set(templates.flatMap(placeholders))].filter(
      (name) => !given.has(name),
    );
    return [{ key, missing }];
  });
}

test("every string called with its values written out is given each of its placeholders", () => {
  const setup = join(ROOT, "src/renderer/src/components/providers/SetupSteps.tsx");
  expect(calls(setup)).toContainEqual({ key: "meetings.route.cloudLine", missing: [] });
  const unfilled = sources(join(ROOT, "src")).flatMap((file) =>
    calls(file)
      .filter((call) => call.missing.length > 0)
      .map((call) => `${relative(ROOT, file)}: ${call.key} needs ${call.missing.join(", ")}`),
  );
  expect(unfilled).toEqual([]);
});
