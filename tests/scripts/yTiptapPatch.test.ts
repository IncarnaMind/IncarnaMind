import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  helpersOf,
  libraryUpdateYText,
  patchBuild,
  patchedUpdateYText,
  VERSION,
} from "../../patches/y-tiptap.mjs";

/*
 * patches/y-tiptap.mjs, run at install, gives both builds of the editor's Yjs sync the format step
 * that keeps an edit off marks it didn't change (#2988), and stops the install for a build it
 * doesn't know.
 */

const root = join(__dirname, "..", "..");
const source = readFileSync(join(root, "patches", "y-tiptap", "formatChanges.mjs"), "utf8");
const helpers = helpersOf(source);
const library = join(root, "node_modules", "@tiptap", "y-tiptap");
const build = (diff: string) =>
  `import * as Y from 'yjs';\n\n${libraryUpdateYText(diff)}\nconst hashedMarkNameRegex = 1;\n`;

describe("each build the package ships", () => {
  test.each(["simpleDiff", "diff.simpleDiff"])(
    "the library's updateYText, calling %s, gets the format step, once",
    (diff) => {
      const patched = patchBuild(build(diff), helpers);
      expect(patched.status).toBe("patched");
      expect(patched.text).toContain(patchedUpdateYText(diff, helpers));
      expect(patched.text).toContain("ytext.applyDelta(formatChanges(ytext, content));");
      expect(patched.text).not.toContain(libraryUpdateYText(diff));
      expect(patched.text).toMatch(/^import \* as Y from 'yjs';/);
      expect(patched.text).toMatch(/const hashedMarkNameRegex = 1;\n$/);
      expect(patchBuild(patched.text, helpers)).toEqual({ status: "already", text: patched.text });
    },
  );

  test("Windows line endings are matched and kept", () => {
    const crlf = build("simpleDiff").replace(/\n/g, "\r\n");
    const patched = patchBuild(crlf, helpers);
    expect(patched.status).toBe("patched");
    expect(patched.text).toContain("formatChanges(ytext, content)");
    expect(patched.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(patchBuild(patched.text, helpers).status).toBe("already");
    expect(helpersOf(source.replace(/\n/g, "\r\n"))).toBe(helpers);
  });

  test.each([
    ["the library's updateYText changed", build("simpleDiff").replace("ytextTrans", "textOf")],
    ["two copies of it", build("simpleDiff") + libraryUpdateYText("simpleDiff")],
    [
      "an older form of this patch",
      build("simpleDiff").replace(
        libraryUpdateYText("simpleDiff"),
        patchedUpdateYText("simpleDiff", "const formatChanges = () => [];\n"),
      ),
    ],
  ])("%s stops the install, naming #2988", (_, text) => {
    expect(() => patchBuild(text, helpers)).toThrow(/#2988/);
  });

  test("the package gets the format step's functions, not exported", () => {
    expect(helpers).toMatch(/^const formatChanges = \(ytext, content\) => \{/);
    expect(helpers).toContain("const sameValue = (a, b) => {");
    expect(helpers).not.toMatch(/^export /m);
  });
});

describe("the installed package", () => {
  const message = "y-tiptap isn't patched for #2988: run npm ci, which runs patches/y-tiptap.mjs.";
  test("is the version the patch is for", () => {
    const { version } = JSON.parse(readFileSync(join(library, "package.json"), "utf8"));
    expect(version).toBe(VERSION);
  });
  test.each(["dist/y-tiptap.js", "dist/y-tiptap.cjs"])("%s already has the format step", (file) => {
    const text = readFileSync(join(library, file), "utf8");
    expect(patchBuild(text, helpers).status, message).toBe("already");
  });
});
