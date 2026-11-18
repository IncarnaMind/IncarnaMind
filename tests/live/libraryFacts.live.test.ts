/**
 * Sentences about the Library itself (#2525), checked as Check this note checks them, on Claude on
 * the Anthropic key: counts, names, kinds, Folders and notes, with decoys (a wrong count, a name
 * that isn't there, a name that appears only once, a walled Folder's count from outside it, a
 * description the facts can't settle, a sentence about the note itself, and a Document's own
 * figure). Each case has a Library of its own, one scope per case, and records the evidence that
 * decided it. Runs only with the key in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY; the model
 * is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by default), and makes no request without one.
 * With INCARNAMIND_LIVE_PROVIDER=deepseek it runs on DeepSeek instead (DEEPSEEK_API_KEY;
 * INCARNAMIND_LIVE_DEEPSEEK_MODEL, "deepseek-flash" by default).
 * INCARNAMIND_LIVE_REPORT keeps what each check said, INCARNAMIND_LIVE_REPLIES each reply of the
 * model with its Tool calls, and INCARNAMIND_LIVE_CASES runs only the cases whose sentence holds
 * one of its comma-separated words. These cases are held out: none is an example
 * in the check's or the sort's instructions, or in its search Tool. The test uses only what main
 * has too, so the same cases run against main.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type AnalysisRuntime, type Core, createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readOpinionSentences } from "../../src/shared/opinions";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { docxOf, xlsxOf } from "../helpers/office";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";

const DEEPSEEK = process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek";
const KIND = DEEPSEEK ? "deepseek" : "anthropic";
const KEY = DEEPSEEK ? process.env.DEEPSEEK_API_KEY : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = DEEPSEEK
  ? (process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash")
  : (process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
    (catalogProvider("anthropic")?.roles.quickTasks as string));

/** Seven Documents, two of them sharing a name, two filed in "Research", and two other notes. */
const OPEN = [
  {
    name: "Kestrel plan.txt",
    contents: "Kestrel plan, first draft. The Kestrel plan budget is £40,000.",
  },
  {
    name: "Kestrel plan.md",
    contents: "# Kestrel plan\n\nSecond draft, with the crew rota added.\n",
  },
  { name: "Harbour survey.txt", contents: "Harbour survey: the north wall needs repointing." },
  { name: "Tide log.csv", contents: "Date,High water\n2026-10-01,04:12\n2026-10-02,04:55\n" },
  {
    name: "Budget 2026.xlsx",
    contents: xlsxOf([
      {
        name: "Budget",
        rows: [
          ["Item", "Cost"],
          ["Crew", 18000],
        ],
      },
    ]),
  },
  {
    name: "Supplier letter.docx",
    contents: docxOf([{ text: "Dear site manager, the timber arrives on 3 November." }]),
  },
  { name: "Crew roster.txt", contents: "Crew roster: Ines, Tomas and Wren on the early shift." },
];
const RESEARCH = ["Harbour survey", "Tide log"];
const NOTES = ["Site visit", "Budget review"];
/** Two more, in a Folder that keeps its work inside it. */
const WALLED = [
  { name: "Client A lease.docx", contents: docxOf([{ text: "The lease runs for five years." }]) },
  { name: "Client A brief.txt", contents: "Brief for Client A: the claim is worth £2.1m." },
];

/** Where each reply of the model is kept, with the Tool calls it made and the results it was given. */
const REPLIES = process.env.INCARNAMIND_LIVE_REPLIES;

const heard = (prompt: unknown, text: string, calls: unknown[]) => {
  if (!REPLIES || (text === "" && calls.length === 0)) return;
  const results = (Array.isArray(prompt) ? prompt : [])
    .filter((message: { role?: string }) => message.role === "tool")
    .at(-1);
  appendFileSync(REPLIES, `${JSON.stringify({ text, calls, results })}\n`);
};

const recorded: typeof createAiSdkChatModel = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        heard(
          params.prompt,
          result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          result.content.filter((part) => part.type === "tool-call"),
        );
        return result;
      },
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        let text = "";
        const calls: unknown[] = [];
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "text-delta") text += part.delta;
              if (part.type === "tool-call") calls.push(part);
              controller.enqueue(part);
            },
            flush() {
              heard(params.prompt, text, calls);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });

type Outcome = "supported" | "unsupported" | "contradicted" | "not-checked" | "left-out";

interface Case {
  sentence: string;
  /** What reads right; the first is what it should read. */
  expected: readonly Outcome[];
  /** The Library it is checked in, and where its note is. */
  library: "open" | "walled-outside" | "walled-inside";
  /** For a Supported sentence about the Library: the evidence must be the Library's own facts. */
  aboutLibrary?: true;
}

const NOT_SUPPORTED = ["contradicted", "unsupported"] as const;
/** A reading of the names, which the lists don't settle: the writer's own view, or not found. */
const UNSETTLED = ["unsupported", "not-checked"] as const;

const CASES: Record<"en" | "zh-CN", Case[]> = {
  en: [
    {
      sentence: "Your Library holds 7 Documents.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    { sentence: "Your Library holds 9 Documents.", expected: NOT_SUPPORTED, library: "open" },
    {
      sentence: "Kestrel plan shows up twice among your files.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    // Decoy: a name that appears only once.
    {
      sentence: "Harbour survey shows up twice among your files.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    // Decoy: a name that isn't there.
    {
      sentence: "One of your Documents is called Ferry timetable.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "The Research Folder contains 2 Documents.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "The Research Folder contains 4 Documents.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "Exactly one of your Documents is a Word file.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "Three of your Documents are Excel workbooks.",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "You keep 2 other notes in IncarnaMind.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    // A description the facts can't settle: a reading of the names.
    {
      sentence: "Most of the files concern harbour maintenance work.",
      expected: UNSETTLED,
      library: "open",
    },
    // About the note itself.
    {
      sentence: "The Documents are described one by one further down.",
      expected: ["left-out"],
      library: "open",
    },
    {
      sentence: "This rundown is ordered alphabetically by file name.",
      expected: ["left-out"],
      library: "open",
    },
    // A fact and words about the note: the fact is checked, the rest left out.
    {
      sentence: "You also keep 2 other notes, which appear in the next section.",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    // A Document's own figure, which no Library fact decides.
    { sentence: "The Kestrel plan budget is £40,000.", expected: ["supported"], library: "open" },
    // Decoy: the walled Folder's Documents counted from outside it.
    {
      sentence: "Your Library holds 9 Documents.",
      expected: NOT_SUPPORTED,
      library: "walled-outside",
    },
    {
      sentence: "Your Library holds 7 Documents.",
      expected: ["supported"],
      library: "walled-outside",
      aboutLibrary: true,
    },
    {
      sentence: "This Folder holds 2 Documents.",
      expected: ["supported"],
      library: "walled-inside",
      aboutLibrary: true,
    },
    {
      sentence: "This Folder holds 9 Documents.",
      expected: NOT_SUPPORTED,
      library: "walled-inside",
    },
  ],
  "zh-CN": [
    {
      sentence: "你的资料库里有 7 个文档。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    { sentence: "你的资料库里有 10 个文档。", expected: NOT_SUPPORTED, library: "open" },
    {
      sentence: "Kestrel plan 在你的文件中出现了两次。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "Harbour survey 在你的文件中出现了两次。",
      expected: NOT_SUPPORTED,
      library: "open",
    },
    {
      sentence: "“Research”文件夹里有 2 个文档。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    {
      sentence: "你另外还保存了 2 篇笔记。",
      expected: ["supported"],
      library: "open",
      aboutLibrary: true,
    },
    { sentence: "这些文件大多与港口维修有关。", expected: UNSETTLED, library: "open" },
    { sentence: "后文逐一列出了这些文档。", expected: ["left-out"], library: "open" },
    { sentence: "你的资料库里有 9 个文档。", expected: NOT_SUPPORTED, library: "walled-outside" },
    {
      sentence: "这个文件夹里有 2 个文档。",
      expected: ["supported"],
      library: "walled-inside",
      aboutLibrary: true,
    },
  ],
};

interface Checked {
  outcome: Outcome | "no mark";
  /** What decided it: each part's evidence, as its kind and words. */
  evidence: string[];
  reason: string | null;
  /** The parts the sort set aside, and whether each was about the note itself. */
  leftOut: string[];
}

/** A Library of its own for one case, with its note in the place the case names. */
async function libraryFor(
  library: Case["library"],
  language: "en" | "zh-CN",
  analysisRuntime: AnalysisRuntime,
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: recorded,
    analysisRuntime,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({ kind: KIND, apiKey: KEY ?? "", modelId: MODEL });
  await core.updateSettings({ user: { language } });
  const sources = await createTempDataFolder();
  const files = library === "open" ? OPEN : [...OPEN, ...WALLED];
  const paths = await Promise.all(
    files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  const documents = await addAndProcess(core, paths);
  const research = await core.createLibraryGroup({ name: "Research", description: "" });
  for (const document of documents.filter((each) => RESEARCH.includes(each.name)))
    await core.assignDocumentGroup(document.id, research.id);
  for (const title of NOTES) await core.createMind({ title, folderId: null });
  let folderId: string | null = null;
  if (library !== "open") {
    const client = await core.createLibraryGroup({ name: "Client A", description: "" });
    for (const document of documents.filter((each) => each.name.startsWith("Client A")))
      await core.assignDocumentGroup(document.id, client.id);
    await core.updateLibraryGroup(client.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
    if (library === "walled-inside") folderId = client.id;
  }
  return { core, folderId };
}

/** Writes `sentence` in a new note and checks the note, as Check this note does. */
async function checkedAsNote(
  core: Core,
  folderId: string | null,
  sentence: string,
): Promise<Checked> {
  const note = await core.createMind({ title: "Library overview", folderId });
  const mind = await connectToMind(core, note.id);
  writeMind(mind, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
  ]);
  await mind.settled();
  await core.checkMind({ requestId: `check-${randomUUID()}`, mindId: note.id, mode: "all" });
  await mind.settled();
  const check = claimSpans(readMind(mind))[0]?.check;
  const opinions = readOpinionSentences(mind.doc);
  const leftOut = [...(check?.parts ?? []), ...opinions.flatMap((each) => each.parts)].flatMap(
    (part) =>
      part.kind === "opinion"
        ? [
            `${sentence.slice(part.span.start, part.span.end)}${(part as { itself?: true }).itself ? " (about the note)" : " (opinion)"}`,
          ]
        : [],
  );
  const evidence = [
    check?.evidence ?? null,
    ...(check?.parts ?? []).flatMap((part) => part.evidence),
  ]
    .filter((each) => each !== null)
    .map((each) => {
      const location = each.location as { kind?: string } | null;
      return location?.kind === "library"
        ? `library ${JSON.stringify((location as { fact?: unknown }).fact)}`
        : `text of ${each.documentName}: “${each.quote}”`;
    });
  const state = check?.state;
  return {
    outcome:
      state === "supported" ||
      state === "unsupported" ||
      state === "contradicted" ||
      state === "not-checked"
        ? state
        : check === undefined && opinions.length > 0
          ? "left-out"
          : "no mark",
    evidence: [...new Set(evidence)],
    reason:
      state === "not-checked" ? (check?.reason ?? null) : (check?.unsupported?.reason ?? null),
    leftOut,
  };
}

describe.each(["en", "zh-CN"] as const)("sentences about the Library, live (%s)", (language) => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: no false Supported, each case in a Library of its own`,
    { timeout: 3_600_000 },
    async () => {
      const lines = [`## ${MODEL} · ${language}`];
      const falseSupported: string[] = [];
      let right = 0;
      const spent: unknown[] = [];
      const analysisRuntime = await pyodideAnalysisRuntime();
      const only = process.env.INCARNAMIND_LIVE_CASES?.split(",");
      const cases = CASES[language].filter(
        (each) => only?.some((word) => each.sentence.includes(word)) ?? true,
      );
      for (const each of cases) {
        const { core, folderId } = await libraryFor(each.library, language, analysisRuntime);
        const result = await checkedAsNote(core, folderId, each.sentence);
        const byLibrary = result.evidence.some((line) => line.startsWith("library "));
        const holds =
          (each.expected as readonly string[]).includes(result.outcome) &&
          (result.outcome !== "supported" || !each.aboutLibrary || byLibrary);
        if (holds) right++;
        if (
          result.outcome === "supported" &&
          (!each.expected.includes("supported") || (each.aboutLibrary && !byLibrary))
        ) {
          falseSupported.push(`${each.library}: ${each.sentence}`);
        }
        lines.push(
          `- ${holds ? "ok" : "MISS"} [${each.library} · ${each.expected.join("/")}] ${each.sentence} → ${result.outcome}${result.reason ? ` (${result.reason})` : ""}${result.evidence.length ? ` · ${result.evidence.join("; ")}` : ""}${result.leftOut.length ? ` · left out: ${result.leftOut.join("; ")}` : ""}`,
        );
        spent.push((await core.getCostSummary()).spent);
      }
      lines.push(
        `Right: ${right} of ${cases.length}. False Supported: ${falseSupported.length}.`,
        `Spent, each case: ${JSON.stringify(spent)}`,
        "",
      );
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
      }
      expect(falseSupported).toEqual([]);
    },
  );
});
