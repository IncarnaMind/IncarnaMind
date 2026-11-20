/**
 * Files an outside agent hands over (#3412), through the shim the app ships with the MCP SDK's own
 * client, as Claude Code calls it: the agent names a deck or workbook it made by its path, and
 * IncarnaMind reads that file alone, keeps it with each version and checks it as "Check someone
 * else's file" does, slide by slide or sheet by sheet; the agent reads back what needs a look, where
 * it is in the file, and a request the User sends it names the file, the slide and what to do.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { verificationOf } from "../../src/shared/verification";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { WorkbookBuilder } from "../helpers/financeWorkbooks";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";
import { plainDeck } from "../helpers/pptx";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Handed {
  fileId: string;
  title: string;
  folder: string;
  version: number;
  mindId: string | null;
  status: "checked" | "running" | "not-checked";
  why: string | null;
  supported: number;
  needLook: number;
  claims: { where: string | null; text: string; result: string; says: string | null }[];
  formulas: {
    workedOut: number;
    notWorkedOut: number;
    differ: { cell: string; saved: string; worked: string }[];
  } | null;
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

const SURVEY = [
  "# Harbour survey",
  "",
  "The north quay holds 42 boats and the south quay holds 19 boats.",
  "",
  "The harbour office is open every day of the year.",
].join("\n");

const NORTH = "The north quay holds 42 boats.";
const SOUTH = "The south quay holds 17 boats.";
const OFFICE = "The harbour office is open every day of the year.";
const NEVER_CLOSES = "The harbour office never closes, night or day.";

const PLANS: Record<string, Plan> = {
  [NORTH]: {
    verdict: "supported",
    quote: "The north quay holds 42 boats",
    says: "Harbour survey says the north quay holds 42 boats.",
  },
  [SOUTH]: {
    verdict: "contradicted",
    quote: "the south quay holds 19 boats",
    says: "Harbour survey says the south quay holds 19 boats, not 17.",
  },
  [OFFICE]: {
    verdict: "supported",
    quote: "The harbour office is open every day of the year.",
    says: "Harbour survey says the office is open every day.",
  },
  [NEVER_CLOSES]: {
    verdict: "overstated",
    quote: "The harbour office is open every day of the year.",
    says: "Harbour survey says the office is open every day, not at night.",
  },
  "Rent — 2026: 14000": {
    verdict: "supported",
    quote: "Rent for 2026 is 14000.",
    says: "Harbour budget notes give rent for 2026 as 14000.",
  },
  "Moorings — 2026: 2500": {
    verdict: "contradicted",
    quote: "Moorings for 2026 cost 2200.",
    says: "Harbour budget notes give moorings for 2026 as 2200, not 2500.",
  },
};

/** A deck the agent made: its claims on slide 2, the office on slide 3. */
const DECK = plainDeck([
  { title: "Harbour review" },
  { lines: [NORTH, SOUTH] },
  { lines: [OFFICE, NEVER_CLOSES] },
]);

/** "Claude Code" may write in Coast; the Coast has the harbour survey. */
async function started(calls: ModelCall[] = []) {
  const kept = await createTempDataFolder();
  const started = await startAgentsCore(checkingModel(PLANS, calls), {
    canvasFiles: createCanvasFiles(join(kept, "Canvases")),
  });
  const { core } = started;
  const sources = await createSourceFolder();
  const added = await addAndProcess(core, [
    await writeSourceFile(sources, "Harbour survey.md", SURVEY),
    await writeSourceFile(
      sources,
      "Harbour budget notes.md",
      "# Harbour budget notes\n\nRent for 2026 is 14000.\n\nMoorings for 2026 cost 2200.\n",
    ),
  ]);
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  for (const document of added) await core.assignDocumentGroup(document.id, coast.id);
  await core.setAgentsEnabled(true);
  const writer = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose: true,
  });
  const reader = await core.connectAgent({ name: "Codex", folderIds: [coast.id] });
  const files = await createSourceFolder();
  return { core, coast, writer, reader, files, added };
}

const handOver = (agent: Agent, args: Record<string, unknown>) =>
  agent.callTool({ name: "hand_over_file", arguments: args });

describe("files an outside agent hands over", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a deck the agent made is read from the path it named, kept, and checked slide by slide, the agent told what needs a look and on which slide; the same file again tells how the check went, and a changed one is the next version with its own check, which alone has a row in the lists (#3412); fails_when=the file isn't checked, a claim loses its slide, the same bytes make a new version, a new version replaces the old one's check, or every version's check sits in the Notes list
  it("keeps a deck it made with each version, and checks each, saying what needs a look and on which slide", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(first).toMatchObject({
      title: "Harbour review",
      folder: "Coast",
      version: 1,
      status: "checked",
      why: null,
      supported: 2,
      needLook: 2,
      claims: [
        {
          where: "slide 2",
          text: SOUTH,
          result: "contradicted",
          says: "Harbour survey says the south quay holds 19 boats, not 17.",
        },
        {
          where: "slide 3",
          text: NEVER_CLOSES,
          result: "overstated",
          says: "Harbour survey says the office is open every day, not at night.",
        },
      ],
      formulas: null,
    });
    const firstMind = first.mindId;
    if (!firstMind) throw new Error("No Note was made of the deck.");

    // The same bytes again: the same version, and how its check went.
    const again = structured<Handed>(await handOver(agent, { path }));
    expect(again).toMatchObject({ fileId: first.fileId, version: 1, mindId: firstMind });

    // A changed file is the next version, with a check of its own; the first stays.
    await writeFile(
      path,
      plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }, { lines: [OFFICE] }]),
    );
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second).toMatchObject({ fileId: first.fileId, version: 2, needLook: 0 });
    expect(second.mindId).not.toBe(firstMind);
    const handed = await core.handedFileOf(second.mindId ?? "");
    expect(handed).toMatchObject({
      file: { title: "Harbour review", kind: "pptx", agent: "Claude Code", version: 2 },
      version: 2,
    });
    expect(handed?.versions.map((each) => [each.number, each.mindId])).toEqual([
      [1, firstMind],
      [2, second.mindId],
    ]);
    expect((await core.handedFileOf(firstMind))?.version).toBe(1);
    // One Note stands for the file in the lists, the newest version's check, named for the file;
    // the first version's, which its card opens, says its version and has no row of its own.
    const notes = (await core.listMinds()).filter((mind) =>
      [firstMind, second.mindId].includes(mind.id),
    );
    expect(notes.map((mind) => [mind.title, mind.supersededBy])).toEqual(
      expect.arrayContaining([
        ["Checking: Harbour review", undefined],
        ["Checking version 1: Harbour review", second.mindId],
      ]),
    );
    // The agent's list_minds lists the same one Note: the first version's check isn't shown it.
    const listed = JSON.stringify(
      structured<unknown>(await agent.callTool({ name: "list_minds", arguments: {} })),
    );
    expect(listed).toContain(second.mindId ?? "");
    expect(listed).not.toContain(firstMind);
    // One Document holds the item's newest version, filed where the agent handed it over.
    const documents = (await core.listDocuments()).filter((each) => each.name === "Harbour review");
    expect(documents).toHaveLength(1);
    expect(documents[0]?.contentHash).toBe(handed?.versions[1]?.contentHash);
  });

  // protects=a file handed over while no AI model is set up says so, and is checked once the User sets one up and the agent hands the same file over again (#3412); fails_when=the agent is told nothing it can act on, or the same bytes never get their check
  it("says a file wasn't checked while no model is set up, and checks it when the same file is handed over again after", async () => {
    const { core, coast, writer, files } = await started();
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const unchecked = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(unchecked).toMatchObject({
      version: 1,
      status: "not-checked",
      why: "No AI model is set up in IncarnaMind for checks, so it wasn’t checked. The User can check it from its note.",
      claims: [],
    });

    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const checked = structured<Handed>(await handOver(agent, { path }));
    expect(checked).toMatchObject({
      version: 1,
      mindId: unchecked.mindId,
      status: "checked",
      why: null,
      needLook: 2,
    });
  });

  // protects=a new version keeps the result of each line the version before had too while it still stands, checks only what changed or what its Documents changed under, says how many it kept, and checks every claim again when the User asks (#3412); fails_when=an unchanged line is sent to the model again, a line whose Document changed keeps a stale result, or the count isn't recorded
  it("keeps the results of unchanged lines in the next version, checks the rest, and checks every claim again when asked", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer, files, added } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const checkedNow = () => calls.filter(isCheckRun).map(sentenceOf);
    const before = checkedNow().length;

    await writeFile(
      path,
      plainDeck([{ title: "Harbour review" }, { lines: [NORTH, SOUTH] }, { lines: [OFFICE] }]),
    );
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second).toMatchObject({ version: 2, status: "checked", supported: 2, needLook: 1 });
    // Every line stood as it was: none was sent to the model again.
    expect(checkedNow().slice(before)).toEqual([]);
    const client = await connectToMind(core, second.mindId ?? "");
    await client.settled();
    expect(verificationOf(client.doc)?.kept).toBe(3);

    // A line whose Document changed is checked again, though its words didn't.
    const survey = added.find((each) => each.name === "Harbour survey");
    if (!survey) throw new Error("No survey.");
    await core.deleteDocuments([survey.id]);
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const third = structured<Handed>(await handOver(agent, { path }));
    expect(third).toMatchObject({ version: 3, status: "checked" });
    expect(checkedNow()).toContain(NORTH);

    // Check every claim again: nothing kept.
    const atAll = checkedNow().length;
    const again = await core.verifyClaims({
      requestId: crypto.randomUUID(),
      mindId: second.mindId ?? "",
    });
    expect(again).toMatchObject({ kind: "checked", claims: 3 });
    expect(new Set(checkedNow().slice(atAll))).toEqual(new Set([NORTH, OFFICE, SOUTH]));
    await client.settled();
    expect(verificationOf(client.doc)?.kept).toBeUndefined();
  });

  // protects=a workbook an agent made is checked whole in one hand-over: each sheet's typed-in numbers traced and every formula worked out, though the file saved no results (#3412); fails_when=only a sheet is read, or formulas with no saved result are left unchecked
  it("checks a workbook it made whole: each sheet's rows, and every formula worked out", async () => {
    const { coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const book = new WorkbookBuilder();
    book
      .sheet("Inputs")
      .text("A1", "Item")
      .text("B1", "2026")
      .text("A2", "Rent")
      .number("B2", 14000)
      .text("A3", "Moorings")
      .number("B3", 2500);
    book.sheet("Model").text("A1", "Total").formula("B1", "Inputs!B2+Inputs!B3", null);
    const path = join(files, "Harbour budget.xlsx");
    await writeFile(path, book.xlsx({ withoutResults: true }));

    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(handed).toMatchObject({
      version: 1,
      status: "checked",
      supported: 1,
      claims: [
        expect.objectContaining({
          where: "sheet “Inputs”",
          text: "Moorings | 2500",
          result: "contradicted",
        }),
      ],
      formulas: { workedOut: 1, notWorkedOut: 0, differ: [] },
    });
  });

  // protects=IncarnaMind reads only the file the agent named, a regular file of a kind it checks, and only for an agent the User let write (#3412); fails_when=a folder, a link, another kind of file or a read-only agent's call is taken
  it("reads only a deck, workbook, Word file or PDF at the path named, never through a link, and only for an agent that may write", async () => {
    const { writer, reader, files, coast } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deck = join(files, "Harbour review.pptx");
    await writeFile(deck, DECK);
    await mkdir(join(files, "Folder.pptx"));
    await symlink(deck, join(files, "Linked.pptx"));
    await writeFile(join(files, "Notes.txt"), "Some notes.");

    expect(refusal(await handOver(agent, { path: join(files, "Notes.txt") }))).toBe(
      "IncarnaMind takes a deck (.pptx), a workbook (.xlsx), a Word file (.docx) or a PDF.",
    );
    for (const path of [join(files, "Folder.pptx"), join(files, "Linked.pptx"), "Harbour.pptx"]) {
      expect(refusal(await handOver(agent, { path, folderId: coast.id }))).toBe(
        "IncarnaMind reads only the file at the path you named, and couldn’t read one there: give the full path of the file itself, not of a folder or a link.",
      );
    }
    const readOnly = await connectLegacyAgent(reader.launch);
    expect(refusal(await handOver(readOnly, { path: deck }))).toMatch(/propose|change|write/i);
  });

  // protects=Ask your AI on a handed-over file's check asks the agent to fix it in the file and hand it over again, naming the file, its version, where it was handed over from and the slide (#3412); fails_when=the request speaks of a note to edit, or loses the slide
  it("asks the agent to fix what the check flagged in the file, on its slide, and hand it over again", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const mindId = handed.mindId ?? "";
    const client = await connectToMind(core, mindId);
    await client.settled();
    const flagged = claimSpans(readMind(client)).find((span) => span.sentence.text === SOUTH);
    if (!flagged) throw new Error("The flagged claim has no mark.");

    await core.askAgent({
      pairingId: writer.pairing.id,
      mindId,
      ask: {
        kind: "fix",
        sentences: [{ sentence: SOUTH, verdict: "contradicted", checkId: flagged.check.id }],
      },
    });
    const read = structured<{ request: string }>(
      await agent.callTool({ name: "read_request", arguments: {} }),
    );
    expect(read.request).toBe(
      `In IncarnaMind, the check of the file you handed over, “Harbour review” (version 1, from ${path}), says this is contradicted by my Documents:\n\nOn slide 2: “${SOUTH}”\n\nFix it in the file from my Documents, change nothing else, and hand the file over again with hand_over_file.`,
    );
  });
});
