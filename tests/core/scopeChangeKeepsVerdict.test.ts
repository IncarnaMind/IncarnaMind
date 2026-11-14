/**
 * A verdict a sentence's own Citation backs survives a change of its Note's Search scope (#3087):
 * it says what the cited Document says, so it goes stale no more than on a Folder move (#2313), and
 * a check that leaves that Document out keeps it. An earlier Unsupported, a verdict resting on
 * support found elsewhere, and one whose cited Document changed since still ask for a recheck.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import * as Y from "yjs";
import type { Core, Document } from "../../src/core";
import type { Language } from "../../src/core/language";
import { reasonText } from "../../src/renderer/src/cost";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { mindScopeOf, setMindScope } from "../../src/shared/mindScope";
import { folderScope, NO_SCOPE } from "../../src/shared/searchScope";
import {
  isCheckRun,
  listedSentences,
  type Plan,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
  unsupportedReply,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const PACK = "Harbour Foods board pack";
const SELLS = "Harbour Foods sells through its own shops and online.";
const EBITDA = "Underlying EBITDA at Harbour Foods was £12 million in 2025.";
const DEPOT = "The board approved the Leeds depot in March.";
const ONLY_ONLINE = "Harbour Foods sells only online.";
const PLANS_DEPOT = "Harbour Foods plans a new depot in Leeds.";
const SELLS_PART = "Harbour Foods sells through its own shops and online";
const DEPOT_PART = "it plans a new depot in Leeds";
const BOTH = `${SELLS_PART}, and ${DEPOT_PART}.`;
const ZH = "海港食品通过自有门店和网店销售。";
const DERBY = DEPOT_PART.replace("Leeds", "Derby");
const BOTH_EDITED = BOTH.replace("Leeds", "Derby");
const FARMS = SELLS.replace("shops", "farms");
/** The edits the User makes since a sentence's check, each beside a twin left as it was. */
const EDITS = [
  {
    kind: "a word of the same length",
    line: "line-0",
    original: SELLS,
    from: "shops",
    to: "farms",
    twin: EBITDA,
  },
  {
    kind: "a figure of the same length",
    line: "line-1",
    original: EBITDA,
    from: "£12",
    to: "£19",
    twin: SELLS,
  },
  {
    kind: "words of another length",
    line: "line-0",
    original: SELLS,
    from: "online",
    to: "on the web",
    twin: EBITDA,
  },
  {
    kind: "Chinese words of the same length",
    line: "line-2",
    original: ZH,
    from: "门店",
    to: "工厂",
    twin: SELLS,
  },
].map((each) => ({ ...each, edited: each.original.replace(each.from, each.to) }));

const PLANS: Record<string, Plan> = {
  [SELLS]: { verdict: "supported", quote: SELLS },
  [ONLY_ONLINE]: {
    verdict: "contradicted",
    quote: SELLS,
    says: "The board pack says it sells through its own shops and online.",
  },
  [EBITDA]: { verdict: "supported", quote: EBITDA },
  [PLANS_DEPOT]: { verdict: "unsupported" },
  [DEPOT]: { verdict: "supported", quote: DEPOT },
  [SELLS_PART]: { verdict: "supported", quote: SELLS },
  [DEPOT_PART]: { verdict: "unsupported" },
  [ZH]: { verdict: "supported", quote: ZH },
  [DERBY]: { verdict: "unsupported" },
  ...Object.fromEntries(
    [...EDITS.map((each) => each.edited), BOTH_EDITED].map((text): [string, Plan] => [
      text,
      { verdict: "unsupported" },
    ]),
  ),
};

/** The parts a model names: two in the joined sentence, the whole of any other. */
const PARTS: Record<string, string[]> = {
  [BOTH]: [SELLS_PART, DEPOT_PART],
  [BOTH_EDITED]: [SELLS_PART, DERBY],
};

/**
 * A check Run that searches with its sentence, cites the shown Passage holding its plan's quote and
 * gives the plan's verdict, each figure bound to the same words in that quote; with no such Passage
 * shown, Unsupported.
 */
function checking(call: ModelCall): ScriptedReply {
  const claim = sentenceOf(call);
  const plan = PLANS[claim];
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0)
    return { calls: [{ tool: "search_documents", input: { query: claim } }] };
  const shown = [
    ...searches.flatMap((each) => shownPassages(each.text)),
    ...shownPassages(call.prompt),
  ];
  const quote = plan?.quote;
  const holding = quote ? shown.find((each) => each.text.includes(quote)) : undefined;
  if (!plan || !quote || !holding || plan.verdict === "unsupported")
    return { text: unsupportedReply(call) };
  if (!call.results.some((result) => result.tool === "cite"))
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: holding.id, quote }] } }],
    };
  const lines = `Verdict: ${plan.verdict}\nAbsence: no\n${SAME_DETAIL}${plan.says ? `\n${plan.says} [^1]` : ""}`;
  const figures = requestedFigures(call);
  if (figures.length === 0) return { text: lines };
  const items = figures.map(({ id, shown: chars, reading }) => ({
    id,
    verdict: plan.verdict,
    scope: "same",
    topic: "found",
    roles: "same",
    says: null,
    reading,
    relation: "equals",
    source: { citation: 1, number: chars },
    measure: null,
    calculation: null,
  }));
  return { text: `${lines}\nFigures: ${JSON.stringify({ items, remainder: null })}` };
}

function generate(call: GenerateCall) {
  switch (call.question) {
    case "find-claims":
      return {
        text: JSON.stringify({
          sentences: listedSentences(call.prompt).map(({ number, text }) => ({
            number,
            parts: (PARTS[text] ?? (text in PLANS ? [text] : [])).map((part) => ({
              kind: "fact",
              text: part,
            })),
          })),
        }),
      };
    case "confirm":
    case "strict":
    case "strict-figure":
    case "nearest":
      return { text: "conflict" };
    default:
      return { text: JSON.stringify({ passage: null }) };
  }
}

async function setUp() {
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call) ? checking(call) : { text: "" };
    },
    { generate },
  );
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createSourceFolder();
  const [pack, memo] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      `${PACK}.md`,
      `# ${PACK}\n\n${SELLS}\n\n${EBITDA}\n\n${DEPOT}\n\n${ZH}\n`,
    ),
    await writeSourceFile(sources, "Other memo.md", "The memo was approved by the board.\n"),
  ]);
  if (!pack || !memo) throw new Error("The Documents weren't added.");
  const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
  const memos = await core.createLibraryGroup({ name: "Memos", description: "" });
  await core.assignDocumentGroup(pack.id, harbour.id);
  await core.assignDocumentGroup(memo.id, memos.id);
  return { core, pack, memo, memos, calls, sources };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function citation(core: Core, document: Document, line: string): Promise<JSONContent> {
  const selected = await core.citeSelection({
    documentId: document.id,
    parts: [{ unit: null, text: line }],
  });
  return {
    type: "citation",
    attrs: {
      passageId: selected.passageId,
      documentId: document.id,
      documentName: document.name,
      contentHash: selected.contentHash,
      quote: selected.quote,
      pageFrom: selected.pageFrom,
      pageTo: selected.pageTo,
      location: selected.location,
      check: selected.check,
    },
  };
}

/** A Note of the User's, one paragraph per line, each line followed by its Citations. */
async function noteWith(core: Core, lines: readonly (readonly [string, ...JSONContent[]])[]) {
  const mind = await core.createMind({ title: "Harbour notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    lines.map(([line, ...citations], index) => ({
      type: "paragraph",
      attrs: { id: `line-${index}` },
      content: [{ type: "text", text: line }, ...citations],
    })),
  );
  await client.settled();
  return { mindId: mind.id, client };
}

const checkNote = async (core: Core, mindId: string, client: MindClient) => {
  expect(await core.checkMind({ requestId: randomUUID(), mindId, mode: "all" })).toMatchObject({
    kind: "checked",
  });
  await client.settled();
};

/** Each sentence's card as the editor reads it: what it says first, its line, and its one action. */
async function cards(core: Core, client: MindClient, language: Language = "en") {
  const versions = new Map(
    (await core.listDocuments()).map((document) => [document.id, document.contentHash]),
  );
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const { claims } = claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions,
    folderId: null,
    scope: mindScopeOf(client.doc),
  });
  return new Map(
    claims.map(({ sentence, shown, check }) => [
      sentence.text,
      shown.state === "needs-recheck"
        ? { state: shown.state, line: t(`claim.recheck.${shown.why}`), action: "Check again" }
        : shown.state === "not-checked"
          ? {
              state: shown.state,
              line: reasonText(t, language, shown.reason, check.detail),
              action: shown.reason === "outside-scope" ? "Search all Documents" : "Check again",
            }
          : { state: shown.state, line: null, action: null },
    ]),
  );
}

const sentRuns = (calls: readonly ModelCall[], from: number) =>
  calls.slice(from).filter((call) => isCheckRun(call) && call.results.length === 0);
const askedAbout = (calls: readonly ModelCall[], from: number, sentence: string) =>
  sentRuns(calls, from).some((call) => sentenceOf(call).startsWith(sentence.slice(0, 20)));

/** The Note of every case, checked once with no Search scope, then scoped to the memos' Folder. */
async function checkedThenNarrowed(setup: Setup) {
  const { core, pack } = setup;
  const cites = (line: string) => citation(core, pack, line);
  const note = await noteWith(core, [
    [SELLS, await cites(SELLS)],
    [ONLY_ONLINE, await cites(SELLS)],
    [EBITDA, await cites(EBITDA)],
    [PLANS_DEPOT, await cites(SELLS)],
    [DEPOT],
    [BOTH, await cites(SELLS)],
  ]);
  await checkNote(core, note.mindId, note.client);
  const first = await cards(core, note.client);
  setMindScope(note.client.doc, folderScope(setup.memos.id));
  await note.client.settled();
  return { ...note, first };
}

const SETTLED = { line: null, action: null };
const OUTSIDE = {
  state: "not-checked",
  line: `“${PACK}” is outside this note’s Search scope.`,
  action: "Search all Documents",
};
const RECHECK = {
  state: "needs-recheck",
  line: "The note’s Search scope has changed since.",
  action: "Check again",
};

// protects=a Supported or Contradicted verdict the sentence's own Citation backs, a sentence with figures and one part of several among them, reads as it was when the Note's Search scope narrows to a Folder without the cited Document: no recheck line, no Check again; a check after it keeps it with no request, and a third check leaves every card as the second did, none asking for a recheck, and the scope set back or to every Document leaves it so (#3087); fails_when=the card asks for a recheck Check again can't settle, or a check takes the verdict back; no_claim=what a real model decides.
test("a verdict its own Citation backs survives the scope's change", async () => {
  const setup = await setUp();
  const { core, calls } = setup;
  const { mindId, client, first } = await checkedThenNarrowed(setup);

  expect(first.get(SELLS)).toEqual({ state: "supported", ...SETTLED });
  expect(first.get(ONLY_ONLINE)).toEqual({ state: "contradicted", ...SETTLED });
  expect(first.get(EBITDA)).toEqual({ state: "supported", ...SETTLED });
  const narrowed = await cards(core, client);
  for (const sentence of [SELLS, ONLY_ONLINE, EBITDA])
    expect(narrowed.get(sentence)).toEqual(first.get(sentence));

  let second: Map<string, unknown> | null = null;
  for (const time of [2, 3]) {
    const from = calls.length;
    await checkNote(core, mindId, client);
    const again = await cards(core, client);
    if (second) expect(again).toEqual(second);
    second ??= again;
    for (const card of again.values()) expect(card.state).not.toBe("needs-recheck");
    for (const sentence of [SELLS, ONLY_ONLINE, EBITDA]) {
      expect(again.get(sentence), `${sentence}, check ${time}`).toEqual(first.get(sentence));
      expect(askedAbout(calls, from, sentence), `${sentence}, check ${time}`).toBe(false);
    }
  }

  for (const scope of [null, NO_SCOPE]) {
    setMindScope(client.doc, scope);
    await client.settled();
    const now = await cards(core, client);
    for (const sentence of [SELLS, ONLY_ONLINE, EBITDA])
      expect(now.get(sentence)).toEqual(first.get(sentence));
  }
  core.close();
});

// protects=of a sentence with several parts, the part its own Citation backs keeps its ✓ when a check leaves that Document out, and the part found Unsupported before reads Not checked with the reason (#3087); fails_when=the backed part is taken back, or the Unsupported part is kept; no_claim=how a real model splits it.
test("one part of several keeps its ✓; the Unsupported part gives way", async () => {
  const setup = await setUp();
  const { core } = setup;
  const { mindId, client, first } = await checkedThenNarrowed(setup);
  expect(first.get(BOTH)?.state).toBe("unsupported");
  expect((await cards(core, client)).get(BOTH)).toEqual(RECHECK);

  await checkNote(core, mindId, client);

  const [both] = claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: mindScopeOf(client.doc),
  }).claims.filter((claim) => claim.sentence.text === BOTH);
  expect(both?.reads.parts?.map((part) => [part.verdict, part.reason])).toEqual([
    ["supported", null],
    ["not-checked", "outside-scope"],
  ]);
  expect((await cards(core, client)).get(BOTH)).toEqual(OUTSIDE);
  core.close();
});

// protects=an earlier Unsupported on a cited sentence asks for its recheck when the scope narrows, then reads Not checked with the reason and offers Search all Documents, which settles it; a sentence with no earlier verdict reads Not checked with the reason; a ✓ resting on support found elsewhere goes stale as before (#3087, #3083); fails_when=an Unsupported is kept, Search all Documents leaves it asking, or found support survives the change; no_claim=the Search all Documents verdict's wording.
test("an earlier Unsupported, a new sentence and support found elsewhere ask as before", async () => {
  const setup = await setUp();
  const { core, pack } = setup;
  const { mindId, client } = await checkedThenNarrowed(setup);
  const narrowed = await cards(core, client);
  expect(narrowed.get(PLANS_DEPOT)).toEqual(RECHECK);
  expect(narrowed.get(DEPOT)).toEqual(RECHECK);

  await checkNote(core, mindId, client);
  const after = await cards(core, client);
  expect(after.get(PLANS_DEPOT)).toEqual(OUTSIDE);

  const fresh = await noteWith(core, [[SELLS, await citation(core, pack, SELLS)]]);
  setMindScope(fresh.client.doc, folderScope(setup.memos.id));
  await fresh.client.settled();
  await checkNote(core, fresh.mindId, fresh.client);
  expect((await cards(core, fresh.client)).get(SELLS)).toEqual(OUTSIDE);

  const line = PLANS_DEPOT.length + 1;
  await core.checkSentences({
    requestId: randomUUID(),
    mindId,
    action: "check-against-documents",
    from: { blockId: "line-3", offset: 0 },
    to: { blockId: "line-3", offset: line },
    allDocuments: true,
  });
  await client.settled();
  const searched = (await cards(core, client)).get(PLANS_DEPOT);
  expect(searched).toEqual({ state: "unsupported", ...SETTLED });
  await checkNote(core, mindId, client);
  expect((await cards(core, client)).get(PLANS_DEPOT)).toEqual(searched);
  core.close();
});

// protects=a ✓ its own Citation backs still asks for a recheck once its cited Document changes, and checked again outside the scope it reads Not checked with the reason, never the old verdict (#3087); fails_when=the old verdict is kept over a new version; no_claim=the new version's own reading.
test("a cited Document changed since: it asks, and isn't kept", async () => {
  const setup = await setUp();
  const { core, pack, sources } = setup;
  const { mindId, client } = await checkedThenNarrowed(setup);
  await writeSourceFile(
    sources,
    `${PACK}.md`,
    `# ${PACK}\n\n${SELLS}\n\n${EBITDA}\n\n${DEPOT}\n\nThe pack was revised in April.\n`,
  );
  await core.reconcileDocuments();
  await expect
    .poll(async () => {
      const now = (await core.listDocuments()).find((document) => document.id === pack.id);
      return now?.contentHash !== pack.contentHash && now?.status === "ready";
    })
    .toBe(true);
  expect((await cards(core, client)).get(SELLS)).toEqual({
    state: "needs-recheck",
    line: "A Document it was checked against has a new version.",
    action: "Check again",
  });

  await checkNote(core, mindId, client);

  expect((await cards(core, client)).get(SELLS)).toEqual(OUTSIDE);
  core.close();
});

/** Replaces `from` with `to` in a line's text, as typing over a selection does, keeping its marks. */
function replaceWords(client: MindClient, blockId: string, from: string, to: string) {
  const block = client.blocks
    .toArray()
    .find((each) => each instanceof Y.XmlElement && each.getAttribute("id") === blockId);
  const text = block instanceof Y.XmlElement ? block.get(0) : undefined;
  if (!(text instanceof Y.XmlText)) throw new Error(`${blockId} has no text.`);
  const runs = text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
  const at = runs
    .map((run) => (typeof run.insert === "string" ? run.insert : ""))
    .join("")
    .indexOf(from);
  if (at < 0) throw new Error(`${blockId} doesn't say "${from}".`);
  const [run] = runs;
  client.doc.transact(() => {
    text.delete(at, from.length);
    text.insert(at, to, run?.attributes ?? {});
  }, "editor");
}

/** A Note of the sentences the User edits, each checked once with no scope, then scoped to the memos. */
async function editableNote(setup: Setup) {
  const { core, pack } = setup;
  const cites = (line: string) => citation(core, pack, line);
  const note = await noteWith(core, [
    [SELLS, await cites(SELLS)],
    [EBITDA, await cites(EBITDA)],
    [ZH, await cites(ZH)],
    [BOTH, await cites(SELLS)],
  ]);
  await checkNote(core, note.mindId, note.client);
  const first = await cards(core, note.client);
  setMindScope(note.client.doc, folderScope(setup.memos.id));
  await note.client.settled();
  return { ...note, first };
}

// protects=a sentence the User changed since its ✓, a figure and Chinese among them and whatever the length, is judged as new words when the Note's Search scope leaves its cited Document out: Check this Note leaves it Not checked with the reason, as a sentence never checked, and no card shows a ✓ for it, while its unchanged twin keeps its ✓; neither is sent to the model (#3087); fails_when=the earlier ✓ is kept for words no check read, or the twin loses its ✓; no_claim=the card between the edit and the check.
test.each(EDITS)(
  "$kind changed since its ✓ isn't given it back; the unchanged twin keeps its own",
  async ({ line, original, from, to, edited, twin }) => {
    const setup = await setUp();
    const { core, calls } = setup;
    const { mindId, client, first } = await editableNote(setup);
    expect(first.get(twin)).toEqual({ state: "supported", ...SETTLED });
    expect(first.get(original)).toEqual({ state: "supported", ...SETTLED });

    replaceWords(client, line, from, to);
    await client.settled();
    const before = calls.length;
    await checkNote(core, mindId, client);
    const after = await cards(core, client);

    expect(after.get(edited)).toEqual(OUTSIDE);
    expect(after.get(twin)).toEqual(first.get(twin));
    expect(askedAbout(calls, before, edited)).toBe(false);
    expect(askedAbout(calls, before, twin)).toBe(false);
    core.close();
  },
);

// protects=an edit inside one part of a two-part sentence gives back neither part's earlier result when the scope leaves the cited Document out: an earlier part is kept only from a check of the sentence's words as they are now (#3087); fails_when=a part keeps a verdict from before the edit; no_claim=keeping a part whose own words are unchanged.
test("an edit inside one part: neither part keeps its earlier result", async () => {
  const setup = await setUp();
  const { core } = setup;
  const { mindId, client } = await editableNote(setup);

  replaceWords(client, "line-3", "Leeds", "Derby");
  await client.settled();
  await checkNote(core, mindId, client);

  const [both] = claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: mindScopeOf(client.doc),
  }).claims.filter((claim) => claim.sentence.text === BOTH_EDITED);
  expect(both?.reads.parts?.map((part) => [part.verdict, part.reason])).toEqual([
    ["not-checked", "outside-scope"],
    ["not-checked", "outside-scope"],
  ]);
  expect((await cards(core, client)).get(BOTH_EDITED)).toEqual(OUTSIDE);
  core.close();
});

// protects=Undo of an edit made since a ✓ brings the words back but not the ✓, since the sentence's mark is now the check of the edited words: the card asks for its recheck, and Check this Note settles it Not checked with the reason without a request (#3087); fails_when=the ✓ returns on a mark that judged other words, or the card asks for a recheck Check again can't settle; no_claim=the editor's own Undo step.
test("Undo of the edit brings the words back, and the ✓ only with its mark", async () => {
  const setup = await setUp();
  const { core, calls } = setup;
  const { mindId, client } = await editableNote(setup);
  const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
  replaceWords(client, "line-0", "shops", "farms");
  await client.settled();
  await checkNote(core, mindId, client);
  expect((await cards(core, client)).get(FARMS)).toEqual(OUTSIDE);

  undo.undo();
  await client.settled();
  expect((await cards(core, client)).get(SELLS)).toEqual({
    state: "needs-recheck",
    line: "The sentence has changed since it was checked.",
    action: "Check again",
  });
  const from = calls.length;
  await checkNote(core, mindId, client);

  expect((await cards(core, client)).get(SELLS)).toEqual(OUTSIDE);
  expect(askedAbout(calls, from, SELLS)).toBe(false);
  undo.destroy();
  core.close();
});
