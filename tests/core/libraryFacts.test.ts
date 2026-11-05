/**
 * A sentence about the Library itself (#2525) is checked against the Library's own facts as the
 * check's scope saw them, Folder walls applied: how many Documents it holds, their names and kinds,
 * which share a name, its Folders, Tags and notes. The model asks for them with its search and
 * names, on its reply's Library line, the facts its sentence states; the rules that hold its result
 * are the core's, whatever the model says. A sentence about the note itself is set aside by the
 * sort, as an opinion is.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Core, Document } from "../../src/core";
import { readClaimParts } from "../../src/core/answers/checks/claims";
import {
  declaredLibrary,
  type LibraryListing,
  libraryNow,
  libraryText,
} from "../../src/core/answers/checks/libraryFacts";
import type { Language } from "../../src/core/language";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { leftOutWords } from "../../src/renderer/src/editor/leftOutWords";
import { opinionsIn } from "../../src/renderer/src/editor/opinionLocations";
import { noteStateOf, noteStateParts } from "../../src/renderer/src/noteState";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import { libraryRow } from "../../src/shared/libraryFacts";
import { citationLocation } from "../../src/shared/locations";
import {
  checkGenerate,
  isCheckRun,
  listedSentences,
  requestedFigures,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/** How the scripted model checks a sentence about the Library. */
interface Plan {
  verdict: "supported" | "unsupported" | "contradicted";
  /** Its search asks for the Library's facts: true unless false. */
  library?: boolean;
  /** The words it cites, from whichever Passage shown holds them. */
  quote?: string;
  /** What its Library line names; no line when null; "none" when absent. */
  line?: string | null;
  says?: string;
  /** For contradicted: the sentence's words to change, and to what. */
  change?: [string, string];
  /** What it gives once the check asks about its reply, in place of the above. */
  asked?: Partial<Pick<Plan, "verdict" | "quote" | "line">>;
}

const LIBRARY_ASK = "Your reply has no Library line";
const UNSTATED_ASK = "but no line of the Library facts you recorded with cite states";
const NOT_ABOUT_ASK = "Your Library line says none, but you recorded a line of the Library facts";
const ASKS = [LIBRARY_ASK, UNSTATED_ASK, NOT_ABOUT_ASK];

/** How the sort splits a sentence: its parts in order; a sentence not listed is one fact. */
type Inventory = Record<
  string,
  readonly { kind: "fact" | "opinion" | "about-this-text"; text: string }[]
>;

/** A model that checks each sentence as `plans` say: search, cite, then its verdict. */
function libraryModel(plans: Record<string, Plan>, calls: ModelCall[], inventory: Inventory = {}) {
  const generate = (call: GenerateCall) => {
    if (!call.system.startsWith("You sort the sentences")) return checkGenerate({})(call);
    const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
      number,
      parts: inventory[text] ?? [{ kind: "fact", text }],
    }));
    return { text: JSON.stringify({ sentences }) };
  };
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (!isCheckRun(call)) return { text: "" };
      const sentence = sentenceOf(call);
      const planned = plans[sentence] ?? { verdict: "unsupported" };
      const asked = ASKS.some((ask) => call.prompt.includes(ask));
      const plan = asked && planned.asked ? { ...planned, ...planned.asked } : planned;
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        const search = {
          tool: "search_documents",
          input: { query: sentence, ...(plan.library !== false && { library: true }) },
        };
        if (!call.system.includes("Parts:")) return { calls: [search] };
        const parts = [{ kind: "fact", text: sentence }];
        return { text: `Parts: ${JSON.stringify(parts)}`, calls: [search] };
      }
      const shown = searches.flatMap((search) => shownPassages(search.text));
      const { quote } = plan;
      const cites = call.results.filter((result) => result.tool === "cite").length;
      const citeAgain = asked && planned.asked?.quote !== undefined && cites < 2;
      if (quote && (cites === 0 || citeAgain)) {
        const passage = (shown.find((each) => each.text.includes(quote)) ?? shown[0])?.id;
        return {
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote }] } }],
        };
      }
      const line = plan.line === undefined ? "none" : plan.line;
      const lines = [
        `Verdict: ${plan.verdict}`,
        ...(line === null ? [] : [`Library: ${line}`]),
        "Absence: no",
        "Topic: found",
        ...(plan.says ? [`${plan.says}${quote ? " [^1]" : ""}`] : []),
        ...(plan.change ? [`Change 1: ${plan.change[0]}`, `To 1: ${plan.change[1]} [^1]`] : []),
      ];
      const figures = requestedFigures(call);
      if (figures.length > 0) {
        const number = quote?.match(/\d+/)?.[0];
        const items = figures.map(({ id, reading }) => ({
          id,
          verdict: number ? plan.verdict : "unsupported",
          scope: "same",
          topic: number ? "found" : "not found",
          roles: "same",
          says: null,
          reading,
          relation: "equals",
          source: number ? { citation: 1, number } : null,
          calculation: null,
        }));
        lines.push(`Figures: ${JSON.stringify({ items, remainder: null })}`);
      }
      return { text: lines.join("\n") };
    },
    { generate },
  );
}

interface SourceFile {
  name: string;
  contents: string;
}

const files = (count: number, prefix = "Survey note"): SourceFile[] =>
  Array.from({ length: count }, (_, at) => ({
    name: `${prefix} ${String(at + 1).padStart(2, "0")}.txt`,
    contents: `Field visit ${at + 1}: the site was dry and the gauge read normal.`,
  }));

async function setUp(
  given: readonly SourceFile[],
  plans: Record<string, Plan>,
  language: Language = "en",
  inventory: Inventory = {},
) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(libraryModel(plans, calls, inventory)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.updateSettings({ user: { language } });
  const sources = await createTempDataFolder();
  const paths = await Promise.all(
    given.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  const documents = await addAndProcess(core, paths);
  const sent = () =>
    calls
      .flatMap((call) => [call.system, call.prompt, ...call.results.map((each) => each.text)])
      .join("\n");
  return { core, documents, calls, sent, sources };
}

const paragraph = (id: string, text: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text }],
});

/** Writes `sentence` in a new Note in `folderId` and checks it there, as Check against Documents does. */
async function checkInNote(
  core: Core,
  sentence: string,
  folderId: string | null = null,
  allDocuments = folderId === null,
) {
  const note = await core.createMind({ title: "Library overview", folderId });
  const mind = await connectToMind(core, note.id);
  writeMind(mind, [paragraph("one", sentence)]);
  await mind.settled();
  await core.checkSentences({
    requestId: `check-${randomUUID()}`,
    mindId: note.id,
    action: "check-against-documents",
    from: { blockId: "one", offset: 0 },
    to: { blockId: "one", offset: sentence.length },
    allDocuments,
  });
  await mind.settled();
  const check = claimSpans(readMind(mind))[0]?.check;
  if (!check) throw new Error("The sentence was not checked.");
  return { check, noteId: note.id, mind };
}

/** Writes `sentences`, a paragraph each, in a new Note and checks it all, as Check this note does. */
async function checkWholeNote(core: Core, sentences: readonly string[]): Promise<MindClient> {
  const note = await core.createMind({ title: "Library overview", folderId: null });
  const mind = await connectToMind(core, note.id);
  writeMind(
    mind,
    sentences.map((sentence, at) => paragraph(`p${at}`, sentence)),
  );
  await mind.settled();
  await core.checkMind({ requestId: `check-${randomUUID()}`, mindId: note.id, mode: "all" });
  await mind.settled();
  return mind;
}

/** The check badge's state of a Note, as the badge works it out from the Note's marks. */
function badgeOf(mind: MindClient) {
  const doc = readMind(mind);
  const claims = claimsOf(doc, { versions: null, folderId: null, scope: null });
  return noteStateOf(
    noteHealth(doc, {
      claims: claims.claims,
      citationCheck: (attributes) => attributes.check,
      skipped: new Set(),
      unexamined: new Set(),
      kept: claims.kept,
    }),
  );
}

const t = (language: Language) => (key: Parameters<typeof translate>[1], params?: object) =>
  translate(language, key, params as Parameters<typeof translate>[2]);

/** The row the card shows for the Library fact that decided a check. */
function rowOf(check: ClaimCheckAttributes, language: Language): string | null {
  const evidence = check.evidence ?? check.parts?.flatMap((part) => part.evidence)[0] ?? null;
  const location = evidence ? citationLocation(evidence) : null;
  return location?.kind === "library" ? libraryRow(location, t(language), language) : null;
}

const SENTENCES = {
  count: {
    en: "Your Library lists 22 uploaded Documents.",
    "zh-CN": "你的资料库里有 22 个上传的文档。",
  },
  twice: {
    en: "Kestrel plan appears twice in your file list.",
    "zh-CN": "Kestrel plan 在你的文件列表中出现了两次。",
  },
  notes: {
    en: "You also have saved notes besides this overview.",
    "zh-CN": "除了这份概览，你还保存了其他笔记。",
  },
  described: {
    en: "The files are mostly fieldwork material.",
    "zh-CN": "这些文件大多是野外调查资料。",
  },
} as const;

describe.each(["en", "zh-CN"] as const)("a sentence about the Library (%s)", (language) => {
  const ROW = {
    en: { 22: "Your Library: 22 Documents", 23: "Your Library: 23 Documents" },
    "zh-CN": { 22: "你的资料库：22 个文档", 23: "你的资料库：23 个文档" },
  }[language];

  // protects=a count of the Library's Documents is Supported by the Library's own count, with the ruled row; fails_when=a check reads only the Passages and calls the true sentence Not found.
  test("22 Documents reads Supported against 22, and Contradicted against 23", async () => {
    const sentence = SENTENCES.count[language];
    const right = await setUp(
      files(22),
      { [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" } },
      language,
    );
    const supported = await checkInNote(right.core, sentence);
    expect(supported.check.state).toBe("supported");
    expect(rowOf(supported.check, language)).toBe(ROW[22]);
    expect(right.sent()).toContain("Library facts of your Library");

    const wrong = await setUp(
      files(23),
      { [sentence]: { verdict: "contradicted", quote: "Documents in all: 23", line: "documents" } },
      language,
    );
    const contradicted = await checkInNote(wrong.core, sentence);
    expect(contradicted.check.state).toBe("contradicted");
    expect(rowOf(contradicted.check, language)).toBe(ROW[23]);
    // A fact's words are never a correction of the sentence's.
    expect(contradicted.check.correction).toBeUndefined();
  });

  // protects=a shared name is a Library fact: two Documents of one name back "appears twice", one contradicts it; fails_when=names are not among the facts.
  test("appears twice reads Supported with two of that name, and Contradicted with one", async () => {
    const sentence = SENTENCES.twice[language];
    const two = await setUp(
      [
        { name: "Kestrel plan.txt", contents: "Plan for the Kestrel site." },
        { name: "Kestrel plan.md", contents: "# Kestrel plan\n\nThe second draft." },
        { name: "Harbour survey.txt", contents: "Harbour survey notes." },
      ],
      {
        [sentence]: {
          verdict: "supported",
          quote: "Documents named “Kestrel plan”: 2",
          line: "name",
        },
      },
      language,
    );
    const supported = await checkInNote(two.core, sentence);
    expect(supported.check.state).toBe("supported");
    expect(rowOf(supported.check, language)).toBe(
      language === "en"
        ? "Your Library: 2 Documents named “Kestrel plan”"
        : "你的资料库：2 个文档名为“Kestrel plan”",
    );

    const one = await setUp(
      [
        { name: "Kestrel plan.txt", contents: "Plan for the Kestrel site." },
        { name: "Harbour survey.txt", contents: "Harbour survey notes." },
      ],
      {
        [sentence]: {
          verdict: "contradicted",
          quote: "Documents named “Kestrel plan”: 1",
          line: "name",
        },
      },
      language,
    );
    const contradicted = await checkInNote(one.core, sentence);
    expect(contradicted.check.state).toBe("contradicted");
    expect(rowOf(contradicted.check, language)).toBe(
      language === "en"
        ? "Your Library: 1 Document named “Kestrel plan”"
        : "你的资料库：1 个文档名为“Kestrel plan”",
    );
  });

  // protects=the saved notes are Library facts, the note being checked left out; fails_when=notes are not among the facts, or the note itself is counted.
  test("the saved-notes sentence reads Supported by the other notes", async () => {
    const sentence = SENTENCES.notes[language];
    const setup = await setUp(
      files(2),
      { [sentence]: { verdict: "supported", quote: "Notes besides this one: 2", line: "notes" } },
      language,
    );
    await setup.core.createMind({ title: "Harbour visit", folderId: null });
    await setup.core.createMind({ title: "Kestrel budget", folderId: null });
    const { check } = await checkInNote(setup.core, sentence);
    expect(check.state).toBe("supported");
    expect(rowOf(check, language)).toBe(
      language === "en" ? "Your Library: 2 other notes" : "你的资料库：另有 2 篇笔记",
    );
    expect(setup.sent()).toContain("Note “Harbour visit”");
    expect(setup.sent()).not.toContain("Note “Library overview”");
  });

  // protects=a description the facts can't settle is Not checked with the ruled reason, never Not found with Cut; fails_when=it reads Unsupported.
  test("a description the facts can't settle reads Not checked, with why", async () => {
    const sentence = SENTENCES.described[language];
    const setup = await setUp(
      files(3),
      { [sentence]: { verdict: "unsupported", line: "description" } },
      language,
    );
    const { check } = await checkInNote(setup.core, sentence);
    expect(check.state).toBe("not-checked");
    expect(check.reason).toBe("library-unsettled");
    expect(t(language)("claim.reason.library-unsettled")).toBe(
      language === "en"
        ? "Only your Library’s counts, names and kinds can be checked."
        : "只能核对资料库的数量、名称和类型。",
    );
  });
});

describe("the rules that hold a Library sentence's result", () => {
  const sentence = SENTENCES.count.en;
  /** How many times the check sent `ask`: each request after it carries every ask so far. */
  const asks = (calls: readonly ModelCall[], ask: string) =>
    Math.max(0, ...calls.filter(isCheckRun).map((call) => call.prompt.split(ask).length - 1));
  const memo = [
    ...files(21),
    { name: "Archive memo.txt", contents: "The archive holds 22 files in total." },
  ];

  // protects=a Document's own words that count files never decide a sentence about the Library: asked once, a reply still resting on them is Not checked, never a code-made verdict; fails_when=the archive memo's "22 files" Supports it, or the reply is turned into Unsupported with Cut.
  test("a Document's text that counts files never decides it: asked once, then Not checked", async () => {
    const still = await setUp(memo, {
      [sentence]: { verdict: "supported", quote: "The archive holds 22 files", line: "documents" },
    });
    const kept = (await checkInNote(still.core, sentence)).check;
    expect(asks(still.calls, UNSTATED_ASK)).toBe(1);
    expect(kept.state).toBe("not-checked");
    expect(kept.reason).toBe("malformed");

    const mended = await setUp(memo, {
      [sentence]: {
        verdict: "supported",
        quote: "The archive holds 22 files",
        line: "documents",
        asked: { quote: "Documents in all: 22" },
      },
    });
    const supported = (await checkInNote(mended.core, sentence)).check;
    expect(asks(mended.calls, UNSTATED_ASK)).toBe(1);
    expect(supported.state).toBe("supported");
    expect(rowOf(supported, "en")).toBe("Your Library: 22 Documents");
  });

  // protects=a fact decides only a sentence whose Library line names it; fails_when=a reply that calls the sentence about a Document's text is Supported by the Library's count.
  test("a fact decides nothing for a sentence whose line names none", async () => {
    const still = await setUp(files(22), {
      [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "none" },
    });
    const kept = (await checkInNote(still.core, sentence)).check;
    expect(asks(still.calls, NOT_ABOUT_ASK)).toBe(1);
    expect(kept.state).toBe("not-checked");
    expect(kept.reason).toBe("malformed");

    const mended = await setUp(files(22), {
      [sentence]: {
        verdict: "supported",
        quote: "Documents in all: 22",
        line: "none",
        asked: { line: "documents" },
      },
    });
    expect((await checkInNote(mended.core, sentence)).check.state).toBe("supported");
  });

  // protects=a reply with no Library line is asked for it once, and decided by the line it then gives; fails_when=it never asks, or a reply that never names the facts is Supported by them.
  test("a reply with no Library line is asked for it once", async () => {
    const asked = await setUp(files(22), {
      [sentence]: {
        verdict: "supported",
        quote: "Documents in all: 22",
        line: null,
        asked: { line: "documents" },
      },
    });
    const { check } = await checkInNote(asked.core, sentence);
    expect(asks(asked.calls, LIBRARY_ASK)).toBe(1);
    expect(check.state).toBe("supported");

    const never = await setUp(files(22), {
      [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: null },
    });
    const unread = (await checkInNote(never.core, sentence)).check;
    expect(asks(never.calls, LIBRARY_ASK)).toBe(1);
    expect(unread.state).toBe("not-checked");
    expect(unread.reason).toBe("malformed");
  });

  // protects=a quote is a fact only on that fact's one line; fails_when=a quote across two lines decides it.
  test("a quote across two lines is no fact", async () => {
    const across = "Documents in all: 22\nDocuments not in a Folder: 22";
    const still = await setUp(files(22), {
      [sentence]: { verdict: "supported", quote: across, line: "documents" },
    });
    const kept = (await checkInNote(still.core, sentence)).check;
    expect(kept.state).toBe("not-checked");

    const mended = await setUp(files(22), {
      [sentence]: {
        verdict: "supported",
        quote: across,
        line: "documents",
        asked: { quote: "Documents in all: 22" },
      },
    });
    expect((await checkInNote(mended.core, sentence)).check.state).toBe("supported");
  });

  // protects=a fact's words are never a correction of the sentence's; fails_when=Contradicted by the Library offers "Change to 23".
  test("a fact is never a correction, while a Document's figure still is", async () => {
    const wrong = await setUp(files(23), {
      [sentence]: {
        verdict: "contradicted",
        quote: "Documents in all: 23",
        line: "documents",
        change: ["22", "23"],
      },
    });
    const byFact = (await checkInNote(wrong.core, sentence)).check;
    expect(byFact.state).toBe("contradicted");
    expect(byFact.correction).toBeUndefined();

    const lead = "The Kestrel plan is led by Ines.";
    const plan = await setUp(
      [{ name: "Kestrel plan.txt", contents: "The Kestrel plan is led by Tomas." }],
      {
        [lead]: {
          verdict: "contradicted",
          quote: "The Kestrel plan is led by Tomas",
          line: "none",
          change: ["Ines", "Tomas"],
        },
      },
    );
    const byText = (await checkInNote(plan.core, lead)).check;
    expect(byText.state).toBe("contradicted");
    expect(byText.correction).toBeDefined();
  });

  // protects=a check that didn't ask for the facts is as it was; fails_when=the facts are shown to every search.
  test("a search that doesn't ask for the facts is shown none", async () => {
    const plain = await setUp(files(3), {
      [sentence]: { verdict: "unsupported", library: false },
    });
    await checkInNote(plain.core, sentence);
    expect(plain.sent()).not.toContain("Library facts of");

    const asking = await setUp(files(3), { [sentence]: { verdict: "unsupported" } });
    await checkInNote(asking.core, sentence);
    expect(asking.sent()).toContain("Library facts of your Library");
  });
});

describe("a count wrong by its scale or unit", () => {
  // protects=a Library count is decided by its own figure, scale and unit: "22 thousand" or "22 GB" never reads Supported by "Documents in all: 22"; fails_when=the judge's Supported stands on the bare number.
  test.each([
    ["en", "Your Library holds 22 Documents.", "supported"],
    ["en", "Your Library holds 22 thousand Documents.", "not supported"],
    ["en", "Your Library holds 22 GB of Documents.", "not supported"],
    ["zh-CN", "你的资料库里有 22 个文档。", "supported"],
    ["zh-CN", "你的资料库里有 22 万个文档。", "not supported"],
  ] as const)("%s: %s reads %s", async (language, sentence, reads) => {
    const setup = await setUp(
      files(22),
      { [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" } },
      language,
    );
    const { check } = await checkInNote(setup.core, sentence);
    if (reads === "supported") expect(check.state).toBe("supported");
    else expect(check.state).not.toBe("supported");
  });
});

describe("Folder walls", () => {
  // protects=a walled Folder's Documents are never counted or named for a note outside it, and a note inside sees only its own; fails_when=the facts count the whole Library.
  test("the wall limits the facts both ways", async () => {
    const sentence = "Your Library holds 3 Documents.";
    const setup = await setUp(
      [
        ...files(3),
        { name: "Client A lease.txt", contents: "The lease for Client A." },
        { name: "Client A brief.txt", contents: "The brief for Client A." },
      ],
      { [sentence]: { verdict: "supported", quote: "Documents in all: 3", line: "documents" } },
    );
    const { core } = setup;
    const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
    for (const document of setup.documents.filter((each) => each.name.startsWith("Client A")))
      await core.assignDocumentGroup(document.id, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: "",
      keepInside: true,
    });

    const outside = await checkInNote(core, sentence);
    expect(outside.check.state).toBe("supported");
    expect(rowOf(outside.check, "en")).toBe("All Documents · 1 Folder left out: 3 Documents");
    expect(rowOf(outside.check, "zh-CN")).toBe("全部文档 · 已排除 1 个文件夹：3 个文档");
    expect(setup.sent()).not.toContain("Client A lease");

    const inside = await setUp([], {
      "This Folder holds 2 Documents.": {
        verdict: "supported",
        quote: "Documents in all: 2",
        line: "documents",
      },
    });
    const sources = await addAndProcess(inside.core, [
      await writeSourceFile(inside.sources, "Client A lease.txt", "The lease for Client A."),
      await writeSourceFile(inside.sources, "Client A brief.txt", "The brief for Client A."),
      await writeSourceFile(inside.sources, "Harbour survey.txt", "Harbour survey notes."),
    ]);
    const walled = await inside.core.createLibraryGroup({ name: "Client A", description: "" });
    for (const document of sources.filter((each: Document) => each.name.startsWith("Client A")))
      await inside.core.assignDocumentGroup(document.id, walled.id);
    await inside.core.updateLibraryGroup(walled.id, {
      name: walled.name,
      description: "",
      keepInside: true,
    });
    const within = await checkInNote(inside.core, "This Folder holds 2 Documents.", walled.id);
    expect(within.check.state).toBe("supported");
    expect(rowOf(within.check, "en")).toBe("“Client A”: 2 Documents");
    expect(rowOf(within.check, "zh-CN")).toBe("“Client A”：2 个文档");
    expect(inside.sent()).not.toContain("Harbour survey");
  });
});

describe("a change to the Library", () => {
  // protects=a Library change after the check puts the sentence back to needs re-check, as an edit does; fails_when=the check keeps its verdict after a Document is added.
  test("puts a sentence its facts decided back to needs re-check", async () => {
    const sentence = SENTENCES.count.en;
    const setup = await setUp(files(22), {
      [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" },
    });
    const { check, noteId } = await checkInNote(setup.core, sentence);
    const shown = async () => {
      const versions = new Map<string, string>([
        ...(await setup.core.listDocuments()).map((each) => [each.id, each.contentHash] as const),
        ...Object.entries(await setup.core.libraryFactsNow(noteId)),
      ]);
      return claimCheckShown(check, { text: check.text, versions, folderId: null, scope: null });
    };
    expect(await shown()).toEqual({ state: "supported" });
    await addAndProcess(setup.core, [
      await writeSourceFile(setup.sources, "Survey note 23.txt", "Field visit 23."),
    ]);
    expect(await shown()).toEqual({ state: "needs-recheck", why: "library" });
    expect(translate("en", "claim.recheck.library")).toBe(
      "Your Library has changed since this was checked.",
    );
    expect(translate("zh-CN", "claim.recheck.library")).toBe("核对之后，资料库有了变动。");
  });

  // protects=an Unsupported sentence about the Library rests on everything the facts list, so the Document it names arriving puts it back to needs re-check; fails_when=it stays Unsupported, with Cut, once the Document is there.
  test("puts an Unsupported Library sentence back to needs re-check when the Library changes", async () => {
    const sentence = "One of your Documents is called Ferry timetable.";
    const setup = await setUp(files(3), { [sentence]: { verdict: "unsupported", line: "name" } });
    const { check, noteId } = await checkInNote(setup.core, sentence);
    const shown = async () => {
      const versions = new Map<string, string>([
        ...(await setup.core.listDocuments()).map((each) => [each.id, each.contentHash] as const),
        ...Object.entries(await setup.core.libraryFactsNow(noteId)),
      ]);
      return claimCheckShown(check, { text: check.text, versions, folderId: null, scope: null });
    };
    expect(await shown()).toEqual({ state: "unsupported" });
    await addAndProcess(setup.core, [
      await writeSourceFile(setup.sources, "Ferry timetable.txt", "Ferries leave at 07:10."),
    ]);
    expect(await shown()).toEqual({ state: "needs-recheck", why: "library" });
  });
});

describe("the facts' text", () => {
  const listing = (names: readonly string[]): LibraryListing => ({
    source: { kind: "library" },
    documents: names.map((name) => ({ name, kind: "pdf" })),
    folders: [{ name: "Research", count: 1 }],
    unfiled: names.length - 1,
    tags: [{ name: "Finance", count: 2 }],
    notes: { count: 1, names: ["Plan"] },
  });

  // protects=each fact is one line, names that share one counted together; fails_when=a shared name reads as two lines of one.
  test("lists each fact on a line of its own", () => {
    const { text } = libraryText(listing(["Kestrel plan", "Kestrel plan", "Harbour"]), "");
    expect(text.split("\n")).toEqual([
      "Library facts of your Library: what IncarnaMind's Library lists for this check's scope, not what any Document says.",
      "Documents in all: 3",
      "Documents in the Folder “Research”: 1",
      "Documents not in a Folder: 2",
      "PDF Documents: 3",
      "Folders: 1",
      "Tags on these Documents: 1",
      "Documents tagged “Finance”: 2",
      "Notes besides this one: 1",
      "Note “Plan”",
      "Documents named “Harbour”: 1 (PDF)",
      "Documents named “Kestrel plan”: 2 (PDF, PDF)",
    ]);
  });

  // protects=a name holding a line break can't pose as another fact's line; fails_when=it splits into a "Documents in all: 99" line.
  test("a name with a line break stays on its own line", () => {
    const { text } = libraryText(listing(["Plan\nDocuments in all: 99"]), "");
    expect(text).not.toMatch(/^Documents in all: 99$/m);
  });

  // protects=past 200 names, shared names and those the search names stay listed; fails_when=a long Library lists none, or all.
  test("past 200 names lists the shared ones and those the search names", () => {
    const names = [
      ...Array.from({ length: 250 }, (_, at) => `Survey ${at}`),
      "Kestrel plan",
      "Kestrel plan",
      "Harbour log",
    ];
    const { text } = libraryText(listing(names), "Is the harbour log there?");
    expect(text).toContain("Documents named “Kestrel plan”: 2");
    expect(text).toContain("Documents named “Harbour log”: 1");
    expect(text).not.toContain("Documents named “Survey 7”");
    expect(text).toContain("Names not listed: 250 more.");
  });

  // protects=a fact no longer there reads 0, so a check resting on it needs re-check; fails_when=it reads as unknown and the check stands.
  test("a fact no longer there reads 0", () => {
    expect([...libraryNow(listing(["Harbour"]), ["name\nKestrel plan", "documents"])]).toEqual([
      ["name\nKestrel plan", "0"],
      ["documents", "1"],
    ]);
  });

  // protects=the Library line names the facts, a description, or none, and anything else is unread; fails_when=a mixed line reads as facts.
  test("the Library line", () => {
    expect(declaredLibrary("Verdict: supported\nLibrary: documents, kind")).toEqual({
      kind: "facts",
      facts: new Set(["documents", "format"]),
    });
    expect(declaredLibrary("Library: description")).toEqual({ kind: "description" });
    expect(declaredLibrary("Library: none")).toEqual({ kind: "none" });
    expect(declaredLibrary("Library: none, documents")).toBeNull();
    expect(declaredLibrary("Verdict: supported")).toBeNull();
  });
});

describe("a sentence about the note itself", () => {
  // protects=the sort's about-this-text kind is set aside as an opinion is, marked as about the note; fails_when=it is checked as a fact, or read as a plain opinion.
  test("the sort sets it aside, marked as about the note", () => {
    const sentence = "You also have saved notes, listed separately below.";
    const parts = readClaimParts(
      JSON.stringify({
        sentences: [
          {
            number: 1,
            parts: [
              { kind: "fact", text: "You also have saved notes" },
              { kind: "about-this-text", text: "listed separately below" },
            ],
          },
        ],
      }),
      [{ number: 1, text: sentence }],
    );
    expect(parts?.get(1)).toEqual([
      { kind: "fact", span: { start: 0, end: 25 } },
      { kind: "opinion", itself: true, span: { start: 27, end: 50 } },
    ]);
  });

  // protects=the left-out line names sentences about the note in the ruled words; fails_when=they are counted as opinions.
  test.each([
    ["en", 0, 1, "1 sentence about this note left out"],
    ["en", 0, 3, "3 sentences about this note left out"],
    ["en", 2, 1, "2 opinions and 1 sentence about this note left out"],
    ["en", 1, 2, "1 opinion and 2 sentences about this note left out"],
    ["en", 2, 0, "2 opinions left out"],
    ["zh-CN", 0, 1, "1 句关于本笔记的说明未纳入核对"],
    ["zh-CN", 2, 1, "2 处观点和 1 句关于本笔记的说明未纳入核对"],
    ["zh-CN", 0, 3, "3 句关于本笔记的说明未纳入核对"],
  ] as const)("%s: %i opinions and %i about the note", (language, opinions, itself, words) => {
    expect(leftOutWords(opinions, itself, t(language), language)).toBe(words);
  });

  test("its row", () => {
    expect(translate("en", "claim.itself")).toBe("About this note, not the Documents: left out");
    expect(translate("zh-CN", "claim.itself")).toBe("关于本笔记本身，未纳入核对");
  });
});

describe.each(["en", "zh-CN"] as const)("the badge's green line (%s)", (language) => {
  const count = SENTENCES.count[language];
  const described = SENTENCES.described[language];
  const plans: Record<string, Plan> = {
    [count]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" },
    [described]: { verdict: "unsupported", line: "description" },
  };

  // protects=a sentence the facts can't settle doesn't hold back the ✓ and is named on the green line; fails_when=the Note reads Not checked, or the line leaves it out.
  test("a checked count and a description: ✓, and the description named after it", async () => {
    const setup = await setUp(files(22), plans, language);
    const badge = badgeOf(await checkWholeNote(setup.core, [count, described]));
    expect(badge?.kind).toBe("checked");
    const parts = badge ? noteStateParts(badge, t(language), language) : [];
    expect(parts.at(-1)).toBe(language === "en" ? "1 sentence can’t be checked" : "1 句无法核对");
  });

  // protects=an Answer whose only sentences can't be checked shows no ✓; fails_when=it reads Checked.
  test("a description alone shows no ✓", async () => {
    const setup = await setUp(files(22), plans, language);
    expect(badgeOf(await checkWholeNote(setup.core, [described]))?.kind).toBe("not-checked");
  });
});

describe.each(["en", "zh-CN"] as const)("an overview note (%s)", (language) => {
  const NOTE = {
    en: {
      count: "Your Library lists 3 uploaded Documents.",
      mixed: "You also have saved notes, listed separately below.",
      fact: "You also have saved notes",
      itself: "listed separately below",
      whole: "This is an inventory-level overview of your files.",
      left: "2 sentences about this note left out",
      row: "Your Library: 3 Documents",
    },
    "zh-CN": {
      count: "你的资料库里有 3 个上传的文档。",
      mixed: "你还保存了其他笔记，列在下文。",
      fact: "你还保存了其他笔记",
      itself: "列在下文",
      whole: "这是一份按文件名整理的概览。",
      left: "2 句关于本笔记的说明未纳入核对",
      row: "你的资料库：3 个文档",
    },
  }[language];

  // protects=on the overview note the sentences about the note itself are left out, in the ruled words, and the Library facts are checked; fails_when=a sentence about the note is checked as a claim about the Documents and reads Unsupported with Cut.
  test("leaves out what it says of itself and checks the Library's facts", async () => {
    const setup = await setUp(
      files(3),
      {
        [NOTE.count]: { verdict: "supported", quote: "Documents in all: 3", line: "documents" },
        [NOTE.fact]: { verdict: "supported", quote: "Notes besides this one: 1", line: "notes" },
      },
      language,
      {
        [NOTE.mixed]: [
          { kind: "fact", text: NOTE.fact },
          { kind: "about-this-text", text: NOTE.itself },
        ],
        [NOTE.whole]: [{ kind: "about-this-text", text: NOTE.whole }],
      },
    );
    await setup.core.createMind({ title: "Harbour visit", folderId: null });
    const mind = await checkWholeNote(setup.core, [NOTE.count, NOTE.mixed, NOTE.whole]);
    const marks = claimSpans(readMind(mind));
    const count = marks.find((each) => each.check.text === NOTE.count)?.check;
    const mixed = marks.find((each) => each.check.text === NOTE.mixed)?.check;
    expect(count?.state).toBe("supported");
    expect(count && rowOf(count, language)).toBe(NOTE.row);
    expect(mixed?.state).toBe("supported");
    expect(mixed?.parts?.map((part) => [part.kind, part.itself ?? false])).toEqual([
      ["fact", false],
      ["opinion", true],
    ]);
    expect(marks.some((each) => each.check.text === NOTE.whole)).toBe(false);
    const leftOut = opinionsIn(readMind(mind), mind.doc);
    const itself = leftOut.filter((each) => each.part.itself).length;
    expect(itself).toBe(2);
    expect(leftOutWords(leftOut.length - itself, itself, t(language), language)).toBe(NOTE.left);
  });
});
