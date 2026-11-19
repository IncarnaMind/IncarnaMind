/**
 * An outside agent has a figure worked out by IncarnaMind (#3363): `calculate` over numbers it
 * quotes and `run_analysis` over a whole data file or the Library's lists, each over what it may
 * read alone, and a verdict it reports may rest on such a run. Through the shim the app ships.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import type { AnalysisJob } from "../../src/shared/analysis";
import { checkedWith, claimCheckShown } from "../../src/shared/claimChecks";
import { buildAgentShim, connectLegacyAgent, resultText, startAgentsCore } from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";

const HARBOUR = [
  "# Harbour fares",
  "",
  "The harbour took £1,250,000 in fares in spring.",
  "",
  "The harbour took £750,000 in fares in autumn.",
].join("\n");
const CROSSINGS =
  "Date,Route,Passengers\n2026-03-01,North,120\n2026-03-01,South,80\n2026-03-02,North,150";
const PAYROLL = "Name,Salary\nAda Quill,91000\nBo Rennet,87000";
const MINUTES = "# Board minutes\n\nThe merger with Larkspur stays secret until June.";

const SPRING = "The harbour took £1,250,000 in fares in spring.";
const AUTUMN = "The harbour took £750,000 in fares in autumn.";
const PASSENGERS = "The crossings carried 350 passengers.";
const FARES = "The harbour took £2,000,000 in fares in spring and autumn.";
const COUNT = "Coast holds two Documents.";
const NOTE = [PASSENGERS, FARES, COUNT].join("\n\n");

/** Words of the Documents, Folder and Note the agent may not read: none may reach it. */
const UNSHARED = ["Payroll", "Ada Quill", "91000", "Minutes", "Larkspur", "Private", "Board plans"];

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Task {
  task: string;
  how: string;
  sentences: { n: number; text: string }[];
}

interface Reported {
  marked: number;
  unconfirmed: number[];
  unreported: number[];
  next: string | null;
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

const rowsOf = (job: AnalysisJob) =>
  job.inputs.flatMap((input) => (input.kind === "table" ? input.rows : []));

/**
 * Code that reads every row it was given and prints them, as code reaching past its inputs would:
 * a run's figures are its row counts, each named by its first cell.
 */
const readsEverything = (job: AnalysisJob): FakeAnswer => ({
  output: {
    printed: JSON.stringify(job.inputs),
    results: job.inputs.map((input) => ({
      kind: "figure" as const,
      name: input.kind === "table" ? String(input.rows[0]?.[0] ?? input.name) : input.name,
      label: "",
      unit: null,
      value: input.kind === "table" ? input.rows.length : 0,
    })),
  },
});

const passengersOf = (job: AnalysisJob): FakeAnswer => ({
  output: {
    results: [
      {
        kind: "figure",
        name: "passengers",
        label: "Passengers",
        unit: null,
        value: rowsOf(job).reduce((sum, row) => sum + Number(row[2] ?? 0), 0),
      },
    ],
  },
});

/**
 * Coast (Harbour fares, Crossings) shared with Claude Code, which may write; Private (Payroll,
 * Minutes and a Note) shared with another agent only. Claude Code wrote a Note in Coast.
 */
async function paired(answer: (job: AnalysisJob) => FakeAnswer = passengersOf, python = true) {
  const runtime = createFakeAnalysisRuntime({ answer });
  const started = await startAgentsCore(
    checkingModel({}),
    python ? { analysisRuntime: runtime } : {},
  );
  const { core } = started;
  const sources = await createSourceFolder();
  const [harbour, crossings, payroll, minutes] = await addAndProcess(core, [
    await writeSourceFile(sources, "Harbour.md", HARBOUR),
    await writeSourceFile(sources, "Crossings.csv", CROSSINGS),
    await writeSourceFile(sources, "Payroll.csv", PAYROLL),
    await writeSourceFile(sources, "Minutes.md", MINUTES),
  ]);
  if (!harbour || !crossings || !payroll || !minutes) throw new Error("A Document wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
  const hidden = await core.createLibraryGroup({ name: "Private", description: "" });
  for (const each of [harbour, crossings]) await core.assignDocumentGroup(each.id, coast.id);
  for (const each of [payroll, minutes]) await core.assignDocumentGroup(each.id, hidden.id);
  await core.createMind({ title: "Board plans", folderId: hidden.id });
  await core.setAgentsEnabled(true);
  const own = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose: true,
  });
  const other = await core.connectAgent({
    name: "Codex",
    folderIds: [hidden.id, coast.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(own.launch);
  const codex = await connectLegacyAgent(other.launch);
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title: "Coast figures", markdown: NOTE },
    }),
  );
  return { ...started, core, coast, agent, codex, mindId, runtime, harbour, crossings };
}

const task = async (agent: Agent, mindId: string) =>
  structured<Task>(await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }));

const found = async (agent: Agent, query: string, document: string) => {
  const { passages } = structured<{
    passages: { passageId: string; documentId: string; document: string }[];
  }>(await agent.callTool({ name: "search", arguments: { query } }));
  const passage = passages.find((each) => each.document === document);
  if (!passage) throw new Error(`No Passage of ${document} for “${query}”.`);
  return passage;
};

const passageOf = async (agent: Agent, query: string, document: string) =>
  (await found(agent, query, document)).passageId;

const run = (agent: Agent, inputs: unknown[], code = 'result("n", 1)') =>
  agent.callTool({ name: "run_analysis", arguments: { title: "Count", inputs, code } });

const runId = (result: unknown) => {
  const { id } = structured<{ id: string | null }>(result);
  if (!id) throw new Error("Nothing ran.");
  return id;
};

async function marks(
  core: Awaited<ReturnType<typeof paired>>["core"],
  mindId: string,
  folderId: string,
) {
  const client = await connectToMind(core, mindId);
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    text: span.sentence.text,
    state: claimCheckShown(span.check, {
      footing: "not-yet-known",
      text: span.sentence.text,
      versions,
      folderId,
      scope: null,
    }).state,
    by: checkedWith(span.check)?.models.map((model) => model.modelId) ?? [],
    workedOut: span.check.parts?.[0]?.workedOut ?? null,
    working: span.check.parts?.[0]?.working?.title ?? null,
    quotes: span.check.parts?.[0]?.evidence.map((each) => each.quote) ?? [],
  }));
}

describe("an outside agent has a figure worked out by IncarnaMind (#3363)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a figure over a whole data file, and a sum of figures two Passages give, are marked as the check's own worked-out marks are, with the agent named as the judge; fails_when=the mark rests on a quote that doesn't state the figure, loses its working, or isn't Supported on a run IncarnaMind confirmed
  it("marks a verdict that rests on a run or a calculation made in this check", async () => {
    const { core, agent, mindId, coast } = await paired();
    const given = await task(agent, mindId);
    expect(given.how).toMatch(/run_analysis/);

    const crossings = await passageOf(agent, "passengers crossings", "Crossings");
    const total = runId(await run(agent, [{ name: "crossings", passageId: crossings }]));
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const { figures } = structured<{ figures: { id: string; result: string; working: string }[] }>(
      await agent.callTool({
        name: "calculate",
        arguments: {
          figures: [
            {
              label: "Fares",
              inputs: [
                { name: "spring", passageId: spring, quote: SPRING, number: "£1,250,000" },
                { name: "autumn", passageId: spring, quote: AUTUMN, number: "£750,000" },
              ],
              formula: "spring + autumn",
            },
          ],
        },
      }),
    );
    expect(figures).toMatchObject([
      { result: "£2,000,000", working: "Fares: £1,250,000 + £750,000 = £2,000,000" },
    ]);

    const reported = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            { n: 1, verdict: "supported", run: total, explanation: "The rows give 350." },
            {
              n: 2,
              verdict: "supported",
              run: figures[0]?.id,
              explanation: "The two make £2,000,000.",
            },
            { n: 3, verdict: "not found", explanation: "No Passage says." },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 3, unconfirmed: [], unreported: [] });
    expect(await marks(core, mindId, coast.id)).toEqual([
      {
        text: PASSENGERS,
        state: "supported",
        by: ["Claude Code"],
        workedOut: "Passengers = 350",
        working: "Count",
        quotes: ["Date\tRoute\tPassengers"],
      },
      {
        text: FARES,
        state: "supported",
        by: ["Claude Code"],
        workedOut: "Fares: £1,250,000 + £750,000 = £2,000,000",
        working: null,
        quotes: [SPRING, AUTUMN],
      },
      {
        text: COUNT,
        state: "unsupported",
        by: ["Claude Code"],
        workedOut: null,
        working: null,
        quotes: [],
      },
    ]);
  });

  // protects=a ✓ rests only on what IncarnaMind worked out for this agent in this check; fails_when=a made-up id, another agent's run, or one made before this check marks a sentence, or a refusal names what the run read
  it("marks nothing on a run that isn't this agent's, or isn't of this check", async () => {
    const { core, agent, codex, mindId, coast } = await paired();
    const crossings = await passageOf(agent, "passengers crossings", "Crossings");
    const before = runId(await run(agent, [{ name: "crossings", passageId: crossings }]));

    const { mindId: codexNote } = structured<{ mindId: string }>(
      await codex.callTool({
        name: "create_mind",
        arguments: { title: "Codex figures", markdown: PASSENGERS, folderId: coast.id },
      }),
    );
    await task(codex, codexNote);
    const theirs = runId(await run(codex, [{ name: "crossings", passageId: crossings }]));

    const given = await task(agent, mindId);
    const reported = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            { n: 1, verdict: "supported", run: theirs, explanation: "The rows give 350." },
            { n: 2, verdict: "supported", run: "run-0123456789", explanation: "They make 2,000." },
            { n: 3, verdict: "supported", run: before, explanation: "There are two." },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 0, unconfirmed: [1, 2, 3], unreported: [] });
    expect(await marks(core, mindId, coast.id)).toEqual([]);
    expect((await task(agent, mindId)).sentences).toHaveLength(3);
  });

  // protects=the User's rule that an agent reads only its Folders holds for code: no row, name, count or error of a Document, Folder or Note outside them reaches it; fails_when=a run reads a Passage outside its Folders, the Library's lists hold a row of anything else, or a refusal tells an unknown Passage from one outside its reach
  it("runs only over what the agent may read, and says nothing of the rest", async () => {
    const { agent, codex, runtime } = await paired(readsEverything);
    const { passageId: payroll, documentId: payrollFile } = await found(codex, "salary", "Payroll");
    const minutes = await passageOf(codex, "merger", "Minutes");

    const said: string[] = [];
    for (const passageId of [payroll, minutes, "a-passage-that-is-nowhere", payrollFile]) {
      const outside = await run(agent, [{ name: "rows", passageId }]);
      said.push(resultText(outside).replaceAll(passageId, "…"));
      const figured = await agent.callTool({
        name: "calculate",
        arguments: {
          figures: [
            {
              label: "Pay",
              inputs: [{ name: "a", passageId, quote: "91000", number: "91000" }],
              formula: "a",
            },
          ],
        },
      });
      said.push(resultText(figured).replaceAll(passageId, "…"));
    }
    // An unknown Passage, one outside its Folders and a Document's id are refused in the same words.
    expect(said[0]).toBe(said[4]);
    expect(said[1]).toBe(said[5]);
    expect(said[6]).toBe(said[4]);
    expect(said[7]).toBe(said[5]);
    // So are another agent's Citation and a made-up one.
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await codex.callTool({
        name: "cite",
        arguments: { citations: [{ passageId: payroll, quote: "Ada Quill" }] },
      }),
    );
    const theirs = citations[0]?.cite ?? "";
    expect(theirs).toMatch(/^\[cite:/);
    const byCite = async (cite: string) =>
      resultText(
        await agent.callTool({
          name: "calculate",
          arguments: {
            figures: [
              { label: "Pay", inputs: [{ name: "a", cite, number: "91000" }], formula: "a" },
            ],
          },
        }),
      ).replaceAll(cite, "…");
    said.push(await byCite(theirs));
    expect(said.at(-1)).toBe(await byCite("[cite:zzzzzzzz]"));
    expect(runtime.jobs).toHaveLength(0);

    const listed = await run(
      agent,
      [
        { name: "files", library: "documents" },
        { name: "folders", library: "folders" },
        { name: "notes", library: "notes" },
      ],
      'print(inputs)\nresult(files["name"][0], len(files))',
    );
    said.push(resultText(listed));
    const [job] = runtime.jobs;
    expect(job?.inputs.map((input) => (input.kind === "table" ? input.rows.length : 0))).toEqual([
      2, 1, 1,
    ]);
    expect(
      rowsOf(job ?? { language: "python", code: "", inputs: [] })
        .flat()
        .join(" "),
    ).not.toMatch(new RegExp(UNSHARED.join("|")));
    // Only numbers come back from the lists: not what the code printed, nor a name from a row.
    expect(resultText(listed)).toMatch(/result 1: 2/);

    for (const text of said) expect(text).not.toMatch(new RegExp(UNSHARED.join("|")));
  });

  // protects=a ✓ never rests on the User's own working file, through a run as through a quote, though the agent may compute over it; fails_when=a run or a calculation over a Document kept as the User's own workings, before or after it ran, marks a sentence Supported
  it("marks no verdict that rests on the User's own working file", async () => {
    const { core, agent, mindId, coast, harbour, crossings } = await paired();
    // Something else in Coast to check against, once both of these are the User's own workings.
    const [tides] = await addAndProcess(core, [
      await writeSourceFile(
        await createSourceFolder(),
        "Tides.md",
        "# Tides\n\nSpring tides come twice a month.",
      ),
    ]);
    if (!tides) throw new Error("Tides wasn't added.");
    await core.assignDocumentGroup(tides.id, coast.id);
    await core.setNotCited(crossings.id, true);
    const given = await task(agent, mindId);

    const total = structured<{ id: string; report: string }>(
      await run(agent, [
        {
          name: "crossings",
          passageId: await passageOf(agent, "passengers crossings", "Crossings"),
        },
      ]),
    );
    expect(total.report).toMatch(/Passengers: 350/);
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const { figures } = structured<{ figures: { id: string; result: string }[] }>(
      await agent.callTool({
        name: "calculate",
        arguments: {
          figures: [
            {
              label: "Fares",
              inputs: [
                { name: "spring", passageId: spring, quote: SPRING, number: "£1,250,000" },
                { name: "autumn", passageId: spring, quote: AUTUMN, number: "£750,000" },
              ],
              formula: "spring + autumn",
            },
          ],
        },
      }),
    );
    expect(figures).toMatchObject([{ result: "£2,000,000" }]);
    await core.setNotCited(harbour.id, true);

    const reported = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            { n: 1, verdict: "supported", run: total.id, explanation: "The rows give 350." },
            {
              n: 2,
              verdict: "contradicted",
              run: figures[0]?.id,
              explanation: "They make £2,000,000.",
            },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ unconfirmed: [1, 2], unreported: [3] });
    expect(reported.next).toMatch(/own working file/);
    const states = (await marks(core, mindId, coast.id)).map((each) => each.state);
    expect(states).not.toContain("supported");
    expect(states).not.toContain("contradicted");
  });

  // protects=on a computer that can't run Python for IncarnaMind, the agent is told so plainly and can still calculate; fails_when=run_analysis fails without saying why, or calculate needs Python
  it("says plainly when this computer can't run code", async () => {
    const { agent } = await paired(passengersOf, false);
    const refused = await run(agent, [{ name: "files", library: "documents" }]);
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/can’t run code for IncarnaMind/);
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const { figures } = structured<{ figures: { result: string }[] }>(
      await agent.callTool({
        name: "calculate",
        arguments: {
          figures: [
            {
              label: "Twice spring",
              inputs: [{ name: "s", passageId: spring, quote: SPRING, number: "£1,250,000" }],
              formula: "s + s",
            },
          ],
        },
      }),
    );
    expect(figures).toMatchObject([{ result: "£2,500,000" }]);
  });
});
