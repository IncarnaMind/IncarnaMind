/**
 * A sentence checked in parts stays behind a Folder's wall as a whole sentence does (#2002, #1934):
 * no part searches, quotes or cites a Document on the other side, and a part checked again from
 * outside the wall its Passage is behind keeps the result it had.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core";
import type { ClaimCheckAttributes } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { isCheckRun, listedSentences, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const LANGUAGES = [
  {
    language: "en",
    lease: "The lease ends in spring. The landlord pays for repairs.\n",
    memo: "The memo was approved by the board.\n",
    ends: "The lease ends in spring",
    repairs: "the landlord pays for repairs",
    approved: "the memo was approved by the board",
    joined: (first: string, second: string) =>
      `${first[0]?.toUpperCase()}${first.slice(1)}, and ${second}.`,
  },
  {
    language: "zh-CN",
    lease: "租约在春季结束。房东负责维修。\n",
    memo: "备忘录已获董事会批准。\n",
    ends: "租约在春季结束",
    repairs: "房东负责维修",
    approved: "备忘录已获董事会批准",
    joined: (first: string, second: string) => `${first}，${second}。`,
  },
] as const;

type Example = (typeof LANGUAGES)[number];

/** Every fact part of the sentence, in its order, as a model names them. */
const factsIn = (example: Example, sentence: string) =>
  [example.ends, example.repairs, example.approved]
    .flatMap((words) => {
      const at = sentence.toLowerCase().indexOf(words.toLowerCase());
      return at < 0 ? [] : [{ at, text: sentence.slice(at, at + words.length) }];
    })
    .sort((a, b) => a.at - b.at)
    .map(({ text }) => ({ kind: "fact", text }));

/**
 * A check Run that names its sentence's facts in its first turn and searches; then cites the shown
 * Passage holding the part's words and says Supported, or says Unsupported when none is shown.
 */
function checking(example: Example, call: ModelCall): ScriptedReply {
  const claim = sentenceOf(call);
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    const search = { tool: "search_documents", input: { query: claim } };
    if (call.system.includes("Parts:"))
      return { text: `Parts: ${JSON.stringify(factsIn(example, claim))}`, calls: [search] };
    return { calls: [search] };
  }
  const shown = [...shownPassages(searches.at(-1)?.text ?? ""), ...shownPassages(call.prompt)];
  const holding = shown.find((each) => each.text.toLowerCase().includes(claim.toLowerCase()));
  if (!holding) return { text: "Verdict: unsupported" };
  if (!call.results.some((result) => result.tool === "cite")) {
    const quote = holding.text.slice(
      holding.text.toLowerCase().indexOf(claim.toLowerCase()),
      holding.text.toLowerCase().indexOf(claim.toLowerCase()) + claim.length,
    );
    const citations = [{ marker: 1, passage: holding.id, quote }];
    return { calls: [{ tool: "cite", input: { citations } }] };
  }
  return { text: "Verdict: supported\nThe Document says so. [^1]" };
}

async function setUp(example: Example) {
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (!isCheckRun(call)) throw new Error("Only checks run here.");
      return checking(example, call);
    },
    {
      generate(call) {
        if (!call.system.startsWith("You sort the sentences"))
          return { text: JSON.stringify({ passage: null }) };
        const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
          number,
          parts: factsIn(example, text),
        }));
        return { text: JSON.stringify({ sentences }) };
      },
    },
  );
  const setup = await setUpWithDocuments(model, [
    { name: "Client A lease.txt", contents: example.lease },
    { name: "Other memo.txt", contents: example.memo },
  ]);
  const { core } = setup;
  const named = (part: string) =>
    setup.documents.find((each) => each.name.includes(part)) as Document;
  const lease = named("Client A");
  const memo = named("Other memo");
  const clientA = await core.createLibraryGroup({ name: "Client A", description: "" });
  const general = await core.createLibraryGroup({ name: "General", description: "" });
  await core.assignDocumentGroup(lease.id, clientA.id);
  await core.assignDocumentGroup(memo.id, general.id);
  const wall = () =>
    core.updateLibraryGroup(clientA.id, { name: "Client A", description: "", keepInside: true });
  return { ...setup, calls, lease, memo, clientA, wall };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Writes, in the Note outside every wall, a sentence of two facts citing the lease's Passage. */
async function writeCited(setup: Setup, example: Example) {
  const sentence = example.joined(example.ends, example.repairs);
  const selected = await setup.core.citeSelection({
    documentId: setup.lease.id,
    parts: [{ unit: 1, text: example.lease.trim() }],
  });
  writeMind(setup.client, [
    {
      type: "paragraph",
      attrs: { id: "one" },
      content: [
        { type: "text", text: sentence },
        {
          type: "citation",
          attrs: {
            passageId: selected.passageId,
            documentId: setup.lease.id,
            documentName: setup.lease.name,
            contentHash: selected.contentHash,
            quote: example.lease.trim(),
            pageFrom: selected.pageFrom,
            pageTo: selected.pageTo,
            location: selected.location,
            check: "found",
          },
        },
      ],
    },
  ]);
  await setup.client.settled();
  return sentence;
}

async function checkSentence(setup: Setup, mindId: string, client: MindClient, length: number) {
  await setup.core.checkSentences({
    requestId: `check-${randomUUID()}`,
    mindId,
    action: "check-against-documents",
    from: { blockId: "one", offset: 0 },
    to: { blockId: "one", offset: length },
    allDocuments: true,
  });
  await client.settled();
}

/** The one sentence's mark: its result, and each part's words, result and cited Documents. */
function markOf(client: MindClient) {
  const [span] = claimSpans(readMind(client));
  const check: ClaimCheckAttributes | undefined = span?.check;
  if (!check) throw new Error("The sentence has no mark.");
  return {
    state: check.state,
    reason: check.reason,
    checkedAt: check.checkedAt,
    parts: check.parts?.map((part) => ({
      text: check.text.slice(part.span.start, part.span.end),
      verdict: part.verdict,
      reason: part.reason,
      cites: [...new Set(part.evidence.map((citation) => citation.documentName))],
    })),
  };
}

/** How many check Runs began, the Documents whose Passages they were shown, and every word sent. */
function sentTo(calls: readonly ModelCall[]) {
  const runs = calls.filter(isCheckRun);
  return {
    runs: runs.filter((call) => call.results.length === 0).length,
    shown: [
      ...new Set(
        runs.flatMap((call) =>
          [call.prompt, ...call.results.map((result) => result.text)].flatMap((text) =>
            shownPassages(text).map((passage) => passage.document),
          ),
        ),
      ),
    ],
    text: runs
      .map((call) => [call.system, call.prompt, ...call.results.map((each) => each.text)])
      .join("\n"),
  };
}

describe.each(LANGUAGES)("a sentence in parts behind a Folder's wall ($language)", (example) => {
  // protects=a walled Note's sentence checked in parts searches, quotes and cites only Documents inside its wall, through Check sentence and Check this Note, even with All Documents (#2002, #1934); fails_when=a part's search or its Citation reaches a Document outside the wall; no_claim=how a real model splits the sentence.
  test("a walled Note's sentence split into parts never reads outside the wall", async () => {
    const setup = await setUp(example);
    await setup.wall();
    const note = await setup.core.createMind({ title: "Lease note", folderId: setup.clientA.id });
    const client = await connectToMind(setup.core, note.id);
    const sentence = example.joined(example.ends, example.approved);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
    ]);
    await client.settled();

    await checkSentence(setup, note.id, client, sentence.length);
    const checked = markOf(client);
    const sent = sentTo(setup.calls);

    expect(checked.state).toBe("unsupported");
    expect(checked.parts).toEqual([
      { text: example.ends, verdict: "supported", reason: null, cites: [setup.lease.name] },
      { text: example.approved, verdict: "unsupported", reason: null, cites: [] },
    ]);
    expect(sent.runs).toBeGreaterThan(2);
    expect(sent.shown).toEqual([setup.lease.name]);
    expect(sent.text).not.toContain(setup.memo.name);

    const from = setup.calls.length;
    expect(
      await setup.core.checkMind({
        requestId: `note-${randomUUID()}`,
        mindId: note.id,
        mode: "all",
        allDocuments: true,
      }),
    ).toMatchObject({ kind: "checked" });
    await client.settled();
    const again = sentTo(setup.calls.slice(from));

    expect(markOf(client).parts).toEqual(checked.parts);
    expect(again.runs).toBe(2);
    expect(again.shown).toEqual([setup.lease.name]);
    expect(again.text).not.toContain(setup.memo.name);
  });

  // protects=a sentence outside a wall whose Citations are all behind it keeps every part's result when checked again: nothing is read and no model is asked, as for a whole sentence (#1934); fails_when=a part turns Not checked or is checked again from outside the wall; no_claim=the wall's own Citation re-check.
  test("each part of a sentence citing a walled Passage keeps its result, read from outside", async () => {
    const setup = await setUp(example);
    const sentence = await writeCited(setup, example);
    await checkSentence(setup, setup.mind.id, setup.client, sentence.length + 1);
    const before = markOf(setup.client);
    expect(before.state).toBe("supported");
    expect(before.parts?.map((part) => part.verdict)).toEqual(["supported", "supported"]);

    await setup.wall();
    const from = setup.calls.length;
    await checkSentence(setup, setup.mind.id, setup.client, sentence.length + 1);

    expect(markOf(setup.client)).toEqual(before);
    expect(sentTo(setup.calls.slice(from)).runs).toBe(0);
  });

  // protects=Check this Note from outside a wall, on a sentence whose Citations are all behind it, reads nothing and says Kept inside on each part, and the mark still reads back with its parts (#1934, #2002); fails_when=a part is checked from outside the wall, or a part's Kept inside makes its mark unreadable; no_claim=what the card shows.
  test("Check this Note from outside says Kept inside on each part of a cited sentence", async () => {
    const setup = await setUp(example);
    await writeCited(setup, example);
    await setup.wall();

    expect(
      await setup.core.checkMind({
        requestId: `note-${randomUUID()}`,
        mindId: setup.mind.id,
        mode: "all",
        allDocuments: true,
      }),
    ).toMatchObject({ kind: "checked" });
    await setup.client.settled();

    expect(markOf(setup.client)).toMatchObject({
      state: "not-checked",
      reason: "kept-inside",
      parts: [
        { text: example.ends, verdict: "not-checked", reason: "kept-inside", cites: [] },
        { text: example.repairs, verdict: "not-checked", reason: "kept-inside", cites: [] },
      ],
    });
    expect(sentTo(setup.calls).runs).toBe(0);
  });

  // protects=a part whose deciding Passage went behind a wall keeps its result when the sentence is checked again from outside, while its other part is checked as usual (#1934); fails_when=the part turns Unsupported because the check can no longer see its Passage, or the walled Document is read; no_claim=what a check inside the wall would find.
  test("a part whose Passage went behind a wall keeps its result beside a part checked again", async () => {
    const setup = await setUp(example);
    const sentence = example.joined(example.approved, example.ends);
    writeMind(setup.client, [
      { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
    ]);
    await setup.client.settled();
    await checkSentence(setup, setup.mind.id, setup.client, sentence.length);
    const before = markOf(setup.client);
    expect(before.state).toBe("supported");
    expect(before.parts?.map((part) => part.cites)).toEqual([
      [setup.memo.name],
      [setup.lease.name],
    ]);

    await setup.wall();
    const from = setup.calls.length;
    await checkSentence(setup, setup.mind.id, setup.client, sentence.length);
    const after = markOf(setup.client);
    const sent = sentTo(setup.calls.slice(from));

    expect(after.state).toBe("supported");
    expect(after.parts).toEqual(before.parts);
    expect(sent.runs).toBe(2);
    expect(sent.shown).toEqual([setup.memo.name]);
    expect(sent.text).not.toContain(setup.lease.name);
  });
});
