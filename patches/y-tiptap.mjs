// Run as postinstall, with Node's built-ins only: gives both builds of @tiptap/y-tiptap that the
// package ships (dist/y-tiptap.js and dist/y-tiptap.cjs) the format step in
// y-tiptap/formatChanges.mjs, so an edit sets marks only on the runs whose marks changed (#2988).
// A build that already has it is left as it is. A build whose updateYText isn't the library's own,
// found once, stops the install: an upgrade of the library waits until someone has looked.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "3.0.9";
const BUILDS = ["dist/y-tiptap.js", "dist/y-tiptap.cjs"];
// The ES build calls the diff by its name, the CommonJS build through its module.
const DIFFS = ["simpleDiff", "diff.simpleDiff"];

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

/** The functions the package gets from formatChanges.mjs: from its first export on, not exported. */
export function helpersOf(source) {
  const text = source.replace(/\r\n/g, "\n");
  const start = text.indexOf("\nexport ");
  if (start < 0) throw new Error("patches/y-tiptap/formatChanges.mjs exports nothing.");
  return text.slice(start + 1).replace(/^export /gm, "");
}

const occurrences = (text, part) => {
  const found = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
};

/**
 * A build's text with the format step: "already" when it has it, "patched" with the new text when
 * it held the library's updateYText once. Line endings are kept as the build had them. Throws,
 * naming #2988, for any other build.
 */
export function patchBuild(text, helpers) {
  const lf = text.replace(/\r\n/g, "\n");
  if (DIFFS.some((diff) => lf.includes(patchedUpdateYText(diff, helpers)))) {
    return { status: "already", text };
  }
  const found = DIFFS.flatMap((diff) =>
    occurrences(lf, libraryUpdateYText(diff)).map((at) => ({ diff, at })),
  );
  const [only] = found;
  if (found.length !== 1 || !only) {
    throw new Error(
      `y-tiptap's updateYText was found ${found.length} times where #2988 replaces it once. ` +
        `If node_modules holds an older form of this patch, run npm ci; if @tiptap/y-tiptap ` +
        `changed, check that #2988's fix still belongs there and update patches/y-tiptap.mjs.`,
    );
  }
  const patched =
    lf.slice(0, only.at) +
    patchedUpdateYText(only.diff, helpers) +
    lf.slice(only.at + libraryUpdateYText(only.diff).length);
  return { status: "patched", text: lf === text ? patched : patched.replace(/\n/g, "\r\n") };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const library = join(here, "..", "node_modules", "@tiptap", "y-tiptap");
  const { version } = JSON.parse(readFileSync(join(library, "package.json"), "utf8"));
  if (version !== VERSION) {
    throw new Error(
      `@tiptap/y-tiptap is ${version}, and #2988's fix is for ${VERSION}: check that the fix ` +
        `still belongs there, then update patches/y-tiptap.mjs.`,
    );
  }
  const helpers = helpersOf(readFileSync(join(here, "y-tiptap", "formatChanges.mjs"), "utf8"));
  for (const build of BUILDS) {
    const file = join(library, build);
    const { status, text } = patchBuild(readFileSync(file, "utf8"), helpers);
    if (status === "patched") writeFileSync(file, text);
    console.log(`@tiptap/y-tiptap ${build}: ${status === "patched" ? "patched" : "already patched"} (#2988)`);
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
