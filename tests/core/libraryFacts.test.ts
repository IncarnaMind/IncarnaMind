/**
 * A sentence about the Library itself (#2525) is checked against the Library's own facts as the
 * check's scope saw them, Folder walls applied: how many Documents it holds, their names and kinds,
 * which share a name, its Folders, Tags and notes. The model asks for them with its search and
 * names, on its reply's Library line, the facts its sentence states; the rules that hold its result
 * are the core's, whatever the model says. A sentence about the note itself is set aside by the
 * sort, as an opinion is.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Core, Document, SearchScope } from "../../src/core";
import { readClaimParts } from "../../src/core/answers/checks/claims";
import {
  declaredLibrary,
  type LibraryListing,
  libraryNow,
  libraryText,
  linkedFolderName,
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
import { setMindScope } from "../../src/shared/mindScope";
import {
  checkGenerate,
  isCheckRun,
  listedSentences,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { textOf, unzip } from "../helpers/docx";
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
  /** For a sentence with figures, the words each figure is bound to, cited second; `quote` when absent. */
  figureQuote?: string;
  /** The number of those words each figure is bound to; their first number when absent. */
  figureNumber?: string;
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
        const passageOf = (words: string) =>
          (shown.find((each) => each.text.includes(words)) ?? shown[0])?.id;
        const citations = [quote, ...(plan.figureQuote ? [plan.figureQuote] : [])].map(
          (words, at) => ({ marker: at + 1, passage: passageOf(words), quote: words }),
        );
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      const line = plan.line === undefined ? "none" : plan.line;
      const lines = [
        `Verdict: ${plan.verdict}`,
        ...(line === null ? [] : [`Library: ${line}`]),
        "Absence: no",
        "Topic: found",
        SAME_DETAIL,
        ...(plan.says ? [`${plan.says}${quote ? " [^1]" : ""}`] : []),
        ...(plan.change ? [`Change 1: ${plan.change[0]}`, `To 1: ${plan.change[1]} [^1]`] : []),
      ];
      const figures = requestedFigures(call);
      if (figures.length > 0) {
        const bound = plan.figureQuote ?? quote;
        const marker = plan.figureQuote ? 2 : 1;
        const number = plan.figureNumber ?? bound?.match(/\d+/)?.[0];
        const items = figures.map(({ id, reading }) => ({
          id,
          verdict: number ? plan.verdict : "unsupported",
          scope: "same",
          topic: number ? "found" : "not found",
          roles: "same",
          says: null,
          reading,
          relation: "equals",
          source: number ? { citation: marker, number } : null,
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
  /** What the Library's facts Passage of every search carried: the Documents' own Passages left out. */
  const factsSent = () => factsIn(calls);
  return { core, documents, calls, sent, factsSent, sources };
}

/** The text of every Library facts Passage the model was shown, with its attributes checked. */
function factsIn(calls: readonly ModelCall[]): string {
  const shown = calls
    .flatMap((call) => call.results.filter((each) => each.tool === "search_documents"))
    .flatMap((result) => shownPassages(result.text))
    .filter((passage) => passage.document === "Library facts");
  for (const passage of shown) {
    if (passage.date !== null || passage.pages !== null || passage.location !== null)
      throw new Error("The Library facts Passage carried a date, pages or a location.");
  }
  return shown.map((passage) => passage.text).join("\n");
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
  scope: SearchScope | null = null,
) {
  const note = await core.createMind({ title: "Library overview", folderId });
  const mind = await connectToMind(core, note.id);
  writeMind(mind, [paragraph("one", sentence)]);
  if (scope) setMindScope(mind.doc, scope);
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
  shared: {
    en: "Exactly one name in your Library is shared by two Documents.",
    "zh-CN": "你的资料库里有一个文件名重名了。",
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

  // protects=a sentence about names Documents share is decided by how many names more than one Document shares, however it says it; fails_when="shared by" or 重名 sends no count and the true sentence reads Unsupported with Cut.
  test("a sentence about shared names reads Supported by their count, and Contradicted against none", async () => {
    const sentence = SENTENCES.shared[language];
    const plan = (verdict: Plan["verdict"], count: number) => ({
      [sentence]: {
        verdict,
        quote: `Names more than one Document shares: ${count}`,
        line: "shared",
      },
    });
    const two = await setUp(
      [
        { name: "Kestrel plan.txt", contents: "Plan for the Kestrel site." },
        { name: "Kestrel plan.md", contents: "# Kestrel plan\n\nThe second draft." },
        { name: "Harbour survey.txt", contents: "Harbour survey notes." },
      ],
      plan("supported", 1),
      language,
    );
    const supported = await checkInNote(two.core, sentence);
    expect(supported.check.state).toBe("supported");
    expect(rowOf(supported.check, language)).toBe(
      language === "en"
        ? "Your Library: 1 name shared by several Documents"
        : "你的资料库：1 个名称由多个文档共用",
    );

    const none = await setUp(
      [
        { name: "Kestrel plan.txt", contents: "Plan for the Kestrel site." },
        { name: "Harbour survey.txt", contents: "Harbour survey notes." },
      ],
      plan("contradicted", 0),
      language,
    );
    expect((await checkInNote(none.core, sentence)).check.state).toBe("contradicted");
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
    // The sentence names no note: their count is sent, and no title.
    expect(setup.factsSent()).toContain("Notes besides this one: 2");
    for (const title of ["Harbour visit", "Kestrel budget", "Library overview"])
      expect(setup.factsSent()).not.toContain(title);
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

  // protects=a Library sentence with no figure is held to its Library line on its own: a Document's text that names the file never decides it; fails_when=only a figure's Citations are held to the facts.
  test("a Document's text never decides a Library sentence that has no figure", async () => {
    const named = "A Document called Harbour survey is in your Library.";
    const index = [
      { name: "Harbour survey.txt", contents: "Harbour survey notes." },
      { name: "File index.txt", contents: "File index: Harbour survey, Tide log." },
    ];
    const still = await setUp(index, {
      [named]: { verdict: "supported", quote: "File index: Harbour survey", line: "name" },
    });
    const kept = (await checkInNote(still.core, named)).check;
    expect(kept.state).toBe("not-checked");
    expect(kept.reason).toBe("malformed");

    const mended = await setUp(index, {
      [named]: {
        verdict: "supported",
        quote: "File index: Harbour survey",
        line: "name",
        asked: { quote: "Documents named “Harbour survey”: 1" },
      },
    });
    const supported = (await checkInNote(mended.core, named)).check;
    expect(supported.state).toBe("supported");
    expect(rowOf(supported, "en")).toBe("Your Library: 1 Document named “Harbour survey”");
  });

  // protects=a figure bound to a Document's number is no count, even when the reply's prose cites the count; fails_when=a figure bound to a Document's "22 files" is Supported because the sentence cites "Documents in all: 22".
  test("a figure bound to a Document's number is no count, though the reply cites the count", async () => {
    const bound = await setUp(memo, {
      [sentence]: {
        verdict: "supported",
        quote: "Documents in all: 22",
        figureQuote: "The archive holds 22 files",
        says: "The Library lists 22 Documents.",
        line: "documents",
      },
    });
    expect((await checkInNote(bound.core, sentence)).check.state).toBe("not-checked");

    const counted = await setUp(memo, {
      [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" },
    });
    expect((await checkInNote(counted.core, sentence)).check.state).toBe("supported");
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

describe("a verdict the facts must decide", () => {
  // protects=shown the facts, a Supported verdict that rests on a Document's text alone is asked about once, then reads Not checked; a search that didn't ask for the facts is as it was; fails_when="Your files include the Osprey contract." is Supported by one Document line.
  test("a Supported verdict resting on a Document's text alone, after the facts were shown", async () => {
    const sentence = "Your files include the Osprey contract.";
    const plan = {
      verdict: "supported",
      quote: "Osprey contract, signed copy",
      line: "none",
      says: "The Document lists a contract.",
    } as const;
    const osprey = [
      ...files(2),
      { name: "Osprey contract.txt", contents: "Osprey contract, signed copy." },
    ];
    const shown = await setUp(osprey, { [sentence]: plan });
    const kept = (await checkInNote(shown.core, sentence)).check;
    expect(
      Math.max(
        0,
        ...shown.calls
          .filter(isCheckRun)
          .map(
            (call) =>
              call.prompt.split("yet your Verdict rests on a Document's text alone").length - 1,
          ),
      ),
    ).toBe(1);
    expect(kept.state).toBe("not-checked");

    const unasked = await setUp(osprey, { [sentence]: { ...plan, library: false } });
    expect((await checkInNote(unasked.core, sentence)).check.state).toBe("supported");
  });

  // protects=a count written in words is held to the fact as digits are; fails_when="twelve Documents" reads Supported by "Documents in all: 11".
  test.each([
    ["en", "Your Library holds twelve Documents.", "not supported"],
    ["en", "Your Library holds eleven Documents.", "supported"],
    ["zh-CN", "你的资料库里有十二个文档。", "not supported"],
    ["zh-CN", "你的资料库里有十一个文档。", "supported"],
  ] as const)("%s: %s reads %s", async (language, sentence, reads) => {
    const setup = await setUp(
      files(11),
      { [sentence]: { verdict: "supported", quote: "Documents in all: 11", line: "documents" } },
      language,
    );
    const { check } = await checkInNote(setup.core, sentence);
    if (reads === "supported") expect(check.state).toBe("supported");
    else expect(check.state).not.toBe("supported");
  });

  // protects=a Word export says a Library sentence needs a re-check once the Library changed, as the window does; fails_when=the export compares Documents' versions only.
  test("a Word export says a Library change needs a re-check", async () => {
    const sentence = SENTENCES.count.en;
    const setup = await setUp(files(22), {
      [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" },
    });
    const { noteId } = await checkInNote(setup.core, sentence);
    const commented = async () => {
      const result = await setup.core.exportMind(noteId, {
        format: "docx",
        commentFailedChecks: true,
      });
      return textOf(unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "");
    };
    const changed = "Needs re-check: your Library has changed since this was checked.";
    expect(await commented()).not.toContain(changed);
    await addAndProcess(setup.core, [
      await writeSourceFile(setup.sources, "Survey note 23.txt", "Field visit 23."),
    ]);
    expect(await commented()).toContain(changed);
  });
});

describe.each(["en", "zh-CN"] as const)("a name with digits in it (%s)", (language) => {
  const zh = language === "zh-CN";
  const twins = (name: string) => [
    { name: `${name}.txt`, contents: "First copy of the ledger." },
    { name: `${name}.md`, contents: "# Ledger\n\nSecond copy of the ledger." },
  ];

  // protects=the digits of a Document's name count nothing: "Ledger 0007 appears twice" is never Contradicted by the line that says two share that name; fails_when=the "0007" is read as a count and judged against "Documents named “Ledger 0007”: 2".
  test("a name's number is no count, for or against", async () => {
    const name = zh ? "档案 0007" : "Ledger 0007";
    const sentence = zh
      ? `${name} 在你的资料库中出现了两次。`
      : `${name} appears twice in your Library.`;
    const setup = await setUp(
      twins(name),
      {
        [sentence]: {
          verdict: "contradicted",
          quote: `Documents named “${name}”: 2`,
          line: "name",
        },
      },
      language,
    );
    const { check } = await checkInNote(setup.core, sentence);
    expect(setup.factsSent()).toContain(`Documents named “${name}”: 2`);
    expect(check.state).not.toBe("contradicted");
  });

  // protects=a name's number the judge compares with a count is no count, so it is never Contradicted by one; fails_when="You keep Ledger 0007 in your Library." reads Contradicted because 0007 isn't 2.
  test("a name's number compared with a count is never contradicted by it", async () => {
    const name = zh ? "档案 0007" : "Ledger 0007";
    const sentence = zh
      ? `你在资料库里保存了 ${name} 这个文件。`
      : `You keep ${name} in your Library.`;
    const setup = await setUp(
      twins(name),
      {
        [sentence]: {
          verdict: "contradicted",
          quote: `Documents named “${name}”: 2`,
          figureNumber: "2",
          line: "name",
        },
      },
      language,
    );
    const { check } = await checkInNote(setup.core, sentence);
    expect(setup.calls.some((call) => requestedFigures(call).length > 0)).toBe(true);
    expect(check.state).not.toBe("contradicted");
  });

  // protects=a count written in words is held to the facts though the sentence has digits in a name, both ways; fails_when="Ledger A7 appears three times" reads Supported by "Documents named “Ledger A7”: 2", or "appears twice" reads Contradicted by it.
  test("a count in words is held to the facts beside a name's digits", async () => {
    const name = zh ? "档案 A7" : "Ledger A7";
    const thrice = zh
      ? `${name} 在你的资料库中出现了三次。`
      : `${name} appears three times in your Library.`;
    const twice = zh
      ? `${name} 在你的资料库中出现了两次。`
      : `${name} appears twice in your Library.`;
    const line = `Documents named “${name}”: 2`;
    const wrong = await setUp(
      twins(name),
      { [thrice]: { verdict: "supported", quote: line, line: "name" } },
      language,
    );
    expect((await checkInNote(wrong.core, thrice)).check.state).not.toBe("supported");
    const right = await setUp(
      twins(name),
      { [twice]: { verdict: "supported", quote: line, line: "name" } },
      language,
    );
    expect((await checkInNote(right.core, twice)).check.state).toBe("supported");
    const turned = await setUp(
      twins(name),
      { [twice]: { verdict: "contradicted", quote: line, line: "name" } },
      language,
    );
    expect((await checkInNote(turned.core, twice)).check.state).not.toBe("contradicted");
  });
});

describe("a count wrong by its scale or unit", () => {
  // protects=a Library count is decided by its own figure, scale and unit: "22 thousand" or "22 GB" never reads Supported by "Documents in all: 22"; fails_when=the judge's Supported stands on the bare number.
  test.each([
    ["en", "Your Library holds 22 Documents.", "supported"],
    ["en", "Your Library holds 22 plain text files.", "supported"],
    ["en", "Your Library holds 22 workbooks.", "supported"],
    ["en", "Your Library holds 22 thousand Documents.", "not supported"],
    ["en", "Your Library holds 22 GB of Documents.", "not supported"],
    ["en", "Your Library takes up 22 TB.", "not supported"],
    ["zh-CN", "你的资料库占用 22 TB。", "not supported"],
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

  // protects=a Library count at another scale says it is the Library's number, never a Document's; fails_when="The Document gives 22, not 22 thousand." for a count of the Library.
  test.each([
    ["en", "Your Library holds 22 thousand Documents.", "Your Library has 22, not 22 thousand."],
    ["zh-CN", "你的资料库里有 22 万个文档。", "你的资料库有 22，不是 22 万个。"],
  ] as const)("%s: %s says why with the Library's number", async (language, sentence, reason) => {
    const setup = await setUp(
      files(22),
      { [sentence]: { verdict: "supported", quote: "Documents in all: 22", line: "documents" } },
      language,
    );
    const { check } = await checkInNote(setup.core, sentence);
    expect(check.state).toBe("unsupported");
    expect(check.unsupported?.reason).toBe(reason);
  });
});

describe("Folder walls", () => {
  // protects=a Search scope picked before its Folder got a wall sends nothing of that Folder from outside it, its name least of all; fails_when="Library facts of “Litigation hold” and 1 more" reaches the model.
  test("an old scope pick of a walled Folder sends no trace of its name from outside", async () => {
    const sentence = "The Litigation hold and Fieldwork Folders hold 1 Document.";
    const setup = await setUp(
      [...files(2), { name: "Hold notice.txt", contents: "Notice of the hold on the records." }],
      { [sentence]: { verdict: "supported", quote: "Documents in all: 1", line: "documents" } },
    );
    const { core } = setup;
    const hold = await core.createLibraryGroup({ name: "Litigation hold", description: "" });
    const open = await core.createLibraryGroup({ name: "Fieldwork", description: "" });
    const notice = setup.documents.find((each) => each.name === "Hold notice");
    const survey = setup.documents.find((each) => each.name === "Survey note 01");
    if (!notice || !survey) throw new Error("The test Documents are missing.");
    await core.assignDocumentGroup(notice.id, hold.id);
    await core.assignDocumentGroup(survey.id, open.id);
    const picked = { folderIds: [hold.id, open.id], tagIds: [], documentIds: [] };
    await core.updateLibraryGroup(hold.id, { name: hold.name, description: "", keepInside: true });
    const { check } = await checkInNote(core, sentence, null, false, picked);
    expect(check.state).toBe("supported");
    const results = setup.calls.flatMap((call) => call.results.map((each) => each.text)).join("\n");
    for (const walled of ["Litigation", "Hold notice", "the records"])
      expect(results).not.toContain(walled);
    expect(setup.factsSent()).toContain("Library facts of “Fieldwork”");
  });

  // protects=nothing of a walled Folder reaches a request for a scope that leaves it out: not its name, its Documents' names, a Tag only its Documents carry, a note in it, nor a count that includes them; and a note inside sees only its own; fails_when=the facts count or name the whole Library.
  test("the wall limits the facts both ways, even for a sentence that names what it keeps", async () => {
    const sentence =
      "Your Library holds 3 Documents, with no Client A lease, brief or memo under Litigation hold.";
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
    const hold = await core.createTag({ name: "Litigation hold" });
    const fieldwork = await core.createTag({ name: "Fieldwork" });
    const [lease, survey] = [
      setup.documents.find((each) => each.name === "Client A lease"),
      setup.documents.find((each) => each.name === "Survey note 01"),
    ];
    if (!lease || !survey) throw new Error("The test Documents are missing.");
    await core.addDocumentTag(lease.id, hold.id);
    await core.addDocumentTag(survey.id, fieldwork.id);
    await core.createMind({ title: "Walled memo", folderId: folder.id });
    await core.createMind({ title: "Harbour visit", folderId: null });

    const outside = await checkInNote(core, sentence);
    expect(outside.check.state).toBe("supported");
    expect(rowOf(outside.check, "en")).toBe("All Documents · 1 Folder left out: 3 Documents");
    expect(rowOf(outside.check, "zh-CN")).toBe("全部文档 · 已排除 1 个文件夹：3 个文档");
    // Everything the requests carried beside the sentence itself: the facts and every Passage found.
    const sent = setup.calls.flatMap((call) => call.results.map((each) => each.text)).join("\n");
    for (const walledWords of ["Client A", "Litigation hold", "Walled memo", "Documents in all: 5"])
      expect(sent).not.toContain(walledWords);
    for (const seen of [
      "Documents in all: 3",
      "Tags on these Documents: 1",
      "Notes besides this one: 1",
    ])
      expect(sent).toContain(seen);

    const inFolder =
      "This Folder holds 2 Documents, not the Harbour survey, Fieldwork or Harbour visit.";
    const inside = await setUp([], {
      [inFolder]: {
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
    const outer = await inside.core.createTag({ name: "Fieldwork" });
    const harbour = sources.find((each: Document) => each.name === "Harbour survey");
    if (!harbour) throw new Error("The test Document is missing.");
    await inside.core.addDocumentTag(harbour.id, outer.id);
    await inside.core.createMind({ title: "Harbour visit", folderId: null });
    await inside.core.createMind({ title: "Lease timeline", folderId: walled.id });
    const within = await checkInNote(inside.core, inFolder, walled.id);
    expect(within.check.state).toBe("supported");
    expect(rowOf(within.check, "en")).toBe("“Client A”: 2 Documents");
    expect(rowOf(within.check, "zh-CN")).toBe("“Client A”：2 个文档");
    const insideSent = inside.calls
      .flatMap((call) => call.results.map((each) => each.text))
      .join("\n");
    for (const outsideWords of [
      "Harbour survey",
      "Fieldwork",
      "Harbour visit",
      "Documents in all: 3",
    ])
      expect(insideSent).not.toContain(outsideWords);
    for (const seen of ["Documents in all: 2", "Notes besides this one: 1"])
      expect(insideSent).toContain(seen);
  });
});

/** The kinds of data the checks flow named when this was built, which a User who allowed it before hasn't. */
const WIDENED: readonly string[] = [
  "library-counts",
  "library-names",
  "file-properties",
  "absence-documents",
  "watched-sentences",
];

describe("where the Library's facts go", () => {
  const sentence = "Your Library holds 3 Documents.";
  const plans: Record<string, Plan> = {
    [sentence]: { verdict: "supported", quote: "Documents in all: 3", line: "documents" },
  };

  /** Three Documents and a note checked on the model `choose` saves; the scripted one answers for it. */
  async function library(choose: (core: Core) => Promise<{ service?: { id: string } | null }>) {
    const calls: ModelCall[] = [];
    const models = scriptedModels(libraryModel(plans, calls));
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    const service = (await choose(core)).service?.id ?? null;
    const sources = await createTempDataFolder();
    await addAndProcess(
      core,
      await Promise.all(files(3).map((file) => writeSourceFile(sources, file.name, file.contents))),
    );
    const note = await core.createMind({ title: "Library overview", folderId: null });
    const mind = await connectToMind(core, note.id);
    writeMind(mind, [paragraph("one", sentence)]);
    await mind.settled();
    const flows: string[] = [];
    const answerConsent = (allow: boolean) =>
      core.on("consent.requested", (asked) => {
        flows.push(asked.flow.id);
        void core.respondToConsent(asked.requestId, allow);
      });
    const check = async () => {
      const result = await core.checkSentences({
        requestId: `check-${randomUUID()}`,
        mindId: note.id,
        action: "check-against-documents",
        from: { blockId: "one", offset: 0 },
        to: { blockId: "one", offset: sentence.length },
        allDocuments: true,
      });
      await mind.settled();
      return result;
    };
    const requests = () => calls.filter(isCheckRun);
    const sent = () =>
      requests()
        .flatMap((call) => [call.prompt, ...call.results.map((each) => each.text)])
        .join("\n");
    const state = () => claimSpans(readMind(mind))[0]?.check.state ?? "no mark";
    return { core, service, models, flows, answerConsent, check, requests, sent, state };
  }

  const cloud = (core: Core) =>
    core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });

  // protects=a check that may show the Library's facts goes through the checks flow's consent for the chosen model, as every check does: choosing the model allows it, and once the User stops it the check asks again and sends nothing when declined; fails_when=the facts go out while checks are stopped for that service.
  test("goes through the checks flow's consent for the chosen model, and sends nothing when it is declined", async () => {
    const chosen = await library(cloud);
    chosen.answerConsent(true);
    await chosen.check();
    expect(chosen.flows).toEqual([]);
    expect(chosen.sent()).toContain("Library facts of your Library");
    expect(chosen.state()).toBe("supported");

    const declined = await library(cloud);
    if (!declined.service) throw new Error("The cloud model has no service.");
    await declined.core.revokeConsent("checks", declined.service);
    declined.answerConsent(false);
    await declined.check();
    expect(declined.flows).toEqual(["checks"]);
    expect(declined.requests()).toHaveLength(0);
    expect(declined.state()).not.toBe("supported");

    const allowed = await library(cloud);
    if (!allowed.service) throw new Error("The cloud model has no service.");
    await allowed.core.revokeConsent("checks", allowed.service);
    allowed.answerConsent(true);
    await allowed.check();
    expect(allowed.flows).toEqual(["checks"]);
    expect(allowed.sent()).toContain("Library facts of your Library");
    expect(allowed.state()).toBe("supported");
  });

  // protects=a User who allowed checks before they could send the Library's counts and names is asked again, for those two alone, before any is sent; fails_when=the facts go out on the earlier consent.
  test("a User who allowed checks before is asked again, for the Library's counts and names", async () => {
    const before = await library(async (core) => {
      const checks = core.dataFlows.get("checks");
      if (!checks) throw new Error("The checks flow isn't registered.");
      const earlier = checks.sends.filter((kind) => !WIDENED.includes(kind));
      core.dataFlows.register({ ...checks, sends: earlier });
      const chosen = await cloud(core);
      core.dataFlows.register(checks);
      return chosen;
    });
    const asked: string[][] = [];
    before.core.on("consent.requested", (request) => {
      asked.push([...request.newKinds]);
      void before.core.respondToConsent(request.requestId, false);
    });
    await before.check();
    expect(asked).toEqual([[...WIDENED]]);
    expect(before.requests()).toHaveLength(0);
  });

  // protects=the facts go only to the model chosen for the check, never to another saved service; fails_when=a second saved provider is asked too.
  test("goes only to the chosen model, not to another saved service", async () => {
    const both = await library(async (core) => {
      const chosen = await cloud(core);
      await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "gpt-6-luna",
        keepDefault: true,
      });
      return chosen;
    });
    both.answerConsent(true);
    await both.check();
    expect(both.sent()).toContain("Library facts of your Library");
    expect(new Set(both.models.specs.map((spec) => `${spec.kind} ${spec.modelId}`))).toEqual(
      new Set(["anthropic claude-haiku-5-5"]),
    );
  });

  // protects=in Local mode a check on a cloud model sends nothing at all, facts included, while a model on this computer still gets them; fails_when=Local mode lets a Library-fact check reach the cloud.
  test("in Local mode, nothing leaves for a cloud model, and a model on this computer still checks", async () => {
    const local = await library(async (core) => {
      const chosen = await cloud(core);
      await core.setLocalOnly(true);
      return chosen;
    });
    local.answerConsent(true);
    expect(await local.check()).toMatchObject({ kind: "local-mode" });
    expect(local.requests()).toHaveLength(0);
    expect(local.flows).toEqual([]);

    const onThisComputer = await library(async (core) => {
      const chosen = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await core.setLocalOnly(true);
      return chosen;
    });
    await onThisComputer.check();
    expect(onThisComputer.sent()).toContain("Library facts of your Library");
    expect(new Set(onThisComputer.models.specs.map((spec) => spec.kind))).toEqual(
      new Set(["ollama"]),
    );
    expect(onThisComputer.state()).toBe("supported");
  });
});

describe("the words for what a check sends", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  // protects=the consent line and the re-ask name every row of what a check sends, in the words given for them; fails_when=the line says less than the request carries.
  test("the consent line and the data kinds, in English and Chinese", () => {
    expect(translate("en", "providers.sends.checks")).toBe(
      "each sentence you check, with its paragraph and figures, and the passages it’s checked against with their Document names, pages or locations and which of a workbook’s rows hold values its formulas worked out; every sentence of a note or file you check whole, to find its claims; whole Documents in the scope, up to 40 pages, for a sentence that says something is absent; a file’s name, dates, author, page count and size, for a sentence about the file; the heading above a sentence the assistant wrote; after a new version of a Document, the cited sentences of the notes in its Folder; and for a sentence about your Library, its counts, the name of the Folder, Tag or Document the note searches with how many more items its search has, and the names, kinds and counts of the Documents, Folders and Tags, and the names of notes, that match the sentence’s words, with how many more matched",
    );
    expect(translate("zh-CN", "providers.sends.checks")).toBe(
      "你核对的每一句话及其所在段落和数字，以及用于核对的段落、其文档名称、页码或位置和工作簿中哪些行的数值由公式算出；整篇核对笔记或文件时，其中每一句话（用于找出说法）；句子说某处没有某内容时，范围内的整份文档（最多 40 页）；句子说的是文件本身时，文件的名称、日期、作者、页数和大小；助手所写句子上方的标题；文档有新版本后，所在文件夹中笔记里带引用的句子；句子说的是你的资料库时，资料库的数量、笔记搜索的文件夹、标签或文档名称及其搜索范围中其余项目的数量，以及与句中词语相符的文档、文件夹和标签的名称、类型和数量、笔记的名称，和其余相符名称的数量",
    );
    const kinds = {
      "library-counts": [
        "For a sentence about your Library: how many Documents in all, not in a Folder and of each kind, how many Folders, Tags and other notes, how many names are shared by several Documents, and how many more items the note’s search has",
        "句子说的是你的资料库时：文档总数、不在文件夹中的文档数和各类型文档数，文件夹、标签和其他笔记的数量，由多个文档共用的名称数量，以及笔记搜索范围中其余项目的数量",
      ],
      "library-names": [
        "For a sentence about your Library: the name of the Folder, Tag or Document the note searches, and the names of Documents, Folders, Tags and notes that match the sentence’s words, with each one’s kind and count and how many more matched",
        "句子说的是你的资料库时：笔记搜索的文件夹、标签或文档名称，以及与句中词语相符的文档、文件夹、标签和笔记的名称，连同各自的类型和数量，以及其余相符名称的数量",
      ],
      "file-properties": [
        "A file’s name, its own dates (or this computer’s when it has none), author, page, slide or sheet count and size, for a sentence about the file",
        "句子说的是文件本身时，文件的名称、文件自身的日期（没有时用这台电脑记录的日期）、作者、页数（或幻灯片数、工作表数）和大小",
      ],
      "absence-documents": [
        "Whole Documents in the scope, up to 40 pages in all, for a sentence that says something is absent",
        "句子说某处没有某内容时，范围内的整份文档（总共最多 40 页）",
      ],
      "watched-sentences": [
        "After a new version of a Document, the cited sentences of the notes in its Folder, to check them for contradictions",
        "文档有新版本后，所在文件夹中笔记里带引用的句子，用于查找矛盾",
      ],
    } as const;
    for (const [kind, [english, chinese]] of Object.entries(kinds)) {
      expect(translate("en", `consent.data.${kind}` as Parameters<typeof translate>[1])).toBe(
        english,
      );
      expect(translate("zh-CN", `consent.data.${kind}` as Parameters<typeof translate>[1])).toBe(
        chinese,
      );
    }
  });

  // protects=the privacy pages say what a check sends, in English and Chinese; fails_when=a page leaves a row out or says something is never sent that is.
  test("the privacy pages, in English and Chinese", () => {
    const privacy = read("docs/privacy.md");
    expect(privacy).toContain(
      "A sentence about a file itself sends the file's name, its own created and modified dates (or this computer's when it records none), author, page, slide or sheet count and size. A sentence about your Library sends the Library's counts (Documents in all, not in a Folder and per kind, the numbers of Folders, Tags and other notes, and how many names are shared by several Documents), the name of the Folder, Tag or Document the note searches and how many more items its search has, and the names of Documents, Folders and Tags with their kinds and counts, and the names of other notes, that share a word with the sentence, with how many more matched past 200. A Folder that keeps its work inside it is sent only as a number to a note outside it. Never sent in a check: ids, file paths, Folder or Tag descriptions, the rest of your notes' text, or which Document is in which Folder or has which Tag beyond the Folder or Tag the note searches.",
    );
    expect(privacy).toContain(
      "then each claim with its paragraph and the Passages found or read for it. The passages come from the Folder or Tag the note searches, so their Document names show which Documents are in it.",
    );
    expect(privacy).not.toContain("any note's text");
    expect(privacy).toContain(
      "When a quick model of the same service looks first at a sentence the assistant wrote, it gets the sentence, its paragraph, the heading above it and the quote with its Passage.",
    );
    expect(privacy).not.toContain("Never sent: ids, paths, sizes, dates, page counts");
    expect(read("docs/where-your-data-goes.md")).toContain(
      "; its paragraph and figures, and which of a workbook's rows hold values its formulas worked out; for a sentence about a file, its name, dates, author, page count and size; the heading above a sentence the assistant wrote; for a sentence about your Library, its counts, how many names are shared by several Documents, the name of the Folder, Tag or Document the note searches, and the matching names of Documents, Folders, Tags and notes with their kinds and counts (a Folder that keeps its work inside it only as a number), never their text, paths or descriptions",
    );
    expect(read("docs/where-your-data-goes.zh-CN.md")).toContain(
      "；句子所在段落和数字，以及工作簿中哪些行的数值由公式算出；句子说的是文件本身时，文件的名称、日期、作者、页数和大小；助手所写句子上方的标题；句子说的是你的资料库时，资料库的数量、由多个文档共用的名称数量、笔记搜索的文件夹、标签或文档名称，以及相符的文档、文件夹、标签和笔记的名称及其类型和数量（只在本文件夹内工作的文件夹只计数量），不含其内容、路径或描述",
    );
  });
});

/** A UUID, as a Note's Blocks, Documents and notes are named by. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("what a check's request never carries", () => {
  // protects=a figure goes to the model by a handle of this request, never by its id, which holds the note's Block id, a UUID; fails_when=any UUID is in any message or Tool result of the request.
  test("no id: a figure is named by a handle, its Block too", async () => {
    const sentence = "Your Library holds 3 Documents.";
    const setup = await setUp(files(3), {
      [sentence]: { verdict: "supported", quote: "Documents in all: 3", line: "documents" },
    });
    const note = await setup.core.createMind({ title: "Library overview", folderId: null });
    const mind = await connectToMind(setup.core, note.id);
    const blockId = randomUUID();
    writeMind(mind, [paragraph(blockId, sentence)]);
    await mind.settled();
    await setup.core.checkSentences({
      requestId: `check-${randomUUID()}`,
      mindId: note.id,
      action: "check-against-documents",
      from: { blockId, offset: 0 },
      to: { blockId, offset: sentence.length },
      allDocuments: true,
    });
    await mind.settled();
    expect(claimSpans(readMind(mind))[0]?.check.state).toBe("supported");
    expect(setup.calls.flatMap((call) => requestedFigures(call).map(({ id }) => id))).toContain(
      "F1",
    );
    expect(setup.sent()).not.toMatch(UUID);
  });

  // protects=a Linked folder the note searches is named by its folder's name, never its path; fails_when=the folder's path on disk reaches a request.
  test("no path: a Linked folder the note searches goes by its name", async () => {
    const sentence = "This folder holds 2 Documents.";
    const setup = await setUp([], {
      [sentence]: {
        verdict: "supported",
        quote: "Documents in all: 2",
        line: "documents",
      },
    });
    const disk = await createTempDataFolder();
    const survey = join(disk, "Field work", "Survey");
    await writeSourceFile(survey, "North wall.txt", "North wall: dry stone, two courses.");
    await writeSourceFile(survey, "Gauge.txt", "Gauge: read normal at noon.");
    await linkAndProcess(setup.core, survey);
    const root = (await setup.core.listFolders()).find((folder) => folder.relativePath === "");
    if (!root) throw new Error("The Linked folder has no Folder.");
    const scope = { folderIds: [root.id], tagIds: [], documentIds: [] };
    const { check } = await checkInNote(setup.core, sentence, null, false, scope);
    expect(check.state).toBe("supported");
    expect(setup.factsSent()).toContain("Library facts of “Survey”");
    const sent = setup.sent();
    for (const part of [disk, "Field work", join("Field work", "Survey")])
      expect(sent).not.toContain(part);
  });

  // protects=only the Folder the note searches says which Documents are in it: a Document in another Folder never goes with that Folder's name; fails_when=a sentence naming both brings the other Folder's line or its Documents.
  test("no membership elsewhere: a Document in another Folder never goes with its name", async () => {
    const sentence = "Ledger 2023 sits in the Archive Folder, beside Budgets.";
    const setup = await setUp(
      [
        { name: "Budget plan.txt", contents: "Budget plan: timber and crew." },
        { name: "Ledger 2023.txt", contents: "Ledger 2023: closing balance." },
      ],
      { [sentence]: { verdict: "unsupported", line: "description" } },
    );
    const { core } = setup;
    const budgets = await core.createLibraryGroup({ name: "Budgets", description: "" });
    const archive = await core.createLibraryGroup({ name: "Archive", description: "" });
    const plan = setup.documents.find((each) => each.name === "Budget plan");
    const ledger = setup.documents.find((each) => each.name === "Ledger 2023");
    if (!plan || !ledger) throw new Error("The test Documents are missing.");
    await core.assignDocumentGroup(plan.id, budgets.id);
    await core.assignDocumentGroup(ledger.id, archive.id);
    const scope = { folderIds: [budgets.id], tagIds: [], documentIds: [] };
    await checkInNote(core, sentence, null, false, scope);
    const facts = setup.factsSent();
    expect(facts).toContain("Library facts of “Budgets”");
    for (const elsewhere of ["Archive", "Ledger 2023"]) expect(facts).not.toContain(elsewhere);
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

describe.each(["en", "zh-CN"] as const)("only what the sentence needs (%s)", (language) => {
  const zh = language === "zh-CN";
  const three = [
    { name: "Harbour survey.txt", contents: "Harbour survey: the north wall." },
    { name: "Tide log.txt", contents: "Tide log: high water at 04:12." },
    { name: "Crew roster.txt", contents: "Crew roster: three on the early shift." },
  ];
  const single = ["Harbour survey", "Tide log", "Crew roster"];

  // protects=a sentence that names nothing is sent the counts and no name at all; fails_when=the Document names go with "You have 3 Documents".
  test("a sentence that names nothing sends counts only", async () => {
    const sentence = zh ? "你的资料库里有 3 个文档。" : "Your Library holds 3 Documents.";
    const setup = await setUp(
      three,
      { [sentence]: { verdict: "supported", quote: "Documents in all: 3", line: "documents" } },
      language,
    );
    expect((await checkInNote(setup.core, sentence)).check.state).toBe("supported");
    const facts = setup.factsSent();
    expect(facts).toContain("Documents in all: 3");
    expect(facts).not.toContain("Documents named");
    for (const name of single) expect(facts).not.toContain(name);
  });

  // protects=a sentence naming one Document is sent that name and no other; fails_when=naming one Document sends the whole list.
  test("a sentence naming one Document sends that name and no other", async () => {
    const sentence = zh
      ? "Harbour survey 是你的文档之一。"
      : "Harbour survey is one of your Documents.";
    const setup = await setUp(
      three,
      {
        [sentence]: {
          verdict: "supported",
          quote: "Documents named “Harbour survey”: 1",
          line: "name",
        },
      },
      language,
    );
    expect((await checkInNote(setup.core, sentence)).check.state).toBe("supported");
    const facts = setup.factsSent();
    expect(facts).toContain("Documents named “Harbour survey”: 1 (Plain text)");
    for (const name of ["Tide log", "Crew roster"]) expect(facts).not.toContain(name);
  });

  // protects=a sentence about duplicates is sent the count of shared names and only the names it names: "report.pdf appears twice" sends its own name's line, "Some of your Documents appear twice." none; fails_when=a duplicate phrase sends every shared name though the sentence names none of them.
  test("a duplicate sentence sends the shared-names count and only the names it names", async () => {
    const shared = [
      { name: "report.txt", contents: "The report, first draft." },
      { name: "report.md", contents: "# Report\n\nThe second draft." },
      { name: "Marlow budget.txt", contents: "Marlow budget: crew and timber." },
      { name: "Marlow budget.md", contents: "# Marlow budget\n\nThe second draft." },
      { name: "Tide log.txt", contents: "Tide log: high water at 04:12." },
    ];
    const named = zh
      ? "report.pdf 在你的文件列表中出现了两次。"
      : "report.pdf appears twice in your file list.";
    const naming = await setUp(
      shared,
      { [named]: { verdict: "supported", quote: "Documents named “report”: 2", line: "name" } },
      language,
    );
    expect((await checkInNote(naming.core, named)).check.state).toBe("supported");
    expect(naming.factsSent()).toContain("Documents named “report”: 2 (");
    expect(naming.factsSent()).toContain("Names more than one Document shares: 2");
    for (const other of ["Marlow budget", "Tide log"])
      expect(naming.factsSent()).not.toContain(other);

    const unnamed = zh ? "有些文档出现了两次。" : "Some of your Documents appear twice.";
    const counting = await setUp(
      shared,
      {
        [unnamed]: {
          verdict: "supported",
          quote: "Names more than one Document shares: 2",
          line: "shared",
        },
      },
      language,
    );
    expect((await checkInNote(counting.core, unnamed)).check.state).toBe("supported");
    expect(counting.factsSent()).toContain("Names more than one Document shares: 2");
    expect(counting.factsSent()).not.toContain("Documents named");
  });

  // protects=a "this folder" sentence is checked against the count of the Folder the note searches, which keeps its name; fails_when="this folder has 2 Documents" names no Folder and finds nothing to rest on.
  test("a this-folder sentence is checked against its own Folder's count", async () => {
    const sentence = zh ? "这个文件夹里有 2 个文档。" : "This folder has 2 Documents.";
    const setup = await setUp(
      three,
      { [sentence]: { verdict: "supported", quote: "Documents in all: 2", line: "documents" } },
      language,
    );
    const research = await setup.core.createLibraryGroup({ name: "Research", description: "" });
    const archive = await setup.core.createLibraryGroup({ name: "Archive", description: "" });
    const [survey, log, roster] = setup.documents;
    if (!survey || !log || !roster) throw new Error("The test Documents are missing.");
    await setup.core.assignDocumentGroup(survey.id, research.id);
    await setup.core.assignDocumentGroup(log.id, research.id);
    await setup.core.assignDocumentGroup(roster.id, archive.id);
    const { check } = await checkInNote(setup.core, sentence, research.id);
    expect(check.state).toBe("supported");
    expect(rowOf(check, language)).toBe(zh ? "“Research”：2 个文档" : "“Research”: 2 Documents");
    const facts = setup.factsSent();
    expect(facts).toContain("Library facts of “Research”");
    expect(facts).not.toContain("Archive");
  });

  // protects=a Folder outside the note's scope whose name shares no word with the sentence is counted, never named; fails_when=every Folder's name goes with a count sentence.
  test("a Folder outside the scope with no matching word is not named", async () => {
    const sentence = zh ? "你的资料库里有 3 个文档。" : "Your Library holds 3 Documents.";
    const setup = await setUp(
      three,
      { [sentence]: { verdict: "supported", quote: "Documents in all: 3", line: "documents" } },
      language,
    );
    const research = await setup.core.createLibraryGroup({ name: "Research", description: "" });
    const [survey] = setup.documents;
    if (!survey) throw new Error("The test Document is missing.");
    await setup.core.assignDocumentGroup(survey.id, research.id);
    expect((await checkInNote(setup.core, sentence)).check.state).toBe("supported");
    const facts = setup.factsSent();
    expect(facts).toContain("Folders: 1");
    expect(facts).not.toContain("Research");
  });

  // protects=an untitled note's first line is never sent as its title, so a client's name in it never leaves: it is counted only; fails_when=a sentence naming that line sends the note's own words.
  test("an untitled note is counted, never named by its first line", async () => {
    const sentence = zh
      ? "你有关于 Brightwater Holdings 的笔记。"
      : "You have a note about Brightwater Holdings.";
    const setup = await setUp(
      three,
      { [sentence]: { verdict: "unsupported", line: "note" } },
      language,
    );
    const untitled = await setup.core.createMind({ title: "", folderId: null });
    const client = await connectToMind(setup.core, untitled.id);
    writeMind(client, [paragraph("first", "Brightwater Holdings retainer, signed in March")]);
    await client.settled();
    const named = (await setup.core.listMinds()).find((each) => each.id === untitled.id);
    expect(named?.autoTitle).toBe("Brightwater Holdings retainer, signed in March");
    await checkInNote(setup.core, sentence);
    expect(setup.factsSent()).toContain("Notes besides this one: 1");
    const results = setup.calls.flatMap((call) => call.results.map((each) => each.text)).join("\n");
    for (const words of ["Brightwater", "retainer", "signed in March"])
      expect(results).not.toContain(words);
  });

  // protects=inside a walled Folder the note's own Folder has its count line, so "this Folder holds 3 Documents" rests on it; fails_when=the facts say "Folders: 0" and the true sentence reads Unsupported.
  test("inside a walled Folder, its own count decides a this-Folder sentence", async () => {
    const sentence = zh ? "这个文件夹里有 3 个文档。" : "This Folder holds 3 Documents.";
    const quote = "Documents in the Folder “Client A” and the Folders inside it: 3";
    const setup = await setUp(
      [...three, { name: "Osprey contract.txt", contents: "Osprey contract, signed copy." }],
      { [sentence]: { verdict: "supported", quote, line: "folder" } },
      language,
    );
    const client = await setup.core.createLibraryGroup({ name: "Client A", description: "" });
    for (const document of setup.documents.slice(0, 3))
      await setup.core.assignDocumentGroup(document.id, client.id);
    await setup.core.updateLibraryGroup(client.id, {
      name: client.name,
      description: "",
      keepInside: true,
    });
    const { check } = await checkInNote(setup.core, sentence, client.id);
    expect(check.state).toBe("supported");
    const facts = setup.factsSent();
    expect(facts).toContain(quote);
    expect(facts).toContain("Folders: 1");
    expect(facts).not.toContain("Osprey");
  });

  // protects=a Folder inside a Folder counts toward it, and the line says so; fails_when="The Field Folder holds 3 Documents, counting its subfolder." reads Unsupported.
  test("a Folder's count takes in the Folders inside it, and says so", async () => {
    const sentence = zh
      ? "Field 文件夹里有 3 个文档，包括其子文件夹。"
      : "The Field Folder holds 3 Documents, counting its subfolder.";
    const quote = "Documents in the Folder “Field” and the Folders inside it: 3";
    const setup = await setUp(
      three,
      { [sentence]: { verdict: "supported", quote, line: "folder" } },
      language,
    );
    const field = await setup.core.createLibraryGroup({ name: "Field", description: "" });
    const inner = await setup.core.createLibraryGroup({
      name: "Season two",
      description: "",
      parentId: field.id,
    });
    const [survey, log, roster] = setup.documents;
    if (!survey || !log || !roster) throw new Error("The test Documents are missing.");
    await setup.core.assignDocumentGroup(survey.id, field.id);
    await setup.core.assignDocumentGroup(log.id, inner.id);
    await setup.core.assignDocumentGroup(roster.id, inner.id);
    expect((await checkInNote(setup.core, sentence)).check.state).toBe("supported");
    expect(setup.factsSent()).toContain(quote);
  });

  // protects=a Folder, Tag or note title the sentence names is sent and the others are not; fails_when=one named Tag brings every Tag, or a named note is left out.
  test("a Folder, Tag or note named in the sentence is sent and the others are not", async () => {
    const cases = [
      {
        sentence: zh ? "“Research”文件夹里有 1 个文档。" : "The Research Folder holds 1 Document.",
        quote: "Documents in the Folder “Research” and the Folders inside it: 1",
        line: "folder",
        sent: "Documents in the Folder “Research” and the Folders inside it: 1",
      },
      {
        sentence: zh ? "有 1 个文档带有标签“Finance”。" : "1 Document is tagged Finance.",
        quote: "Documents tagged “Finance”: 1",
        line: "tag",
        sent: "Documents tagged “Finance”: 1",
      },
      {
        sentence: zh ? "你有名为“Site visit”的笔记。" : "You have a note called Site visit.",
        quote: "Note “Site visit”",
        line: "note",
        sent: "Note “Site visit”",
      },
    ];
    const others = ["Archive", "Legal", "Budget review"];
    for (const each of cases) {
      const setup = await setUp(
        three,
        { [each.sentence]: { verdict: "supported", quote: each.quote, line: each.line } },
        language,
      );
      const { core, documents } = setup;
      const [survey, log] = documents;
      if (!survey || !log) throw new Error("The test Documents are missing.");
      const research = await core.createLibraryGroup({ name: "Research", description: "" });
      const archive = await core.createLibraryGroup({ name: "Archive", description: "" });
      await core.assignDocumentGroup(survey.id, research.id);
      await core.assignDocumentGroup(log.id, archive.id);
      await core.addDocumentTag(survey.id, (await core.createTag({ name: "Finance" })).id);
      await core.addDocumentTag(log.id, (await core.createTag({ name: "Legal" })).id);
      await core.createMind({ title: "Site visit", folderId: null });
      await core.createMind({ title: "Budget review", folderId: null });
      expect((await checkInNote(core, each.sentence)).check.state).toBe("supported");
      const facts = setup.factsSent();
      expect(facts).toContain(each.sent);
      for (const other of others) expect(facts).not.toContain(other);
      const named = [each.sent.includes("Research"), each.sent.includes("Finance")];
      if (!named[0]) expect(facts).not.toContain("Research");
      if (!named[1]) expect(facts).not.toContain("Finance");
    }
  });
});

describe("the facts' text", () => {
  const listing = (
    names: readonly string[],
    searches: LibraryListing["searches"] = null,
  ): LibraryListing => ({
    source: { kind: "library" },
    documents: names.map((name) => ({ name, kind: "pdf" })),
    folders: [
      { name: "Research", count: 1 },
      { name: "Archive", count: 0 },
    ],
    unfiled: names.length - 1,
    tags: [
      { name: "Finance", count: 2 },
      { name: "Legal", count: 1 },
    ],
    notes: { count: 2, names: ["Budget review", "Site visit"] },
    searches,
  });
  const linesOf = (
    names: readonly string[],
    sentence: string,
    searches?: LibraryListing["searches"],
  ) => libraryText(listing(names, searches), sentence).text.split("\n").slice(1);
  const COUNTS = [
    "Documents in all: 3",
    "Documents not in a Folder: 2",
    "PDF Documents: 3",
    "Folders: 2",
    "Tags on these Documents: 2",
    "Notes besides this one: 2",
    "Names more than one Document shares: 1",
  ];

  // protects=a sentence that names nothing is sent the counts and no name; fails_when=Folder, Tag, note or Document names go with every check.
  test.each(["Your Library holds 3 Documents.", "你的资料库里有 3 个文档。"])(
    "names nothing, sends counts only: %s",
    (sentence) => {
      expect(linesOf(["Kestrel plan", "Kestrel plan", "Harbour"], sentence)).toEqual(COUNTS);
    },
  );

  // protects=only the names that share a word with the sentence are sent, each kind of name; fails_when=one named Folder brings every Folder's name.
  test.each([
    "The Kestrel plan is in Research, tagged Finance, beside the Site visit note.",
    "Kestrel plan 在 Research 文件夹里，带有标签 Finance，旁边是笔记 Site visit。",
  ])("sends the names the sentence names and no other: %s", (sentence) => {
    const lines = linesOf(["Kestrel plan", "Harbour"], sentence);
    for (const named of [
      "Documents in the Folder “Research” and the Folders inside it: 1",
      "Documents tagged “Finance”: 2",
      "Note “Site visit”",
      "Documents named “Kestrel plan”: 1 (PDF)",
    ])
      expect(lines).toContain(named);
    for (const other of ["Archive", "Legal", "Budget review", "Harbour"])
      expect(lines.join("\n")).not.toContain(other);
  });

  // protects=a sentence about duplicates that names none is sent the count of shared names and no name; fails_when=a duplicate phrase brings every shared name.
  test.each([
    "Two of your files share a name.",
    "Some of your Documents appear twice.",
    "你有两份同名文件。",
    "有些文档出现了两次。",
  ])("about duplicates, sends the count and no name it doesn't name: %s", (sentence) => {
    const lines = linesOf(["Kestrel plan", "Kestrel plan", "Harbour"], sentence);
    expect(lines).toContain("Names more than one Document shares: 1");
    expect(lines.join("\n")).not.toContain("Documents named");
  });

  // protects=how many names more than one Document shares goes with every sentence, so one about duplicates in any words can be decided; fails_when=the count goes only with the words a list knows, and "shared by", "share the name" or 重名 send none.
  test.each([
    "Exactly one name in your Library is shared by two Documents.",
    "Two Documents share the name of the harbour survey.",
    "有些文件重名了。",
    "你的资料库里有 3 个文档。",
  ])("sends how many names are shared, whatever the words: %s", (sentence) => {
    expect(linesOf(["Kestrel plan", "Kestrel plan", "Harbour"], sentence)).toContain(
      "Names more than one Document shares: 1",
    );
    expect(linesOf(["Kestrel plan", "Harbour"], sentence)).toContain(
      "Names more than one Document shares: 0",
    );
  });

  // protects=a Linked folder at a disk's root is named by its path, which never goes to a model; one deeper keeps its folder name; fails_when="/" or "C:\\" reaches the facts.
  test.each([
    [{ name: "/", relativePath: "" }, "a linked folder"],
    [{ name: "C:\\", relativePath: "" }, "a linked folder"],
    [{ name: "Survey", relativePath: "" }, "Survey"],
    [{ name: "2024", relativePath: "Field/2024" }, "2024"],
  ])("names a Linked folder without its path: %o", (folder, named) => {
    expect(linkedFolderName(folder)).toBe(named);
  });

  // protects=the Folder the note searches keeps its name and count though the sentence names no Folder; fails_when="this folder has 1 Document" has no Folder line to rest on.
  test.each(["This folder has 1 Document.", "这个文件夹里有 1 个文档。"])(
    "the Folder the note searches keeps its line: %s",
    (sentence) => {
      const lines = linesOf(["Harbour"], sentence, { kind: "folder", name: "Research" });
      expect(lines).toContain("Documents in the Folder “Research” and the Folders inside it: 1");
      expect(lines.join("\n")).not.toContain("Archive");
    },
  );

  // protects=a count is written as a sentence writes it, so "2,000 Documents" is the fact's own number; fails_when="Documents in all: 2000" leaves a true total Not checked.
  test("writes a large count with its thousands marked", () => {
    const names = Array.from({ length: 2000 }, (_, at) => `Ledger ${at}`);
    expect(libraryText(listing(names), "").text).toContain("Documents in all: 2,000");
  });

  // protects=a name holding a line break can't pose as another fact's line; fails_when=it splits into a "Documents in all: 99" line.
  test("a name with a line break stays on its own line", () => {
    const { text } = libraryText(listing(["Plan\nDocuments in all: 99"]), "The Plan file is here.");
    expect(text).toContain("Documents named “Plan Documents in all: 99”");
    expect(text).not.toMatch(/^Documents in all: 99$/m);
  });

  // protects=200 names is a bound even when the sentence's word matches more; fails_when=a word shared by every name sends them all.
  test("sends at most 200 names, and says how many more matched", () => {
    const names = Array.from({ length: 250 }, (_, at) => `Survey ${at}`);
    const { text } = libraryText(listing(names), "Which survey is this?");
    expect(text.split("\n").filter((line) => line.startsWith("Documents named"))).toHaveLength(200);
    expect(text).toContain("Names not listed: 50 more that share a word with the sentence.");
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
