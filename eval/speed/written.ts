/**
 * The written set of a paired run (README.md › Paired runs › The written set): sentences the
 * assistant writes into a new Note, each with its Citation, checked before they land as a write's
 * are, the quick model looking first on one arm (#1667). The writing is scripted, so both arms land the same words and Citations, and only
 * the check's requests go to the model under test: the held-out near-copies (./writtenCases),
 * and the 40-check set's sentences (eval/repeats), each citing the line its search finds first.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory, Core } from "../../src/core";
import { mayLookFirst } from "../../src/core/answers/checks/fastPaths";
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
import {
  WRITTEN_DOCUMENTS,
  WRITTEN_ITEMS,
  type WrittenDocument,
  type WrittenItem,
} from "./writtenCases";
import { HELD_OUT_DOCUMENTS, HELD_OUT_ITEMS } from "./writtenHeldOut";
import { THIRD_DOCUMENTS, THIRD_ITEMS } from "./writtenHeldOut3";

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
  /** A paragraph before the sentence's, with no Citation. */
  paragraphBefore?: string;
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
      const passage = quote
        ? shown.find((each) => comparable(each.text).includes(comparable(quote)))
        : undefined;
      cited = passage ? quote : null;
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "create_mind")) {
      const paragraph = [asked.before, `${asked.sentence}[^1]`].filter(Boolean).join(" ");
      const content = ["## Notes", asked.paragraphBefore, paragraph].filter(Boolean).join("\n\n");
      return { calls: [{ tool: "create_mind", input: { title: "Written check", content } }] };
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

type Path = "quick" | "check" | "none";

/**
 * One write of one sentence, read from its mark: Supported or not, and whether the quick model or
 * the check's Run decided it. A false Supported counts on the arm that has no first look, and on
 * the other only where the quick model gave it, so one counts as new where the quick model gave
 * it and today's check didn't; the check's own on that arm, the same check today's arm runs, is
 * listed apart, in `failures`.
 */
async function writeOne(
  core: Core,
  writer: ReturnType<typeof scriptedWriter>,
  plan: Plan & { neverAsked: boolean },
  stated: boolean,
  { answersModel, looksFirst }: { answersModel: string; looksFirst: boolean },
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
      searches: null,
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
    : mark.modelId && mark.modelId !== answersModel
      ? "quick"
      : "check";
  const supported = outcome === "supported";
  const wrong = supported !== stated;
  const counted = path === "quick" || !looksFirst;
  return {
    status: "done",
    error: null,
    searches: null,
    citations: 1,
    found: 1,
    cited: null,
    grade: outcome === "not-checked" || outcome === "no-mark" ? null : wrong ? "wrong" : "right",
    falseSupported: supported && !stated && counted ? 1 : 0,
    duplicate: false,
    failures: [
      ...(supported && !stated && path === "check" ? ["false-supported-by-the-check"] : []),
      // Listed whether or not today's check erred too, so none hides behind the pairing.
      ...(supported && !stated && path === "quick" ? ["false-supported-by-the-quick-model"] : []),
      ...(outcome === "not-checked" ? ["not-checked"] : []),
      // A sentence with a figure or a time, or one another Document holds, is never looked at first.
      ...(plan.neverAsked && path === "quick" ? ["looked-at-first"] : []),
    ],
    // The Passage the verdict rests on, so a Supported that cites another Document shows as one.
    text: `${path} ${outcome}: ${plan.sentence} | cites “${writer.cited()}” | rests on ${
      mark?.evidence
        ? `${mark.evidence.documentName ?? "a Document"}: “${mark.evidence.quote ?? ""}”`
        : "no Passage"
    }`,
  };
}

/** A paired item for one written sentence. */
function item(
  id: string,
  kind: string,
  language: "en" | "zh-CN",
  plan: Plan & { neverAsked: boolean },
  stated: boolean,
  writer: ReturnType<typeof scriptedWriter>,
): PairedItem {
  return {
    set: "written",
    id,
    kind,
    language,
    words: "events",
    async run({ library, model, arm }) {
      return writeOne(
        library.core,
        writer,
        plan,
        stated,
        { answersModel: model.slice(model.indexOf("/") + 1), looksFirst: arm === "quick-look" },
        () => library.timings?.begin(),
      );
    },
  };
}

/**
 * A Library of the case's own Documents only, one per case: a check that searched another case's
 * Documents could rest a Supported on one that says the decoy's words.
 */
async function openWith(
  base: GroupOptions,
  name: string,
  language: "en" | "zh-CN",
  writer: ReturnType<typeof scriptedWriter>,
  write: (folder: string) => Promise<EvalDocument[]>,
) {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-paired-written-"));
  const library = await openLibrary({
    ...base,
    name,
    documents: await write(folder),
    chatModels: (inner) =>
      base.chatModels ? base.chatModels(writer.chatModels(inner)) : writer.chatModels(inner),
  });
  const { core } = library;
  await core.updateSettings({ user: { language } });
  return {
    library,
    async close() {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

const planOf = (each: WrittenItem): Plan & { neverAsked: boolean } => ({
  ...(each.paragraphBefore && { paragraphBefore: each.paragraphBefore }),
  ...(each.before && { before: each.before }),
  sentence: each.sentence,
  quote: each.quote,
  neverAsked: each.fastPath === "none",
});

/** Each held-out case written alone, in a Note of its own and a Library of only its Documents. */
function heldOutGroups(
  setName: string,
  setItems: readonly WrittenItem[],
  setDocuments: readonly WrittenDocument[],
): PairedGroup[] {
  return setItems.map((each): PairedGroup => {
    const writer = scriptedWriter();
    const { language, library } = each;
    return {
      name: `${setName}-${language}-${each.id}`,
      items: [item(each.id, each.kind, language, planOf(each), each.expected === "stated", writer)],
      open: (base) =>
        openWith(base, `paired-${setName}-${each.id}`, language, writer, async (folder) => {
          const written: EvalDocument[] = [];
          for (const document of setDocuments) {
            if (document.language !== language || !document.libraries.includes(library)) continue;
            const path = join(folder, document.file);
            await writeFile(path, buildPdf(document.pages));
            written.push({ key: document.file, path });
          }
          return written;
        }),
    };
  });
}

/** The third held-out set alone (./writtenHeldOut3), for the verdict beside `cite` (#2532). */
export const writtenThirdSet = (): PairedGroup[] =>
  heldOutGroups("written3", THIRD_ITEMS, THIRD_DOCUMENTS);

export function writtenSet(): PairedGroup[] {
  const heldOut = [
    ...heldOutGroups("written", WRITTEN_ITEMS, WRITTEN_DOCUMENTS),
    ...heldOutGroups("written2", HELD_OUT_ITEMS, HELD_OUT_DOCUMENTS),
  ];
  const forty = CHECK_SETS.filter((set) => FORTY.includes(set.id)).map((set): PairedGroup => {
    const writer = scriptedWriter();
    return {
      name: `written-${set.id}`,
      // A sentence with a figure or a time goes straight to its check on both arms: no item.
      items: set.sentences
        .filter((sentence) => sentence.knownMiss === undefined && mayLookFirst(sentence.text, 0))
        .map((sentence) =>
          item(
            `${set.id}:${sentence.key}`,
            set.id,
            set.language,
            { sentence: sentence.text, neverAsked: false },
            // "Staff" for the agreement's Employee gets the partly-supported card (DESIGN.md ›
            // Checks), so Supported there is no right verdict for the quick model to give.
            sentence.expected === "supported",
            writer,
          ),
        ),
      open: (base) =>
        openWith(base, `paired-written-${set.id}`, set.language, writer, (folder) =>
          writeDocuments(folder, set),
        ),
    };
  });
  return [...heldOut, ...forty];
}
