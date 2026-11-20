/**
 * An outside agent has a figure worked out by IncarnaMind (#3363) with `run_analysis` over a whole
 * data file or the Library's lists, over what it may read alone, or works one out itself from
 * numbers Passages give and reports its working (#3393), which IncarnaMind confirms; a verdict it
 * reports may rest on either. Through the shim the app ships.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisRuntime } from "../../src/core/adapters";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import type { AnalysisJob } from "../../src/shared/analysis";
import { checkedWith, claimCheckShown } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
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
 * Figures over the Crossings rows given with figure(), which IncarnaMind works out again from the
 * cells: `wrong` gives each name a value the rows don't sum to.
 */
const summed =
  (names: Record<string, "right" | "wrong">) =>
  (job: AnalysisJob): FakeAnswer => {
    const total = rowsOf(job).reduce((sum, row) => sum + Number(row[2] ?? 0), 0);
    return {
      output: {
        results: Object.entries(names).map(([name, value]) => ({
          kind: "figure" as const,
          name,
          label: name,
          unit: null,
          value: value === "right" ? total : total + 1,
          of: { input: "crossings", columns: ["Passengers"], rows: [[2, 4]], count: 3, how: "sum" },
        })),
      },
    };
  };

/**
 * Coast (Harbour fares, Crossings) shared with Claude Code, which may write; Private (Payroll,
 * Minutes and a Note) shared with another agent only. Claude Code wrote a Note in Coast.
 */
async function paired(
  answer: (job: AnalysisJob) => FakeAnswer = passengersOf,
  python: boolean | AnalysisRuntime = true,
) {
  const runtime = createFakeAnalysisRuntime({ answer });
  const started = await startAgentsCore(
    checkingModel({}),
    python === false ? {} : { analysisRuntime: python === true ? runtime : python },
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

/** The [cite:…] tokens of quotes of one Passage, in order. */
const citesOf = async (agent: Agent, passageId: string, quotes: readonly string[]) => {
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: quotes.map((quote) => ({ passageId, quote })) },
    }),
  );
  return citations.map((each) => each.cite ?? "");
};

/** The fares working: spring and autumn, each with its Citation, and the figure it gives. */
const faresWorking = (spring: string, autumn: string, figure = "£2,000,000") => ({
  inputs: [
    { name: "spring", value: 1_250_000, cite: spring },
    { name: "autumn", value: 750_000, cite: autumn },
  ],
  expression: "spring + autumn",
  figure,
});

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
  it("marks a verdict that rests on a run made in this check, or on the agent's own working", async () => {
    const { core, agent, mindId, coast } = await paired();
    const given = await task(agent, mindId);
    expect(given.how).toMatch(/run_analysis/);
    expect(given.how).toMatch(/working/);

    const crossings = await passageOf(agent, "passengers crossings", "Crossings");
    const total = runId(await run(agent, [{ name: "crossings", passageId: crossings }]));
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const [springCite = "", autumnCite = ""] = await citesOf(agent, spring, [SPRING, AUTUMN]);

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
              working: faresWorking(springCite, autumnCite),
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
        workedOut: "1,250,000 + 750,000 = £2,000,000",
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

  // protects=a worked-out ✓ rests on numbers that stand in their quotes and an expression that gives its figure; fails_when=a working whose number isn't in its quote, or whose expression gives another figure, marks the sentence, or the agent isn't told why
  it("marks nothing on a working whose number isn't in its quote or whose figure isn't what it gives", async () => {
    const { core, agent, mindId, coast } = await paired();
    const given = await task(agent, mindId);
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const [springCite = "", autumnCite = ""] = await citesOf(agent, spring, [SPRING, AUTUMN]);
    const mistyped = faresWorking(springCite, autumnCite);
    const reported = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            {
              n: 2,
              verdict: "supported",
              working: faresWorking(springCite, autumnCite, "£2,100,000"),
              explanation: "They make £2,100,000.",
            },
            {
              n: 3,
              verdict: "supported",
              working: {
                ...mistyped,
                inputs: [{ ...mistyped.inputs[0], value: 1_520_000 }, mistyped.inputs[1]],
              },
              explanation: "They make £2,270,000.",
            },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 0, unconfirmed: [2, 3] });
    expect(reported.next).toMatch(/2: the formula gives 2,000,000/);
    expect(reported.next).toMatch(/3: spring: 1,520,000 isn't in its quote, which has 1,250,000/);
    const states = (await marks(core, mindId, coast.id)).map((each) => each.state);
    expect(states).not.toContain("supported");
    expect(states).not.toContain("contradicted");

    // The same working, its figure the one its expression gives, marks the sentence.
    const again = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            {
              n: 2,
              verdict: "supported",
              working: faresWorking(springCite, autumnCite),
              explanation: "They make £2,000,000.",
            },
          ],
        },
      }),
    );
    expect(again).toMatchObject({ marked: 1, unconfirmed: [] });
    expect(await marks(core, mindId, coast.id)).toMatchObject([
      { text: FARES, state: "supported", workedOut: "1,250,000 + 750,000 = £2,000,000" },
    ]);
  });

  // protects=a sentence whose figure its Documents' numbers contradict is marked Contradicted on the working that gives the right figure; fails_when=the right working is refused because the sentence writes another figure, or the agent is asked for the sentence's figure
  it("marks a wrong total Contradicted on the working that gives the right one", async () => {
    const { core, agent, coast } = await paired();
    const wrong = "The harbour took £2,100,000 in fares in spring and autumn.";
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Fares to check", markdown: wrong },
      }),
    );
    const given = await task(agent, mindId);
    expect(given.how).toMatch(
      /for a sentence it contradicts, that right figure, not the sentence's/,
    );
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const [springCite = "", autumnCite = ""] = await citesOf(agent, spring, [SPRING, AUTUMN]);

    const reported = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            {
              n: 1,
              verdict: "contradicted",
              working: faresWorking(springCite, autumnCite),
              explanation: "The two make £2,000,000, not £2,100,000.",
            },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 1, unconfirmed: [] });
    expect(await marks(core, mindId, coast.id)).toMatchObject([
      {
        text: wrong,
        state: "contradicted",
        workedOut: "1,250,000 + 750,000 = £2,000,000",
        quotes: [SPRING, AUTUMN],
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
    const { core, agent, codex, runtime, coast } = await paired(readsEverything);
    const { passageId: payroll, documentId: payrollFile } = await found(codex, "salary", "Payroll");
    const minutes = await passageOf(codex, "merger", "Minutes");
    const [gone] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "Old.csv", "Item,Count\nRope,3"),
    ]);
    if (!gone) throw new Error("Old.csv wasn't added.");
    await core.assignDocumentGroup(gone.id, coast.id);
    await core.deleteDocument(gone.id);

    const runs: string[] = [];
    for (const id of [payroll, minutes, "an-id-that-is-nowhere", payrollFile, gone.id]) {
      for (const field of ["passageId", "documentId"]) {
        runs.push(
          resultText(await run(agent, [{ name: "rows", [field]: id }])).replaceAll(id, "…"),
        );
      }
    }
    // One refusal, whatever the id and whichever field carried it: outside its Folders, unknown or
    // deleted, a Passage's or a Document's. It says what to give.
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toMatch(/give a documentId or a passageId of a sheet or CSV file you can read/);
    const said = [...runs];
    // So are another agent's Citation and a made-up one.
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await codex.callTool({
        name: "cite",
        arguments: { citations: [{ passageId: payroll, quote: "Ada Quill" }] },
      }),
    );
    const theirs = citations[0]?.cite ?? "";
    expect(theirs).toMatch(/^\[cite:/);
    // A working on another agent's Citation is refused as one on a made-up Citation is.
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Pay", markdown: "Pay came to 91,000." },
      }),
    );
    const byCite = async (cite: string) =>
      resultText(
        await agent.callTool({
          name: "report_check",
          arguments: {
            mindId,
            task: (await task(agent, mindId)).task,
            results: [
              {
                n: 1,
                verdict: "supported",
                working: {
                  inputs: [{ name: "a", value: 91_000, cite }],
                  expression: "a",
                  figure: "91,000",
                },
              },
            ],
          },
        }),
      ).replaceAll(cite, "…");
    said.push(await byCite(theirs));
    expect(said.at(-1)).toBe(await byCite("[cite:zzzzzzzz]"));
    expect(said.at(-1)).toMatch(/give the \[cite:…\] of a quote you can read now/);
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
    const [springCite = "", autumnCite = ""] = await citesOf(agent, spring, [SPRING, AUTUMN]);
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
              working: faresWorking(springCite, autumnCite),
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

  // protects=an agent that names a file by its Document's id, as search, read_passages and list_minds give it, has its rows run as by a Passage of it, in either field; fails_when=a Document's id is refused, or reads other rows than a Passage of the same file
  it("runs over a file named by its Document's id, in either field, as over a Passage of it", async () => {
    const { agent, runtime, crossings } = await paired();
    const passageId = await passageOf(agent, "passengers crossings", "Crossings");
    const reports: string[] = [];
    for (const input of [
      { name: "crossings", passageId },
      { name: "crossings", documentId: crossings.id },
      { name: "crossings", passageId: crossings.id },
    ]) {
      const { report } = structured<{ id: string; report: string }>(await run(agent, [input]));
      reports.push(report.replace(/^Run run-\w+\n/, ""));
    }
    expect(reports[0]).toMatch(/Passengers: 350/);
    expect(new Set(reports).size).toBe(1);
    const [first, ...others] = runtime.jobs.map((job) => JSON.stringify(job.inputs));
    expect(others).toEqual([first, first]);
  });

  // protects=a run is of the check that was going when it began: a check begun while it ran can't rest on it; fails_when=a run started before check_mind_yourself and ended after it marks a sentence
  it("marks nothing on a run that began before this check, though it ended after", async () => {
    const fake = createFakeAnalysisRuntime({ answer: passengersOf });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun = false;
    const gated: AnalysisRuntime = {
      languages: fake.languages,
      async run(job, signal) {
        begun = true;
        await held;
        return fake.run(job, signal);
      },
      close: () => fake.close(),
    };
    const { core, agent, mindId, coast } = await paired(passengersOf, gated);
    const passageId = await passageOf(agent, "passengers crossings", "Crossings");
    const going = run(agent, [{ name: "crossings", passageId }]);
    await vi.waitFor(() => expect(begun).toBe(true));
    const given = await task(agent, mindId);
    release();
    const before = runId(await going);
    const after = runId(await run(agent, [{ name: "crossings", passageId }]));

    const report = (id: string) =>
      agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [{ n: 1, verdict: "supported", run: id, explanation: "The rows give 350." }],
        },
      });
    expect(structured<Reported>(await report(before))).toMatchObject({
      marked: 0,
      unconfirmed: [1],
    });
    expect(await marks(core, mindId, coast.id)).toEqual([]);
    expect(structured<Reported>(await report(after))).toMatchObject({ marked: 1, unconfirmed: [] });
  });

  // protects=what a run worked out from a Document is given only while the agent still reaches it: one the User filed outside the agent's Folders while the run went on gives nothing back (#3458 review); fails_when=the run's report of that Document's rows is handed over with the grant as it was when the run began
  it("gives back nothing of a run whose Document the agent no longer reaches once it ends", async () => {
    const fake = createFakeAnalysisRuntime({ answer: passengersOf });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun = false;
    const gated: AnalysisRuntime = {
      languages: fake.languages,
      async run(job, signal) {
        begun = true;
        await held;
        return fake.run(job, signal);
      },
      close: () => fake.close(),
    };
    const { core, agent, crossings } = await paired(passengersOf, gated);
    const passageId = await passageOf(agent, "passengers crossings", "Crossings");
    const going = run(agent, [{ name: "crossings", passageId }]);
    await vi.waitFor(() => expect(begun).toBe(true));
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.assignDocumentGroup(crossings.id, vault.id);
    release();
    const refused = await going;
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toBe(translate("en", "agents.problem.reachChanged"));
  });

  // protects=a verdict rests only on figures the run's report lets the agent use: one IncarnaMind worked out again from the cells and found different backs nothing; fails_when=a figure that failed its recalculation backs a Supported mark or shows in the working line
  it("rests no verdict on a figure that the cells don't give", async () => {
    const wrong = await paired(summed({ passengers: "wrong" }));
    const crossings = await passageOf(wrong.agent, "passengers crossings", "Crossings");
    const given = await task(wrong.agent, wrong.mindId);
    const unusable = runId(await run(wrong.agent, [{ name: "crossings", passageId: crossings }]));
    expect(
      structured<Reported>(
        await wrong.agent.callTool({
          name: "report_check",
          arguments: {
            mindId: wrong.mindId,
            task: given.task,
            results: [{ n: 1, verdict: "supported", run: unusable, explanation: "351." }],
          },
        }),
      ),
    ).toMatchObject({ unconfirmed: [1] });
    expect(
      (await marks(wrong.core, wrong.mindId, wrong.coast.id)).map((each) => each.state),
    ).not.toContain("supported");

    const mixed = await paired(summed({ passengers: "right", doubled: "wrong" }));
    const rows = await passageOf(mixed.agent, "passengers crossings", "Crossings");
    const mixedTask = await task(mixed.agent, mixed.mindId);
    const both = runId(await run(mixed.agent, [{ name: "crossings", passageId: rows }]));
    await mixed.agent.callTool({
      name: "report_check",
      arguments: {
        mindId: mixed.mindId,
        task: mixedTask.task,
        results: [{ n: 1, verdict: "supported", run: both, explanation: "The rows give 350." }],
      },
    });
    expect(await marks(mixed.core, mixed.mindId, mixed.coast.id)).toMatchObject([
      { text: PASSENGERS, state: "supported", workedOut: "passengers = 350" },
    ]);
  });

  // protects=on a computer that can't run Python for IncarnaMind, the agent is told so plainly and its own working is still confirmed; fails_when=run_analysis fails without saying why, or a working needs Python
  it("says plainly when this computer can't run code", async () => {
    const { core, agent, mindId, coast } = await paired(passengersOf, false);
    const refused = await run(agent, [{ name: "files", library: "documents" }]);
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/can’t run code for IncarnaMind/);
    const spring = await passageOf(agent, "fares spring", "Harbour");
    const [springCite = "", autumnCite = ""] = await citesOf(agent, spring, [SPRING, AUTUMN]);
    const given = await task(agent, mindId);
    const reported = structured<Reported>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [{ n: 2, verdict: "supported", working: faresWorking(springCite, autumnCite) }],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 1 });
    expect(await marks(core, mindId, coast.id)).toMatchObject([
      { text: FARES, state: "supported", workedOut: "1,250,000 + 750,000 = £2,000,000" },
    ]);
  });
});
