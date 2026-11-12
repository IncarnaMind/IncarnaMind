import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  helpersOf,
  LIBRARY_ATTRIBUTES_TO_MARKS,
  libraryMarksToAttributes,
  libraryUpdateYText,
  partsOf,
  patchBuild,
  patchedUpdateYText,
  replacementsOf,
  VERSION,
} from "../../patches/y-tiptap.mjs";

/*
 * patches/y-tiptap.mjs, run at install, sets three of our functions in both builds of the editor's
 * Yjs sync: the format step that keeps an edit off marks it didn't change (#2988), and the two that
 * keep each check under a key of its own (#2996). It stops the install for a build it doesn't know.
 */

const root = join(__dirname, "..", "..");
const formatSource = readFileSync(join(root, "patches", "y-tiptap", "formatChanges.mjs"), "utf8");
const marksSource = readFileSync(join(root, "patches", "y-tiptap", "marks.mjs"), "utf8");
const parts = partsOf(formatSource, marksSource);
const library = join(root, "node_modules", "@tiptap", "y-tiptap");

/** A build as the package ships it: the ES one calls the diff and lib0's map by name. */
const build = (diff = "simpleDiff", map = "map") =>
  [
    "import * as Y from 'yjs';",
    "",
    libraryUpdateYText(diff),
    LIBRARY_ATTRIBUTES_TO_MARKS,
    libraryMarksToAttributes(map),
    "const hashedMarkNameRegex = 1;",
    "",
  ].join("\n");

describe("each build the package ships", () => {
  test.each([
    ["the ES build", "simpleDiff", "map"],
    ["the CommonJS build", "diff.simpleDiff", "map__namespace"],
  ])("%s gets each of our functions in place of the library's, once", (_, diff, map) => {
    const patched = patchBuild(build(diff, map), parts);
    expect(patched.status).toBe("patched");
    expect(patched.text).toContain(patchedUpdateYText(diff, parts.format));
    expect(patched.text).toContain(parts.attributesToMarks);
    expect(patched.text).toContain(parts.marksToAttributes);
    expect(patched.text).not.toContain(libraryUpdateYText(diff));
    expect(patched.text).not.toContain(LIBRARY_ATTRIBUTES_TO_MARKS);
    expect(patched.text).not.toContain(libraryMarksToAttributes(map));
    expect(patched.text).toMatch(/^import \* as Y from 'yjs';/);
    expect(patched.text).toMatch(/const hashedMarkNameRegex = 1;\n$/);
    expect(patchBuild(patched.text, parts)).toEqual({ status: "already", text: patched.text });
  });

  test("a build patched for #2988 only gets #2996's two functions", () => {
    const earlier = build().replace(
      libraryUpdateYText("simpleDiff"),
      patchedUpdateYText("simpleDiff", parts.format),
    );
    const patched = patchBuild(earlier, parts);
    expect(patched.status).toBe("patched");
    expect(patched.text).toContain(parts.attributesToMarks);
    expect(patched.text).toContain(parts.marksToAttributes);
    expect(patched.text.match(/const formatChanges = /g)).toHaveLength(1);
  });

  test("Windows line endings are matched and kept", () => {
    const crlf = build().replace(/\n/g, "\r\n");
    const patched = patchBuild(crlf, parts);
    expect(patched.status).toBe("patched");
    expect(patched.text).toContain("formatChanges(ytext, content)");
    expect(patched.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(patchBuild(patched.text, parts).status).toBe("already");
    expect(
      partsOf(formatSource.replace(/\n/g, "\r\n"), marksSource.replace(/\n/g, "\r\n")),
    ).toEqual(parts);
  });

  // Each function's own guard: changed, found twice, or an older form of ours stops the install.
  const cases = replacementsOf(parts).flatMap(({ name, issue, variants }) => {
    const [first] = variants;
    if (!first) return [];
    return [
      [
        `${name} changed`,
        issue,
        build().replace(first.library, first.library.replace("=>", "=> 0 ||")),
      ],
      [`${name} twice`, issue, build() + first.library],
      [
        `an older form of our ${name}`,
        issue,
        build().replace(first.library, `${first.library.split("\n")[0]}\n  return null;\n};\n`),
      ],
    ] as const;
  });
  test.each(cases)("%s stops the install, naming %s", (_, issue, text) => {
    expect(() => patchBuild(text, parts)).toThrow(new RegExp(issue));
  });

  test("the package gets our functions, not exported", () => {
    expect(parts.format).toMatch(/^const formatChanges = \(ytext, content\) => \{/);
    expect(parts.format).toContain("const sameValue = (a, b) => {");
    expect(parts.attributesToMarks).toMatch(/^const attributesToMarks = \(attrs, schema\) => \{/);
    expect(parts.marksToAttributes).toMatch(/^const marksToAttributes = \(marks, meta\) => \{/);
    for (const part of Object.values(parts)) expect(part).not.toMatch(/^export /m);
    expect(helpersOf(formatSource)).toBe(parts.format);
  });
});

describe("the installed package", () => {
  const message =
    "y-tiptap isn't patched for #2988 and #2996: run npm ci, which runs patches/y-tiptap.mjs.";
  test("is the version the patch is for", () => {
    const { version } = JSON.parse(readFileSync(join(library, "package.json"), "utf8"));
    expect(version).toBe(VERSION);
  });
  test.each(["dist/y-tiptap.js", "dist/y-tiptap.cjs"])("%s already has our functions", (file) => {
    const text = readFileSync(join(library, file), "utf8");
    expect(patchBuild(text, parts).status, message).toBe("already");
  });
});
