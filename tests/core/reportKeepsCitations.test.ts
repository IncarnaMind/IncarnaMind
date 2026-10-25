import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  type CitationAttributes,
  type ConversationAnswer,
  type Core,
  type Document,
  messageReference,
} from "../../src/core";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { citationState } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import { checkReply, isCheckRun } from "../helpers/checks";
import {
  answerEnded,
  citingModel,
  contextOfNextQuestion,
  setUpWithDocuments,
} from "../helpers/citations";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";
import { part, textOf, unzip } from "../helpers/docx";
import type { MindClient } from "../helpers/mindClient";
import { editMind, heading, note, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * A Mind's Citations stay working Citations when an Answer turns the Mind into a report (#1800):
 * the model reads each with an id, keeps it by that id, and the Answer's Citation is the Mind's
 * own (its Document, version, Location and quote), through a new Mind and its exports. No id is
 * ever stored or shown, and a source that can't be kept is said so.
 */

const ATTENTION =
  "The Transformer is based solely on attention mechanisms, dispensing with recurrence entirely.";
const BLEU = "The big model reaches 28.4 BLEU on the English-to-German translation task.";
const OVERVIEW = "Transformers were later applied to vision, speech and protein folding.";

const pdfs = () => [
  {
    name: "Attention.pdf",
    contents: buildPdf([{ lines: ["Abstract", ATTENTION] }, { lines: ["Results", BLEU] }]),
  },
  { name: "Overview.pdf", contents: buildPdf([{ lines: ["Later work", OVERVIEW] }]) },
];

const named = (documents: readonly Document[], name: string) => {
  const found = documents.find((each) => each.name === name);
  if (!found) throw new Error(`No Document ${name}.`);
  return found;
};

/** A Citation of words on a page of a Document, as Cite… in a Note makes one. */
async function citationOf(core: Core, document: Document, page: number, words: string) {
  const cited = await core.citeSelection({
    documentId: document.id,
    parts: [{ unit: page, text: words }],
  });
  expect(cited.check).toBe("found");
  return {
    passageId: cited.passageId,
    documentId: document.id,
    documentName: document.name,
    contentHash: cited.contentHash,
    pageFrom: cited.pageFrom,
    pageTo: cited.pageTo,
    location: cited.location,
    quote: cited.quote,
    check: cited.check,
    checkReason: cited.checkReason,
  };
}

/** A Citation whose Passage is no longer in the Library. */
const GONE = {
  passageId: "gone",
  documentId: "gone",
  documentName: "Tides",
  contentHash: "h",
  pageFrom: 2,
  pageTo: 2,
  quote: "Spring tides come at full moon.",
  check: "found",
};

const cited = (claim: string, citation: Record<string, unknown>) => {
  const block = note(claim);
  block.content?.push({ type: "citation", attrs: citation }, { type: "text", text: "." });
  return block;
};

/** A cited review of the two Documents, with a limitation that carries no Citation. */
async function writeReview(core: Core, client: MindClient, documents: readonly Document[]) {
  const attention = named(documents, "Attention");
  const citations = [
    await citationOf(core, attention, 1, ATTENTION),
    await citationOf(core, attention, 2, BLEU),
    await citationOf(core, named(documents, "Overview"), 1, OVERVIEW),
  ];
  writeMind(client, [
    heading(1, "Thematic review"),
    cited("The Transformer drops recurrence", citations[0] ?? {}),
    cited("It reached 28.4 BLEU", citations[1] ?? {}),
    cited("Later work took it to other fields", citations[2] ?? {}),
    note("These two Documents do not establish a unified evaluation across later domains."),
  ]);
  await client.settled();
  return citations;
}

const idsShown = (text: string) => [...text.matchAll(/· (C\d+)\]/g)].map((match) => match[1]);

/** A model that records each Citation it reads by its id (unless `cite` is false), then writes `answer`. */
function reportModel(answer: (prompt: string) => string, cite = true) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (isCheckRun(call)) return checkReply(call, {});
    if (cite && !call.results.some((result) => result.tool === "cite")) {
      const ids = [...new Set(idsShown(call.prompt))];
      const citations = ids.map((id, index) => ({ marker: index + 1, passage: id }));
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    return { text: answer(call.prompt) };
  });
}

const REPORT = [
  "# Transformer report",
  "",
  "The Transformer drops recurrence [^1]. Its big model reached 28.4 BLEU [^2]. Later work took it to vision and speech [^3].",
  "",
  "## Limits",
  "",
  "These two Documents do not establish a unified evaluation across later domains.",
].join("\n");

async function ask(core: Core, text: string, mindId: string, conversationId: string | null = null) {
  const result = await core.askInConversation({ text, mindId, conversationId });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(core, result.answerId);
  if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, finished: ended.payload, conversationId: result.conversation.id };
}

const KEPT_FIELDS = [
  "passageId",
  "documentId",
  "contentHash",
  "pageFrom",
  "pageTo",
  "location",
  "quote",
] as const;
const kept = (citation: Partial<CitationAttributes>) =>
  Object.fromEntries(KEPT_FIELDS.map((field) => [field, citation[field]]));

/** Puts the Answer in a new Mind, as "Put this Answer in a new Mind" does. */
async function inNewMind(core: Core, answer: ConversationAnswer, question: string) {
  const mind = await core.createMind({ title: "Transformer report" });
  await core.addToNote({
    mindId: mind.id,
    blocks: pageBlocks(answer, question),
    origin: { from: messageReference(answer.conversationId, answer.id), question },
    model: answer.model,
  });
  return mind;
}

const ASKED =
  "Turn this Mind into a concise report with Title, Summary, Evidence and Limits. Preserve the source Citations on retained factual claims.";

describe("Turning a cited Mind into a report keeps its Citations", { timeout: 60_000 }, () => {
  // protects=a Citation the model reads in the Mind is kept by its id as the same Citation (Document, version, Location, quote), found, with no id in the Answer, and the new Mind and its Markdown and Word exports carry it as a real footnote; fails_when=the model sees a plain reference it can't cite, the Answer's Citation differs from the Mind's, or an id or a bracketed source reaches the Answer, the Mind or an export; no_claim=whether a real model keeps them (eval/reports).
  test("read the Mind, report in the Answer, save it to a new Mind, export it", async () => {
    const model = reportModel(() => REPORT);
    const { core, client, mind, documents } = await setUpWithDocuments(model, pdfs());
    const citations = await writeReview(core, client, documents);

    const { answer, finished } = await ask(core, ASKED, mind.id);

    const first = model.doStreamCalls[0]?.prompt.find((message) => message.role === "user");
    expect(JSON.stringify(first?.content)).toContain("[Attention, p. 1 · C1]");
    expect(answer.citations.map(kept)).toEqual(citations.map(kept));
    expect(answer.citations.map((each) => each.check)).toEqual(["found", "found", "found"]);
    expect(answer.text).not.toMatch(/C\d/);
    expect(finished.idsAsText).toBe(0);

    const report = await inNewMind(core, answer, ASKED);
    const markdown = new TextDecoder().decode(
      (await core.exportMind(report.id, { format: "markdown" })).data,
    );
    expect(markdown.match(/^\[\^\d+\]: /gm)).toHaveLength(3);
    expect(markdown).not.toMatch(/C\d|\[Attention|\[Overview/);
    const docx = await core.exportMind(report.id, { format: "docx" });
    const files = unzip(docx.data);
    expect(textOf(part(files, "word/footnotes.xml"))).toContain("Attention");
    expect(textOf(part(files, "word/document.xml"))).not.toMatch(/C\d|\[Attention/);
  });

  // protects=ids are given in the order the Mind reads, so a second Question reads the Mind as the first did (the prompt cache's start); the earlier Answer reads with the same ids for the same Citations, and the follow-up keeps them; fails_when=the Mind reads differently the second time, or the earlier Answer's Citations can't be kept; no_claim=none beyond protects.
  test("asked twice: the Mind reads the same, and the earlier Answer's Citations are kept too", async () => {
    const SHORTER = "Make it one sentence.";
    const model = reportModel((prompt) =>
      prompt.includes(SHORTER) ? "It drops recurrence [^1]." : REPORT,
    );
    const { core, client, mind, documents } = await setUpWithDocuments(model, pdfs());
    await writeReview(core, client, documents);

    const one = await ask(core, ASKED, mind.id);
    const before = model.doStreamCalls.length;
    const two = await ask(core, SHORTER, mind.id, one.conversationId);

    const sent = (call: number) => JSON.stringify(model.doStreamCalls[call]?.prompt);
    const mindIn = (call: number) => /<mind name=[\s\S]*?<\/mind>/.exec(sent(call))?.[0];
    expect(mindIn(before)).toBe(mindIn(0));
    expect(sent(before)).toContain("drops recurrence [Attention, p. 1 · C1]");
    expect(two.answer.citations.map(kept)).toEqual([kept(one.answer.citations[0] ?? {})]);
  });

  // protects=an id this Answer issued, written as text in square or full-width brackets, becomes that exact Citation; an issued one it can't keep is taken out with plain words in the Question's language, with no space before Chinese ones; an id it never issued stays as written; fails_when=an issued id stays in the text, a bracket it never issued is rewritten, or a source vanishes silently; no_claim=how often a real model does it (eval/reports counts it).
  test.each([
    [
      "en",
      ASKED,
      "It drops recurrence [Attention, p. 1 · C1]. Later work [Overview, p. 1 · C3]. Tides [Tides, p. 2 · C4]. A cell [C9].",
      "Tides (source couldn’t be kept). A cell [C9].",
    ],
    [
      "zh-CN",
      "把这个 Mind 整理成一份简短的报告，保留引用。",
      "它不用循环【Attention, p. 1 · C1】。后来的工作【Overview, p. 1 · C3】。潮汐【Tides, p. 2 · C4】。表格 [C9]。",
      "潮汐（未能保留来源）。表格 [C9]。",
    ],
  ] as const)(
    "ids written as text are cited or said to be lost (%s)",
    async (language, asked, reply, ending) => {
      const model = reportModel(() => reply, false);
      const { core, client, mind, documents } = await setUpWithDocuments(model, pdfs());
      const [first, , third] = await writeReview(core, client, documents);
      editMind(client, (blocks) => [...blocks, cited("Spring tides come at full moon", GONE)]);
      await client.settled();

      const { answer, finished } = await ask(core, asked, mind.id);

      expect(answer.citations.map(kept)).toEqual([kept(first ?? {}), kept(third ?? {})]);
      expect(answer.text.endsWith(ending)).toBe(true);
      expect(ending).toContain(translate(language, "answer.sourceNotKept"));
      expect(answer.text).not.toMatch(/C[1-4]|\[Attention|【/);
      expect(finished.idsAsText).toBe(3);
    },
  );

  // protects=in a Mind, the Citations above a Question take their ids oldest first, so an Answer added below leaves the older ones' ids as they were and the next Question reads the Mind as the last one did (the prompt cache's start); fails_when=a new Answer renumbers the Citations above it; no_claim=none beyond protects.
  test("in a Mind, a new Answer leaves the older Citations' ids as they were", async () => {
    const SHORTER = "The big model reaches 28.4 BLEU";
    const model = citingModel({
      query: "BLEU",
      records: (passages) => [
        {
          marker: 1,
          passage: passages.find((each) => each.text.includes(SHORTER))?.id,
          quote: SHORTER,
        },
      ],
      answer: "It reached 28.4 BLEU [^1].",
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, pdfs());
    await writeReview(core, client, documents);

    const one = await contextOfNextQuestion(core, client, mind.id, model, "What did it score?");
    const two = await contextOfNextQuestion(core, client, mind.id, model, "And what did it drop?");

    expect(one).toContain("The Transformer drops recurrence[Attention, p. 1 · C1]");
    expect(two).toContain("The Transformer drops recurrence[Attention, p. 1 · C1]");
    expect(two).toContain("It reached 28.4 BLEU [Attention, p. 2 · C4]");
  });

  // protects=a kept Citation keeps the version it quotes: with the Document changed since it opens that version and says the Document changed; with it deleted since it says it can't be checked, never found; fails_when=it is re-pointed at the new version or shown as working; no_claim=none beyond protects.
  test("a Document changed or deleted since: the kept Citation says so", async () => {
    const model = reportModel(
      () => "It drops recurrence [^1]. It reached 28.4 BLEU [^2]. Later work [^3].",
    );
    const { core, client, mind, documents } = await setUpWithDocuments(model, pdfs());
    const citations = await writeReview(core, client, documents);
    const attention = named(documents, "Attention");
    if (!attention.path) throw new Error("No file.");
    const changed = buildPdf([
      { lines: ["Abstract", "A new abstract."] },
      { lines: ["Results", BLEU] },
    ]);
    await writeFile(attention.path, changed);
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) =>
      expect(listed.find((each) => each.id === attention.id)?.contentHash).toBe(sha256(changed)),
    );
    await waitForProcessing(core, [attention.id]);
    await core.deleteDocument(named(documents, "Overview").id);

    const { answer } = await ask(core, ASKED, mind.id);

    const [first, , third] = answer.citations;
    expect(first?.contentHash).toBe(citations[0]?.contentHash);
    expect(first?.check).toBe("found");
    const live = (await core.listDocuments()).map((each) => ({ ...each }));
    expect(citationState(first ?? {}, live).changedAfterCited).toBe(true);
    expect(third).toMatchObject({ check: "cant-check", checkReason: "document-removed" });
  });

  // protects=a Citation whose Passage is gone can't be kept: cite says so and the model is told to say its source is no longer available, and nothing stands in for it; fails_when=it is kept as a working Citation, or the refusal is silent; no_claim=none beyond protects.
  test("a Citation whose Passage is gone is refused, and the model is told to say so", async () => {
    const model = reportModel(() => "Spring tides come at full moon (source no longer available).");
    const { core, client, mind } = await setUpWithDocuments(model, pdfs());
    writeMind(client, [cited("Spring tides come at full moon", GONE)]);
    await client.settled();

    const { answer } = await ask(core, ASKED, mind.id);

    expect(answer.citations).toEqual([]);
    const told = model.doStreamCalls
      .flatMap((call) => call.prompt)
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .map((each) => JSON.stringify(each))
      .join("\n");
    expect(told).toContain("C1 can't be kept");
  });

  // protects=a reply whose markers no record backs, while the context shows ids, is asked again in the Tool loop, and the model's records then keep the Mind's Citations; fails_when=the markers are dropped and the claims read uncited; no_claim=how often a real model needs it (eval/reports).
  test("markers written without cite are asked about once, and then kept by id", async () => {
    const UNBACKED = "no cite record backs";
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      if (!call.prompt.includes(UNBACKED)) return { text: REPORT };
      if (!call.results.some((result) => result.tool === "cite")) {
        const ids = [...new Set(idsShown(call.prompt))];
        const citations = ids.map((id, index) => ({ marker: index + 1, passage: id }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: REPORT };
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, pdfs());
    const citations = await writeReview(core, client, documents);

    const { answer, finished } = await ask(core, ASKED, mind.id);

    expect(answer.citations.map(kept)).toEqual(citations.map(kept));
    expect(finished.droppedMarkers).toBe(0);
  });

  // protects=a Mind with no Citations reads as it did, with no ids; fails_when=an id appears; no_claim=none beyond protects.
  test("a Mind with no Citations reads with no ids", async () => {
    const model = reportModel(() => "A report.");
    const { core, client, mind } = await setUpWithDocuments(model, pdfs());
    writeMind(client, [heading(1, "Notes"), note("Nothing cited here.")]);
    await client.settled();

    await ask(core, ASKED, mind.id);

    const asked = model.doStreamCalls[0]?.prompt.filter((message) => message.role === "user");
    expect(JSON.stringify(asked)).toContain("Nothing cited here.");
    expect(JSON.stringify(asked)).not.toMatch(/· C\d/);
  });
});
