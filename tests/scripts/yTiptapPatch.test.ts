import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  helpersOf,
  LIBRARY_ATTRIBUTES_TO_MARKS,
  LIBRARY_UNDO_VIEW,
  libraryMarksToAttributes,
  libraryUpdateYText,
  PATCHED_UNDO_VIEW,
  partsOf,
  patchBuild,
  patchedUpdateYText,
  replacementsOf,
  VERSION,
} from "../../patches/y-tiptap.mjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { stubEditorDom } from "../helpers/editorDom";

/*
 * patches/y-tiptap.mjs, run at install, sets three of our functions in both builds of the editor's
 * Yjs sync: the format step that keeps an edit off marks it didn't change (#2988), and the two that
 * keep each check under a key of its own (#2996); and the undo plugin's view, so a history a tab
 * keeps outlives each editor (#3115). It stops the install for a build it doesn't know.
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
    LIBRARY_UNDO_VIEW,
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
    expect(patched.text).toContain(PATCHED_UNDO_VIEW);
    expect(patched.text).not.toContain(LIBRARY_UNDO_VIEW);
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

  test("a build patched for #2988 and #2996 only gets #3115's undo view", () => {
    const earlier = build()
      .replace(libraryUpdateYText("simpleDiff"), patchedUpdateYText("simpleDiff", parts.format))
      .replace(LIBRARY_ATTRIBUTES_TO_MARKS, parts.attributesToMarks)
      .replace(libraryMarksToAttributes("map"), parts.marksToAttributes);
    const patched = patchBuild(earlier, parts);
    expect(patched.status).toBe("patched");
    expect(patched.text).toBe(earlier.replace(LIBRARY_UNDO_VIEW, PATCHED_UNDO_VIEW));
  });

  test("the undo view ends only a history it made, and takes off only its own listeners", () => {
    expect(PATCHED_UNDO_VIEW).toContain("undoManager.off('stack-item-added', added);");
    expect(PATCHED_UNDO_VIEW).toContain("undoManager.off('stack-item-popped', popped);");
    expect(PATCHED_UNDO_VIEW).toMatch(
      /if \(undoManager\._yTiptapDocDestroyListeners === undefined\) return;\n\s+undoManager\.destroy\(\);\n$/,
    );
    expect(PATCHED_UNDO_VIEW.match(/meta\.(set|get)\(binding\.type/g)).toHaveLength(2);
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
    "y-tiptap isn't patched for #2988, #2996 and #3115: run npm ci, which runs patches/y-tiptap.mjs.";
  test("is the version the patch is for", () => {
    const { version } = JSON.parse(readFileSync(join(library, "package.json"), "utf8"));
    expect(version).toBe(VERSION);
  });
  test.each(["dist/y-tiptap.js", "dist/y-tiptap.cjs"])("%s already has our functions", (file) => {
    const text = readFileSync(join(library, file), "utf8");
    expect(patchBuild(text, parts).status, message).toBe("already");
  });

  /** How many listeners `of` has for `event`. */
  const listening = (of: object, event: string) =>
    (of as { _observers: Map<string, Set<unknown>> })._observers.get(event)?.size ?? 0;

  /** Writes in the Note as an editor's own change, which its history takes as a step. */
  const typed = (doc: Y.Doc) =>
    doc.transact(() => {
      doc.getXmlFragment(MIND_CONTENT_FIELD).push([new Y.XmlElement("paragraph")]);
    }, ySyncPluginKey);

  // protects=the patched undo view, run in a real editor: an editor with no history of the tab's ends the one the plugin made for it and takes off the doc 'destroy' listener that history left, and an editor given a tab's history leaves it alive, recording, with none of the editor's own listeners left on it (#3115); fails_when=an editor ends a history it was given, leaves one of its listeners on it, or leaves its own history running or listening to the doc; no_claim=the patch's text, which the tests above read.
  test("an editor ends the history it made, and leaves one it was given as it found it", () => {
    stubEditorDom();
    try {
      const doc = new Y.Doc();
      const editorOf = (undoManager?: Y.UndoManager) =>
        new Editor({
          element: document.createElement("div"),
          extensions: [
            ...noteExtensions(),
            Collaboration.configure({
              document: doc,
              field: MIND_CONTENT_FIELD,
              ...(undoManager && { yUndoOptions: { undoManager } }),
            }),
          ],
        });
      const docListeners = listening(doc, "destroy");
      const own = editorOf();
      const made = yUndoPluginKey.getState(own.state)?.undoManager;
      if (!made) throw new Error("The editor has no history.");
      expect(listening(doc, "destroy")).toBeGreaterThan(docListeners);
      own.destroy();
      expect(listening(doc, "destroy")).toBe(docListeners);
      expect(listening(made, "stack-item-added")).toBe(0);
      typed(doc);
      expect(made.undoStack).toHaveLength(0);

      const kept = new Y.UndoManager(doc.getXmlFragment(MIND_CONTENT_FIELD), {
        trackedOrigins: new Set([ySyncPluginKey]),
      });
      const before = ["stack-item-added", "stack-item-popped"].map((event) =>
        listening(kept, event),
      );
      const withKept = listening(doc, "destroy");
      const shown = editorOf(kept);
      expect(yUndoPluginKey.getState(shown.state)?.undoManager).toBe(kept);
      expect(listening(kept, "stack-item-added")).toBeGreaterThan(before[0] ?? 0);
      shown.destroy();
      expect(
        ["stack-item-added", "stack-item-popped"].map((event) => listening(kept, event)),
      ).toEqual(before);
      expect(listening(doc, "destroy")).toBe(withKept);
      typed(doc);
      expect(kept.undoStack).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
