import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/*
 * A flag that starts true and that only an effect's cleanup sets false reads "gone" for good
 * under React's development check, which mounts each component twice. The Jev and decision-key
 * forms in the sorting picker kept it, so Use this checked the key and then did nothing. Such a
 * flag is set back on each mount, as `useMounted` does.
 */

const renderer = join(__dirname, "../../src/renderer");

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function flagsOnlyCleared(text: string): string[] {
  const names = [...text.matchAll(/const (\w+) = useRef\(true\)/g)].map((match) => match[1] ?? "");
  return names.filter(
    (name) => text.includes(`${name}.current = false`) && !text.includes(`${name}.current = true`),
  );
}

describe("A flag cleared on unmount is set again on mount", () => {
  test("no renderer file keeps a flag that only a cleanup changes", () => {
    const found = sources(renderer).flatMap((path) =>
      flagsOnlyCleared(readFileSync(path, "utf8")).map(
        (name) => `${relative(renderer, path)}: ${name}`,
      ),
    );
    expect(found).toEqual([]);
  });

  test("the check finds the pattern the sorting forms had", () => {
    const before = [
      "const mounted = useRef(true);",
      "useEffect(() => () => {",
      "  mounted.current = false;",
      "}, []);",
    ].join("\n");
    const after = [
      "const mounted = useRef(true);",
      "useEffect(() => {",
      "  mounted.current = true;",
      "  return () => {",
      "    mounted.current = false;",
      "  };",
      "}, []);",
    ].join("\n");
    expect(flagsOnlyCleared(before)).toEqual(["mounted"]);
    expect(flagsOnlyCleared(after)).toEqual([]);
  });
});
