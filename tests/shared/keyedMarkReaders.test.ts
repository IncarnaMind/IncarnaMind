import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import * as api from "../../src/core/api";
import { KEYED_MARKS } from "../../src/shared/markKeys";

/*
 * A check, a comment or an assistant's change is kept in a Note's Yjs text under a format key of its
 * own, the mark's name, `--` and eight characters of its id (#2996), so a reader that looks for it
 * under the mark's name alone sees none. Every reader asks `markValueOf` or `hasMarkIn`
 * (src/shared/markKeys.ts); two that didn't went unseen from version 57 on (#3024). This reads the
 * source of `src` and `eval` as text and names each place that takes one of the four marks from a
 * run's `attributes` by its name, as a constant or as the word, in an index, a property, `in`, a
 * destructuring or `hasOwn`.
 *
 * What it leaves alone: the editor's ProseMirror (`schema.marks[CLAIM_CHECK_MARK]`, a node's `attrs`,
 * its marks by `type.name`) and a Yjs element's own attributes (`getAttribute(CLAIM_CHECK_MARK)`),
 * which are not text formats; and a read by a variable's name, as the conversion of Notes saved
 * before makes (src/core/markKeys.ts).
 */

const ROOT = join(__dirname, "../..");

/** The constants of the core's API that hold one of the keyed marks' names. */
const IDENTIFIERS = Object.entries(api)
  .filter(([, value]) => KEYED_MARKS.some((name) => name === value))
  .map(([name]) => name)
  .sort();

const NAMES = [...KEYED_MARKS].sort();
const quoted = NAMES.flatMap((name) => [`"${name}"`, `'${name}'`]);
const KEY = `(?:${[...IDENTIFIERS, ...quoted].join("|")})`;
const BAG = String.raw`(?:[\w$]+\s*\??\.\s*)*attributes\b`;

/** How a run's formats are read by a mark's bare name, each as a pattern over source with no comments. */
const READS: Record<string, RegExp> = {
  "an index": new RegExp(String.raw`\battributes\s*(?:\?\.\s*)?\[\s*${KEY}\s*\]`, "g"),
  "a property": new RegExp(String.raw`\battributes\s*\??\.\s*(?:${NAMES.join("|")})\b`, "g"),
  in: new RegExp(String.raw`${KEY}\s+in\s+${BAG}`, "g"),
  "a destructuring": new RegExp(
    String.raw`\{[^{}]*(?:\b(?:${NAMES.join("|")})\b|\[\s*(?:${IDENTIFIERS.join("|")})\s*\])[^{}]*\}\s*=\s*${BAG}`,
    "g",
  ),
  hasOwn: new RegExp(
    String.raw`hasOwn(?:Property)?\(\s*${BAG}\s*,\s*${KEY}|${BAG}\s*\.\s*hasOwnProperty\(\s*${KEY}`,
    "g",
  ),
};

const COMMENT_OR_STRING =
  /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Source with its comments blanked and its strings emptied but a mark's name, lines kept as they were. */
function code(text: string): string {
  return text.replace(COMMENT_OR_STRING, (match, string?: string) => {
    if (string !== undefined) return quoted.includes(string) ? string : `${string[0]}${string[0]}`;
    return match.startsWith("`") ? match : match.replace(/[^\n]/g, " ");
  });
}

/** Where `source` reads a keyed mark from a run's `attributes` by its bare name: "line 12, an index". */
function bareReads(source: string): string[] {
  const text = code(source);
  return Object.entries(READS).flatMap(([how, pattern]) =>
    [...text.matchAll(pattern)].map(
      (match) => `line ${text.slice(0, match.index).split("\n").length}, ${how}`,
    ),
  );
}

interface Source {
  path: string;
  text: string;
}

function sourcesIn(folder: string): Source[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sourcesIn(path);
    if (!/\.[cm]?[jt]sx?$/.test(name)) return [];
    return [{ path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }];
  });
}

describe("the four marks it looks for", () => {
  test("are the constants the core's API names them by", () => {
    expect(IDENTIFIERS).toEqual([
      "CLAIM_CHECK_MARK",
      "COMMENT_MARK",
      "PROPOSAL_DELETE_MARK",
      "PROPOSAL_INSERT_MARK",
    ]);
  });
});

describe("a read of a run's formats by a mark's bare name", () => {
  test("is in no file under src or eval: ask markValueOf or hasMarkIn (src/shared/markKeys.ts)", () => {
    const files = [...sourcesIn(join(ROOT, "src")), ...sourcesIn(join(ROOT, "eval"))];
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["src/core/proposals/placed.ts", "eval/word/exports.ts"]),
    );
    const found = files.flatMap((file) =>
      bareReads(file.text).map((where) => `${file.path}: ${where}`),
    );
    expect(found).toEqual([]);
  });

  describe("is seen in", () => {
    test.each([
      [
        "paragraphPlaces as it was, the words an assistant's change adds",
        "const added = run.attributes?.[PROPOSAL_INSERT_MARK];",
        ["line 1, an index"],
      ],
      [
        "paragraphPlaces as it was, the words it takes out",
        "const removed = run.attributes?.[PROPOSAL_DELETE_MARK];",
        ["line 1, an index"],
      ],
      [
        "the Word evaluation's list of changes as it was",
        `add(run.attributes?.[PROPOSAL_INSERT_MARK], "insert", text);\n add(run.attributes?.[PROPOSAL_DELETE_MARK], "delete", text);`,
        ["line 1, an index", "line 2, an index"],
      ],
      ["a check", "const check = attributes[CLAIM_CHECK_MARK];", ["line 1, an index"]],
      [
        "a comment",
        "const found = run.attributes?.[COMMENT_MARK] !== undefined;",
        ["line 1, an index"],
      ],
      [
        "the name as a word",
        `const added = run.attributes?.["proposalInsert"];`,
        ["line 1, an index"],
      ],
      [
        "the name as a property",
        "const check = run.attributes.claimCheck;",
        ["line 1, a property"],
      ],
      [
        "the name as a property, optional",
        "run.attributes?.proposalDelete",
        ["line 1, a property"],
      ],
      [
        "in, with the constant",
        "if (PROPOSAL_INSERT_MARK in run.attributes) skip();",
        ["line 1, in"],
      ],
      ["in, with the word", `if ("comment" in attributes) skip();`, ["line 1, in"]],
      [
        "a destructuring by the name",
        "const { proposalDelete } = run.attributes;",
        ["line 1, a destructuring"],
      ],
      [
        "a destructuring by the constant",
        "const { [COMMENT_MARK]: comment } = attributes;",
        ["line 1, a destructuring"],
      ],
      ["hasOwn", "Object.hasOwn(run.attributes, CLAIM_CHECK_MARK)", ["line 1, hasOwn"]],
      [
        "a read over two lines",
        "const added = run.attributes\n  ?.[PROPOSAL_INSERT_MARK];",
        ["line 1, an index"],
      ],
      [
        "a read after a comment that spans lines",
        "/* one\n two */\nconst added = run.attributes[PROPOSAL_INSERT_MARK];",
        ["line 3, an index"],
      ],
    ])("%s", (_, source, where) => {
      expect(bareReads(source)).toEqual(where);
    });
  });

  describe("is not seen in", () => {
    test.each([
      ["the editor's schema", "const type = editor.state.schema.marks[CLAIM_CHECK_MARK];"],
      ["a node's attributes in the editor", "const check = block.attrs[CLAIM_CHECK_MARK];"],
      ["a node's attributes, a comment", "const found = child.attrs[COMMENT_MARK];"],
      [
        "a node's mark by its type",
        "node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK);",
      ],
      ["a Yjs element's own attribute", "const raw = element.getAttribute(CLAIM_CHECK_MARK);"],
      [
        "a Yjs element's own attribute, written",
        "element.setAttribute(CLAIM_CHECK_MARK, { ...check });",
      ],
      [
        "a node's attributes written back",
        "tr.setNodeMarkup(from, undefined, { ...owner.attrs, [CLAIM_CHECK_MARK]: check });",
      ],
      ["the reader every other one uses", "markValueOf(PROPOSAL_INSERT_MARK, run.attributes);"],
      ["the other reader", "hasMarkIn(PROPOSAL_DELETE_MARK, run.attributes);"],
      ["a mark that has no key of its own", "const made = run.attributes?.[GENERATED_MARK];"],
      ["a read by a variable's name", "const value = run.attributes?.[name];"],
      ["another property of the run's formats", "const quote = run.attributes.quote;"],
      ["a map named like it", "const kept = attributesOf.get(CLAIM_CHECK_MARK);"],
      ["a line comment", "// it was run.attributes?.[PROPOSAL_INSERT_MARK] before"],
      ["a block comment", "/** Read `run.attributes[COMMENT_MARK]`: no longer. */\nconst a = 1;"],
      ["words in a string", `const said = "read run.attributes[COMMENT_MARK] by name";`],
    ])("%s", (_, source) => {
      expect(bareReads(source)).toEqual([]);
    });
  });
});
