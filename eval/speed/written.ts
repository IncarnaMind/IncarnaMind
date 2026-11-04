/**
 * The written set of a paired run (README.md › Paired runs › The written set): sentences the
 * assistant writes into a new Note, each with its Citation, checked before they land as a write's
 * are (#1667). The writing is scripted, so both arms land the same words and Citations, and only
 * the check's requests go to the model under test: the held-out near-copies (./writtenCases),
 * and the 40-check set's sentences (eval/repeats), each citing the line its search finds first.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { vi } from "vitest";
import type { ChatModelFactory, Core } from "../../src/core";
import { keywordTerms } from "../../src/core/documents/keywords";
import { sentenceSpans } from "../../src/shared/sentences";
import { normaliseText } from "../../src/shared/text";
import { askAssistant } from "../../tests/helpers/assistant";
import { shownPassages } from "../../tests/helpers/citations";
import { type ModelCall, scriptedModel } from "../../tests/helpers/models";
import { buildPdf } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";
import { openLibrary } from "../lib/library";
import { SETS as CHECK_SETS, writeDocuments } from "../repeats/cases";
import { marksOf, outcomeOf } from "../repeats/repeat";
import type { GroupOptions, Measured, PairedGroup, PairedItem } from "./paired";
import { WRITTEN_DOCUMENTS, WRITTEN_ITEMS, type WrittenItem } from "./writtenCases";

/** The 40-check set's Minds, as eval/repeats names them. */
const FORTY = [
  "en",
  "zh",
  "en-control",
  "zh-control",
  "en-conflicts",
  "zh-conflicts",
  "en-paraphrases",
  "zh-paraphrases",
  "en-near-misses",
  "zh-near-misses",
];

/** What one write lands: a paragraph, its last sentence cited. */
interface Plan {
  before?: string;
  sentence: string;
  /** What its Citation quotes; absent: the line of the search's Passages that shares most of its words. */
  quote?: string;
}

const comparable = (text: string) => normaliseText(text).replace(/\s+/gu, "");

/** The sentence of `passages` that shares most of `sentence`'s words, as an assistant would cite it. */
function closestLine(sentence: string, passages: readonly { text: string }[]): string | null {
  const wanted = new Set(keywordTerms(sentence));
  let best: { line: string; shared: number } | null = null;
  for (const { text } of passages) {
    const flat = text.replace(/\s+/gu, " ");
    for (const span of sentenceSpans(flat)) {
      const line = flat.slice(span.from, span.to).trim();
      const shared = keywordTerms(line).filter((term) => wanted.has(term)).length;
      if (!best || shared > best.shared) best = { line, shared };
    }
  }
  return best && best.shared > 0 ? best.line : null;
}

/**
 * The chat models of a core whose assistant writes as the plan says, with no request: a request
 * that offers `create_mind` is the writing's, every other (the checks, the quick model's look)
 * goes to the model under test.
 */
export function scriptedWriter() {
  let plan: Plan | null = null;
  let cited: string | null = null;
  const writer = scriptedModel((call: ModelCall) => {
    const asked = plan;
    if (!asked) return { text: "Nothing to write." };
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) {
      return {
        calls: [{ tool: "search_documents", input: { query: asked.quote ?? asked.sentence } }],
      };
    }
    if (!call.results.some((result) => result.tool === "cite")) {
      const shown = shownPassages(search.text);
      const quote = asked.quote ?? closestLine(asked.sentence, shown) ?? "";
      const passage = shown.find((each) => comparable(each.text).includes(comparable(quote)));
      cited = passage ? quote : null;
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "create_mind")) {
      const paragraph = [asked.before, `${asked.sentence}[^1]`].filter(Boolean).join(" ");
      return {
        calls: [
          {
            tool: "create_mind",
            input: { title: "Written check", content: `## Notes\n\n${paragraph}` },
          },
        ],
      };
    }
    return { text: "Wrote it into a new note." };
  });
  const writes = (params: { tools?: readonly { name: string }[] }) =>
    params.tools?.some((tool) => tool.name === "create_mind") ?? false;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) =>
      writes(params) ? writer.doStream(params) : doStream(),
    wrapGenerate: async ({ doGenerate, params }) =>
      writes(params) ? writer.doGenerate(params) : doGenerate(),
  };
  return {
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(spec), middleware }),
    use(next: Plan) {
      plan = next;
      cited = null;
    },
    /** The quote the last write cited; null when its search found no Passage that holds it. */
    cited: () => cited,
  };
}

type Path = "copy" | "quick" | "check" | "none";

/**
 * One write of one sentence, read from its mark: Supported or not, and which path decided it. A
 * fast path's Supported on a sentence the Documents don't state is the false Supported that stops
 * the arm; the check's own is counted apart, in `failures`, since both arms run that check.
 */
async function writeOne(
  core: Core,
  writer: ReturnType<typeof scriptedWriter>,
  plan: Plan,
  stated: boolean,
  answersModel: string,
  begin: () => void,
): Promise<Measured> {
  writer.use(plan);
  begin();
  const answer = await askAssistant(core, { text: "Write these into a new note." });
  const mindId = answer.toolCalls.find((call) => call.mindChange)?.mindChange?.mindId;
  if (!mindId || writer.cited() === null) {
    return {
      status: "failed",
      error: mindId ? "The search found no Passage with the quote." : "Nothing was written.",
      citations: 0,
      found: 0,
      cited: null,
      grade: null,
      falseSupported: 0,
      duplicate: false,
      failures: [],
      text: plan.sentence,
    };
  }
  // Only the cited sentence is checked before it lands: a sentence before it has no Citation.
  const mark = (await marksOf(core, mindId)).at(-1)?.check;
  const outcome = outcomeOf(mark);
  const path: Path = !mark
    ? "none"
    : mark.wordForWord
      ? "copy"
      : mark.modelId && mark.modelId !== answersModel
        ? "quick"
        : "check";
  const supported = outcome === "supported";
  const wrong = supported !== stated;
  return {
    status: "done",
    error: null,
    citations: 1,
    found: 1,
    cited: null,
    grade: outcome === "not-checked" || outcome === "no-mark" ? null : wrong ? "wrong" : "right",
    falseSupported: supported && !stated && path !== "check" ? 1 : 0,
    duplicate: false,
    failures: [
      ...(supported && !stated && path === "check" ? ["false-supported-by-the-check"] : []),
      ...(outcome === "not-checked" ? ["not-checked"] : []),
    ],
    text: `${path} ${outcome}: ${plan.sentence} | ${writer.cited()}`,
  };
}

/** A paired item for one written sentence. */
function item(
  id: string,
  kind: string,
  language: "en" | "zh-CN",
  plan: Plan,
  stated: boolean,
  writer: ReturnType<typeof scriptedWriter>,
): PairedItem {
  return {
    set: "written",
    id,
    kind,
    language,
    words: "events",
    async run({ library, model }) {
      return writeOne(library.core, writer, plan, stated, model.split("/")[1] ?? model, () =>
        library.timings?.begin(),
      );
    },
  };
}

/** What a set's Library holds, the example's Documents beside, as a newcomer's first run has them. */
async function openWith(
  base: GroupOptions,
  name: string,
  language: "en" | "zh-CN",
  writer: ReturnType<typeof scriptedWriter>,
  write: (folder: string) => Promise<EvalDocument[]>,
  examples: string,
) {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-paired-written-"));
  const library = await openLibrary({
    ...base,
    name,
    documents: await write(folder),
    examples,
    chatModels: (inner) =>
      base.chatModels ? base.chatModels(writer.chatModels(inner)) : writer.chatModels(inner),
  });
  const { core } = library;
  await core.updateSettings({ user: { language } });
  await core.createExamples();
  await vi.waitFor(
    async () => {
      const all = await core.listDocuments();
      if (
        all.length <= library.documents.size ||
        all.some((each) => !["ready", "failed", "no-text"].includes(each.status))
      )
        throw new Error("The example's Documents are still being read.");
    },
    { timeout: 10 * 60_000, interval: 1000 },
  );
  return {
    library,
    async close() {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

const planOf = (each: WrittenItem): Plan => ({
  ...(each.before && { before: each.before }),
  sentence: each.sentence,
  quote: each.quote,
});

export function writtenSet(root: string): PairedGroup[] {
  const examples = join(root, "resources", "examples");
  const heldOut = (["en", "zh-CN"] as const).flatMap((language) =>
    (["terms", "editions"] as const).map((libraryName): PairedGroup => {
      const writer = scriptedWriter();
      const items = WRITTEN_ITEMS.filter(
        (each) => each.language === language && each.library === libraryName,
      );
      return {
        name: `written-${language}-${libraryName}`,
        items: items.map((each) =>
          item(each.id, each.kind, language, planOf(each), each.expected === "stated", writer),
        ),
        open: (base) =>
          openWith(
            base,
            `paired-written-${language}-${libraryName}`,
            language,
            writer,
            async (folder) => {
              const written: EvalDocument[] = [];
              for (const document of WRITTEN_DOCUMENTS) {
                if (document.language !== language || !document.libraries.includes(libraryName))
                  continue;
                const path = join(folder, document.file);
                await writeFile(path, buildPdf(document.pages));
                written.push({ key: document.file, path });
              }
              return written;
            },
            examples,
          ),
      };
    }),
  );
  const forty = CHECK_SETS.filter((set) => FORTY.includes(set.id)).map((set): PairedGroup => {
    const writer = scriptedWriter();
    return {
      name: `written-${set.id}`,
      items: set.sentences
        .filter((sentence) => sentence.knownMiss === undefined)
        .map((sentence) =>
          item(
            `${set.id}:${sentence.key}`,
            set.id,
            set.language,
            { sentence: sentence.text },
            // "Staff" for the agreement's Employee gets the partly-supported card (DESIGN.md ›
            // Checks), so Supported there is no right verdict for a fast path to give.
            sentence.expected === "supported",
            writer,
          ),
        ),
      open: (base) =>
        openWith(
          base,
          `paired-written-${set.id}`,
          set.language,
          writer,
          (folder) => writeDocuments(folder, set),
          examples,
        ),
    };
  });
  return [...heldOut, ...forty];
}
