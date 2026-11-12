// Run as postinstall, with Node's built-ins only: sets our functions in place of three of
// @tiptap/y-tiptap's, in both builds the package ships (dist/y-tiptap.js and dist/y-tiptap.cjs):
// - updateYText, with the format step in y-tiptap/formatChanges.mjs, so an edit sets only the
//   marks that changed (#2988);
// - attributesToMarks and marksToAttributes, from y-tiptap/marks.mjs, so each check, comment and
//   assistant's change is kept under a key of its own (#2996).
// A function already ours is left as it is. One that isn't the library's own, found once, stops the
// install: an upgrade of the library waits until someone has looked.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "3.0.9";
const BUILDS = ["dist/y-tiptap.js", "dist/y-tiptap.cjs"];
// The ES build calls the diff and lib0's map by their names, the CommonJS build through modules.
const DIFFS = ["simpleDiff", "diff.simpleDiff"];
const MAPS = ["map", "map__namespace"];

const updateYText = (diff, format) => `const updateYText = (ytext, ptexts, meta) => {
  meta.mapping.set(ytext, ptexts);
  const { nAttrs, str } = ytextTrans(ytext);
  const content = ptexts.map((p) => ({
    insert: /** @type {any} */ (p).text,
    attributes: Object.assign({}, nAttrs, marksToAttributes(p.marks, meta))
  }));
  const { insert, remove, index } = ${diff}(
    str,
    content.map((c) => c.insert).join('')
  );
  ytext.delete(index, remove);
  ytext.insert(index, insert);
${format}
};
`;

/** The library's own updateYText, as 3.0.9 ships it in the build that calls the diff as `diff`. */
export const libraryUpdateYText = (diff) =>
  updateYText(
    diff,
    `  ytext.applyDelta(
    content.map((c) => ({ retain: c.insert.length, attributes: c.attributes }))
  );`,
  );

/** updateYText with the format step, followed by the step's own functions (`helpers`). */
export const patchedUpdateYText = (diff, helpers) =>
  `${updateYText(diff, "  ytext.applyDelta(formatChanges(ytext, content));")}\n${helpers}`;

/** The library's own attributesToMarks, the same in both builds. */
export const LIBRARY_ATTRIBUTES_TO_MARKS = `const attributesToMarks = (attrs, schema) => {
  /**
   * @type {Array<import('prosemirror-model').Mark>}
   */
  const marks = [];
  for (const markName in attrs) {
    // remove hashes if necessary
    marks.push(schema.mark(yattr2markname(markName), attrs[markName]));
  }
  return marks
};
`;

/** The library's own marksToAttributes, in the build that calls lib0's map as `map`. */
export const libraryMarksToAttributes = (map) => `const marksToAttributes = (marks, meta) => {
  const pattrs = {};
  marks.forEach((mark) => {
    if (mark.type.name !== 'ychange') {
      const isOverlapping = ${map}.setIfUndefined(meta.isOMark, mark.type, () => !mark.type.excludes(mark.type));
      pattrs[isOverlapping ? \`\${mark.type.name}--\${hashOfJSON(mark.toJSON())}\` : mark.type.name] = mark.attrs;
    }
  });
  return pattrs
};
`;

/** The functions the package gets from formatChanges.mjs: from its first export on, not exported. */
export function helpersOf(source) {
  const text = source.replace(/\r\n/g, "\n");
  const start = text.indexOf("\nexport ");
  if (start < 0) throw new Error("patches/y-tiptap/formatChanges.mjs exports nothing.");
  return text.slice(start + 1).replace(/^export /gm, "");
}

/** One function of marks.mjs as the package gets it: its own text, not exported. */
function functionOf(source, name) {
  const text = source.replace(/\r\n/g, "\n");
  const start = text.indexOf(`\nexport const ${name} = `);
  const end = text.indexOf("\n};\n", start);
  if (start < 0 || end < 0) throw new Error(`patches/y-tiptap/marks.mjs has no ${name}.`);
  return text.slice(start + 1, end + 4).replace(/^export /, "");
}

/** What the package gets from our files: the format step's functions and the two mark functions. */
export function partsOf(formatSource, marksSource) {
  return {
    format: helpersOf(formatSource),
    attributesToMarks: functionOf(marksSource, "attributesToMarks"),
    marksToAttributes: functionOf(marksSource, "marksToAttributes"),
  };
}

/** Each function set at install: the issue it is for, and the library's text with ours for it. */
export const replacementsOf = (parts) => [
  {
    name: "updateYText",
    issue: "#2988",
    variants: DIFFS.map((diff) => ({
      library: libraryUpdateYText(diff),
      ours: patchedUpdateYText(diff, parts.format),
    })),
  },
  {
    name: "attributesToMarks",
    issue: "#2996",
    variants: [{ library: LIBRARY_ATTRIBUTES_TO_MARKS, ours: parts.attributesToMarks }],
  },
  {
    name: "marksToAttributes",
    issue: "#2996",
    variants: MAPS.map((map) => ({
      library: libraryMarksToAttributes(map),
      ours: parts.marksToAttributes,
    })),
  },
];

const occurrences = (text, part) => {
  const found = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
};

/**
 * A build's text with our functions: "already" when it has every one, "patched" with the new text
 * when it held the library's own of each that was missing, once. Line endings are kept as the build
 * had them. Throws, naming the function's issue, for any other build.
 */
export function patchBuild(text, parts) {
  let lf = text.replace(/\r\n/g, "\n");
  let replaced = false;
  for (const { name, issue, variants } of replacementsOf(parts)) {
    if (variants.some(({ ours }) => lf.includes(ours))) continue;
    const found = variants.flatMap((variant) =>
      occurrences(lf, variant.library).map((at) => ({ variant, at })),
    );
    const [only] = found;
    if (found.length !== 1 || !only) {
      throw new Error(
        `y-tiptap's ${name} was found ${found.length} times where ${issue} replaces it once. ` +
          `If node_modules holds an older form of this patch, run npm ci; if @tiptap/y-tiptap ` +
          `changed, check that ${issue}'s fix still belongs there and update patches/y-tiptap.mjs.`,
      );
    }
    lf =
      lf.slice(0, only.at) + only.variant.ours + lf.slice(only.at + only.variant.library.length);
    replaced = true;
  }
  if (!replaced) return { status: "already", text };
  return { status: "patched", text: text.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const library = join(here, "..", "node_modules", "@tiptap", "y-tiptap");
  const { version } = JSON.parse(readFileSync(join(library, "package.json"), "utf8"));
  if (version !== VERSION) {
    throw new Error(
      `@tiptap/y-tiptap is ${version}, and #2988's and #2996's fixes are for ${VERSION}: check ` +
        `that they still belong there, then update patches/y-tiptap.mjs.`,
    );
  }
  const parts = partsOf(
    readFileSync(join(here, "y-tiptap", "formatChanges.mjs"), "utf8"),
    readFileSync(join(here, "y-tiptap", "marks.mjs"), "utf8"),
  );
  for (const build of BUILDS) {
    const file = join(library, build);
    const { status, text } = patchBuild(readFileSync(file, "utf8"), parts);
    if (status === "patched") writeFileSync(file, text);
    console.log(
      `@tiptap/y-tiptap ${build}: ${status === "patched" ? "patched" : "already patched"} (#2988, #2996)`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`patches/y-tiptap.mjs: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
