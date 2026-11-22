/**
 * An outside agent checks the Note it wrote with its own model (#3342): through the shim the app
 * ships, it takes the Note's sentences with `check_mind_yourself`, and hands its results back with
 * `report_check`. IncarnaMind sends nothing to a model, confirms each Citation in its Document and
 * marks the Note, where the User sees the marks.
 */

import { writeFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { readNoteState } from "../../src/renderer/src/noteState";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { checkedWith, claimCheckShown } from "../../src/shared/claimChecks";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { checkRows } from "../../src/shared/noteHealth";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon.",
  "",
  "The range of a spring tide is the largest of the month.",
].join("\n");

const SPRING = "Spring tides come twice in every month.";
const NEAP = "Neap tides have the largest range of the month.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const SOURCES = "These notes were drawn from the files in the Coast folder.";
const SPRING_RANGE = "Spring tides have the largest range of the month.";
const NOTE = [SPRING, NEAP, PENGUINS, SOURCES].join("\n\n");

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Task {
  mindId: string;
  title: string;
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

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

/** A core with agents on, Tides in "Coast" and an agent that may write there. */
async function paired() {
  const calls: ModelCall[] = [];
  const started = await startAgentsCore(checkingModel({}, calls));
  const { core } = started;
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(launch);
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title: "Tide notes", markdown: NOTE },
    }),
  );
  return { ...started, core, coast, agent, mindId, calls, tides };
}

const task = async (agent: Agent, mindId: string) =>
  structured<Task>(await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }));

const report = (agent: Agent, mindId: string, given: string, results: unknown[]) =>
  agent.callTool({ name: "report_check", arguments: { mindId, task: given, results } });

/** A Citation of `quote`, which Tides holds word for word. */
async function cited(agent: Agent, quote: string): Promise<string> {
  const { passages: results } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: "spring tides range" } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: {
        citations: results.map(({ passageId }) => ({ passageId, quote })),
      },
    }),
  );
  const found = citations.find((each) => each.cite !== null)?.cite;
  if (!found) throw new Error(`No Passage holds “${quote}”.`);
  return found;
}

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
    quote: span.check.parts?.[0]?.evidence[0]?.quote ?? null,
  }));
}

describe("an outside agent checks its Note with its own model (#3342)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a User whose agent wrote a Note sees which of its sentences their Documents back, without setting up a model in IncarnaMind; fails_when=the Tools don't mark the Note, or a verdict stands on a quote IncarnaMind didn't find
  it("marks the Note with the agent's results, each on a Citation IncarnaMind found, and sends nothing to a model", async () => {
    const { core, agent, mindId, coast, calls } = await paired();

    const given = await task(agent, mindId);
    expect(given.title).toBe("Tide notes");
    expect(given.sentences).toEqual([
      { n: 1, text: SPRING },
      { n: 2, text: NEAP },
      { n: 3, text: PENGUINS },
      { n: 4, text: SOURCES },
    ]);
    expect(given.how).toContain("report_check");
    expect(given.how).toContain(coast.id);

    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    const reported = structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [twice], explanation: "Tides says twice a month." },
        {
          n: 2,
          verdict: "contradicted",
          cites: [largest],
          explanation: "Tides says the spring tide's range is the largest.",
        },
        { n: 3, verdict: "not found", cites: [], explanation: "Tides says nothing of penguins." },
        { n: 4, verdict: "nothing to check" },
      ]),
    );
    expect(reported).toMatchObject({ marked: 3, unconfirmed: [], unreported: [], next: null });

    expect(await marks(core, mindId, coast.id)).toEqual([
      {
        text: SPRING,
        state: "supported",
        by: ["Claude Code"],
        quote: "Spring tides happen twice a month",
      },
      {
        text: NEAP,
        state: "contradicted",
        by: ["Claude Code"],
        quote: "The range of a spring tide is the largest of the month.",
      },
      { text: PENGUINS, state: "unsupported", by: ["Claude Code"], quote: null },
    ]);
    expect(calls).toEqual([]);
    // Every sentence has its result: there is nothing left to judge.
    expect((await task(agent, mindId)).sentences).toEqual([]);
  });

  // protects=asked to check a Note it checked before, the agent's new verdict lands in the Note's marks rather than staying in its reply (#3541); fails_when=check_mind_yourself gives nothing to judge again, or a result handed back for a sentence that held one leaves the earlier mark
  it("gives every sentence again when asked, and the new results replace the Note's marks", async () => {
    const { core, agent, mindId, coast } = await paired();
    const given = await task(agent, mindId);
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [twice] },
        { n: 2, verdict: "supported", cites: [largest] },
        { n: 3, verdict: "not found" },
        { n: 4, verdict: "nothing to check" },
      ]),
    );
    const done = await task(agent, mindId);
    expect(done.sentences).toEqual([]);
    expect(done.how).toContain("again: true");

    const again = structured<Task>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId, again: true } }),
    );
    expect(again.sentences.map((each) => each.text)).toEqual([SPRING, NEAP, PENGUINS]);
    expect(again.how).toContain("report_check");
    const neap = again.sentences.find((each) => each.text === NEAP)?.n;
    const penguins = again.sentences.find((each) => each.text === PENGUINS)?.n;
    // A result handed back again is held to what a first one is: Supported only on a quote found.
    expect(
      structured<Reported>(
        await report(agent, mindId, again.task, [
          { n: neap, verdict: "contradicted", cites: [largest] },
          { n: penguins, verdict: "supported", cites: ["[cite:made-up]"] },
        ]),
      ),
    ).toMatchObject({ marked: 2, unconfirmed: [penguins] });
    expect((await marks(core, mindId, coast.id)).map((each) => [each.text, each.state])).toEqual([
      [SPRING, "supported"],
      [NEAP, "contradicted"],
      [PENGUINS, "not-checked"],
    ]);
  });

  // protects=a ✓ in the User's Note always rests on words that are in their Document; fails_when=an agent's supported with no Citation, or with one it made up, is marked Supported
  it("marks Not checked a supported or contradicted result with no Citation it can confirm, and gives it out again", async () => {
    const { core, agent, mindId, coast } = await paired();
    const given = await task(agent, mindId);

    const reported = structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [], explanation: "It is well known." },
        { n: 2, verdict: "contradicted", cites: ["[cite:made-up]"], explanation: "Not so." },
      ]),
    );
    expect(reported).toMatchObject({ marked: 2, unconfirmed: [1, 2], unreported: [3, 4] });
    expect(reported.next).toContain("check_mind_yourself");
    expect((await marks(core, mindId, coast.id)).map((each) => [each.text, each.state])).toEqual([
      [SPRING, "not-checked"],
      [NEAP, "not-checked"],
    ]);

    const again = await task(agent, mindId);
    expect(again.sentences.map((each) => each.text)).toEqual([SPRING, NEAP, PENGUINS, SOURCES]);
    expect(again.task).toBe(given.task);
  });

  // protects=a figure in a table is judged as what its row and column say it is; fails_when=a cell reaches the agent as a bare number
  it("gives a table's cell with its row and column headings, and marks the cell", async () => {
    const { core, agent, coast } = await paired();
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Tide table",
          markdown: ["| Tide | Times a month |", "| --- | --- |", "| Spring | 2 |"].join("\n"),
        },
      }),
    );

    const given = await task(agent, mindId);
    const cell = given.sentences.find((each) => each.text === "2");
    expect(cell).toMatchObject({ row: "Spring", column: "Times a month" });

    const twice = await cited(agent, "Spring tides happen twice a month");
    const reported = structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: cell?.n, verdict: "supported", cites: [twice], explanation: "Twice a month." },
      ]),
    );
    expect(reported).toMatchObject({ marked: 1, unconfirmed: [] });
    expect((await marks(core, mindId, coast.id)).map((each) => [each.text, each.state])).toEqual([
      ["2", "supported"],
    ]);
  });

  // protects=a Note the agent changes after its check is checked again before the User reads it, and nothing checked is judged twice; fails_when=the change doesn't say what is left to check, or the task gives back sentences that hold a result
  it("after the agent changes the Note it checked, says what is left and gives only that", async () => {
    const { core, agent, mindId, coast } = await paired();
    // Checking as it lands on: off, what is left waits for the User (agentCheckWaits, #3576).
    await core.updateSettings({ user: { checkAssistantWrites: true } });
    const given = await task(agent, mindId);
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [twice] },
        { n: 2, verdict: "contradicted", cites: [largest] },
        { n: 3, verdict: "not found" },
        { n: 4, verdict: "nothing to check" },
      ]),
    );

    const { version } = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    const changed = structured<{ status: string; next: string | null }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: { mindId, version, changes: [{ paragraph: "¶2", text: SPRING_RANGE }] },
      }),
    );
    expect(changed).toMatchObject({
      status: "applied",
      next: "1 sentence of the note holds no check result now: check it before you finish, with check_mind_yourself, which gives only that one.",
    });

    const again = await task(agent, mindId);
    expect(again.sentences).toEqual([{ n: 1, text: SPRING_RANGE }]);
    structured<Reported>(
      await report(agent, mindId, again.task, [{ n: 1, verdict: "supported", cites: [largest] }]),
    );
    expect((await marks(core, mindId, coast.id)).map((each) => [each.text, each.state])).toEqual([
      [SPRING, "supported"],
      [SPRING_RANGE, "supported"],
      [PENGUINS, "unsupported"],
    ]);
    expect((await task(agent, mindId)).sentences).toEqual([]);
  });

  // protects=a result stands for the agent's own check only while its Documents are at the versions it read: once one changed, the sentences resting on it are given out again (#3412 review); fails_when=check_mind_yourself counts a result whose Document changed since as settled and never gives the sentence again
  it("gives a sentence out again once the Document its result rests on changed", async () => {
    const { core, agent, mindId, tides } = await paired();
    const given = await task(agent, mindId);
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [twice] },
        { n: 2, verdict: "contradicted", cites: [largest] },
        { n: 3, verdict: "not found" },
        { n: 4, verdict: "nothing to check" },
      ]),
    );
    expect((await task(agent, mindId)).sentences).toEqual([]);

    await writeFile(tides.path, `${TIDES}\n\nNeap tides come in between.\n`);
    await core.reconcileDocuments();
    await waitForProcessing(core, [tides.id]);
    // The two that rest on Tides; the agent's "not found" rests on no Document.
    expect((await task(agent, mindId)).sentences.map((each) => each.text)).toEqual([SPRING, NEAP]);
  });

  // protects=an agent that hands back its results in parts, or again, has each part marked on the sentences it was given (#3432); fails_when=its own first report counts as the Note changing, and the rest is refused
  it("takes a report on the same sentences after the first one landed, by the numbers it gave", async () => {
    const { core, agent, mindId, coast } = await paired();
    const given = await task(agent, mindId);
    const twice = await cited(agent, "Spring tides happen twice a month");
    structured<Reported>(
      await report(agent, mindId, given.task, [{ n: 1, verdict: "supported", cites: [twice] }]),
    );

    const rest = structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 3, verdict: "not found", explanation: "Tides says nothing of penguins." },
      ]),
    );
    expect(rest).toMatchObject({ marked: 1, unconfirmed: [], unreported: [2, 4] });
    expect((await marks(core, mindId, coast.id)).map((each) => [each.text, each.state])).toEqual([
      [SPRING, "supported"],
      [PENGUINS, "unsupported"],
    ]);
  });

  // protects=a result is never laid on words the agent didn't judge; fails_when=results for an earlier state of the Note mark it as it is now
  it("refuses results for a Note whose words changed since its sentences were given", async () => {
    const { agent, mindId } = await paired();
    const given = await task(agent, mindId);
    const { version } = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: { mindId, version, changes: [{ paragraph: "¶2", text: SPRING_RANGE }] },
      }),
    );

    expect(refusal(await report(agent, mindId, given.task, [{ n: 2, verdict: "not found" }]))).toBe(
      "The note changed after check_mind_yourself gave its sentences. Call check_mind_yourself again, then report.",
    );
  });

  // protects=a result lands only on the claim the agent judged, a figure IncarnaMind worked out as it was shown included (#3432); fails_when=a report from before the figure's value changed marks the sentence as it reads now
  it("refuses results for a sentence whose figure changed since it was given", async () => {
    const { core, agent, mindId } = await paired();
    const client = await connectToMind(core, mindId);
    await client.settled();
    const growth = (value: number, shown: string) => ({
      type: "paragraph",
      attrs: { id: "line-growth" },
      content: [
        { type: "text", text: "Spring tides rose " },
        calculatedFigureNode(
          {
            label: "Growth",
            formula: "",
            inputs: [],
            value,
            unit: { kind: "percent" },
            approximate: false,
            shown,
            show: { language: "en", as: "percent", decimals: 1, scale: null },
            literals: [],
            engine: FORMULA_VERSION,
            written: null,
            analysis: { analysis: 1, result: "growth" },
          },
          "figure-growth",
          "analysis-run",
        ),
        { type: "text", text: " over the year." },
      ],
    });
    writeMind(client, [growth(0.25, "25.0%")]);
    await client.settled();
    const given = await task(agent, mindId);
    expect(given.sentences).toEqual([{ n: 1, text: "Spring tides rose 25.0% over the year." }]);

    editMind(client, () => [growth(0.3, "30.0%")]);
    await client.settled();
    expect(refusal(await report(agent, mindId, given.task, [{ n: 1, verdict: "not found" }]))).toBe(
      "The note changed after check_mind_yourself gave its sentences. Call check_mind_yourself again, then report.",
    );
    expect((await task(agent, mindId)).sentences).toEqual([
      { n: 1, text: "Spring tides rose 30.0% over the year." },
    ]);
  });

  // protects=an agent that reads its Note in a later chat learns that its sentences aren't checked, where it decides how to answer whether the Note is right (#3432); fails_when=read_mind says nothing of it, says it of a Note the User wrote, or still says it once every sentence holds a result
  it("read_mind says how many sentences of a Note the agent wrote hold no check result yet", async () => {
    const { core, agent, mindId, coast } = await paired();
    const read = async (id: string, named?: boolean) =>
      structured<{ next: string | null }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: id, named } }),
      ).next;
    const unchecked =
      "4 sentences of this note hold no check result yet: to tell the User whether they are right, check them with check_mind_yourself, which gives them.";
    expect(await read(mindId)).toBe(unchecked);
    expect(await read(mindId, true)).toBe(unchecked);

    const given = await task(agent, mindId);
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [twice] },
        { n: 2, verdict: "contradicted", cites: [largest] },
        { n: 4, verdict: "nothing to check" },
      ]),
    );
    expect(await read(mindId)).toBe(
      "1 sentence of this note holds no check result yet: to tell the User whether it is right, check it with check_mind_yourself, which gives it.",
    );
    structured<Reported>(await report(agent, mindId, given.task, [{ n: 3, verdict: "not found" }]));
    expect(await read(mindId)).toBeNull();

    const theirs = await core.createMind({ title: "My own", folderId: coast.id });
    expect(await read(theirs.id)).toBeNull();
  });

  // protects=an agent marks only the Notes it wrote; fails_when=it can lay results on a Note of the User's
  it("refuses a Note the agent didn't write", async () => {
    const { core, agent, coast } = await paired();
    const own = await core.createMind({ title: "My own", folderId: coast.id });

    for (const call of [
      agent.callTool({ name: "check_mind_yourself", arguments: { mindId: own.id } }),
      agent.callTool({ name: "check_mind_yourself", arguments: { mindId: own.id, again: true } }),
      report(agent, own.id, "any", []),
    ]) {
      expect(refusal(await call)).toBe(
        "Only a note this agent wrote with create_mind can be checked. It didn’t write this one.",
      );
    }
  });

  // protects=a mark's card shows every quote the agent's verdict rests on, in the order it gave them, never only the first, whichever place each is from, and an overstated one on a single quote keeps it for its card (#3587); fails_when=a verdict on two quotes keeps only the first, an overstated one loses its quote, a sentence takes more than one mark, or a Supported or Contradicted result on one quote is stored differently from before (which would read as changed)
  it("keeps every quote a verdict rests on, in the order given, on the sentence's one mark", async () => {
    const { core, agent, mindId, coast, tides } = await paired();
    const given = await task(agent, mindId);
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    const quoted = async () => {
      const client = await connectToMind(core, mindId);
      await client.settled();
      return claimSpans(readMind(client)).map(({ sentence, check }) => ({
        text: sentence.text,
        quotes: check.parts?.flatMap((part) => [
          ...(part.unsupported?.word === "own-view" && part.unsupported.quoted
            ? [part.unsupported.quoted.quote]
            : []),
          ...part.evidence.map((citation) => citation.quote),
        ]),
        everyQuote: check.parts?.map((part) => part.restsOnEveryQuote === true),
      }));
    };
    /** The rows the Note's page counts, and what the agent is told of them once nothing is left. */
    const counted = async () => {
      const client = await connectToMind(core, mindId);
      await client.settled();
      const { health } = readNoteState({
        doc: client.doc,
        cellFigures: [],
        footing: [],
        documents: await core.listDocuments(),
        keptCitationTexts: [],
        folderId: coast.id,
      });
      const done = structured<Task & { checked: { supported: number; needLook: number } }>(
        await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
      );
      return {
        page: Object.fromEntries(checkRows(health).map(({ row, places }) => [row, places.length])),
        left: done.sentences,
        told: { supported: done.checked.supported, needLook: done.checked.needLook },
      };
    };

    structured<Reported>(
      await report(agent, mindId, given.task, [
        { n: 1, verdict: "supported", cites: [twice] },
        { n: 2, verdict: "contradicted", cites: [largest, twice], explanation: "Not neap." },
        { n: 3, verdict: "overstated", cites: [twice], explanation: "No penguins." },
        { n: 4, verdict: "own view", cites: [largest, twice] },
      ]),
    );
    const SPRING_QUOTE = "Spring tides happen twice a month";
    const RANGE_QUOTE = "The range of a spring tide is the largest of the month.";
    expect(await quoted()).toEqual([
      // One quote is kept as it always was: no result stored before this reads as changed.
      { text: SPRING, quotes: [SPRING_QUOTE], everyQuote: [false] },
      { text: NEAP, quotes: [RANGE_QUOTE, SPRING_QUOTE], everyQuote: [true] },
      { text: PENGUINS, quotes: [SPRING_QUOTE], everyQuote: [true] },
      { text: SOURCES, quotes: [RANGE_QUOTE, SPRING_QUOTE], everyQuote: [true] },
    ]);
    const onOneQuote = await counted();
    expect(onOneQuote).toMatchObject({
      page: { look: 2, notYetCited: 1, ownViews: 1 },
      left: [],
      // A Supported sentence that cites nothing yet is "can be cited", for the agent too.
      told: { supported: 0, needLook: 2 },
    });

    const again = structured<Task>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId, again: true } }),
    );
    const numbered = (text: string) => again.sentences.find((each) => each.text === text)?.n;
    structured<Reported>(
      await report(agent, mindId, again.task, [
        { n: numbered(SPRING), verdict: "supported", cites: [twice, largest] },
        { n: numbered(PENGUINS), verdict: "partly supported", cites: [largest, twice] },
      ]),
    );
    expect(
      (await quoted()).filter((each) => each.text === SPRING || each.text === PENGUINS),
    ).toEqual([
      { text: SPRING, quotes: [SPRING_QUOTE, RANGE_QUOTE], everyQuote: [true] },
      { text: PENGUINS, quotes: [RANGE_QUOTE, SPRING_QUOTE], everyQuote: [true] },
    ]);
    // A verdict on several quotes reads as itself wherever it is read: its mark, the Note's page,
    // what the agent is told, and Check again, which gives it no more.
    expect((await marks(core, mindId, coast.id)).map((each) => [each.text, each.state])).toEqual([
      [SPRING, "supported"],
      [NEAP, "contradicted"],
      [PENGUINS, "unsupported"],
      [SOURCES, "own-view"],
    ]);
    expect(await counted()).toEqual(onOneQuote);

    // What they rest on is each quote's Document: changed, every one that quotes it is given again.
    await writeFile(tides.path, `${TIDES}\n\nNeap tides come in between.\n`);
    await core.reconcileDocuments();
    await waitForProcessing(core, [tides.id]);
    expect((await task(agent, mindId)).sentences.map((each) => each.text)).toEqual([
      SPRING,
      NEAP,
      PENGUINS,
      SOURCES,
    ]);
  });
});

describe("a cell an agent corrects in a Note it wrote (#3466)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  const HARVEST = "# Harvest\n\nPears came to 610 tonnes in 2026.";

  // protects=once the agent corrects a cell its check found contradicted and checks it again, the cell shows that result alone; fails_when=a mark of the earlier check stays beside the new one, shown as Needs re-check, because the agent's rewrite carried it onto the space before the cell's Citation
  it("shows the new result alone once the agent corrects the cell and checks it again", async () => {
    const started = await startAgentsCore(checkingModel({}));
    const { core } = started;
    const sources = await createSourceFolder();
    const [harvest] = await addAndProcess(core, [
      await writeSourceFile(sources, "Harvest.md", HARVEST),
    ]);
    const orchard = await core.createLibraryGroup({ name: "Orchard", description: "Fruit." });
    await core.assignDocumentGroup(harvest?.id ?? "", orchard.id);
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [orchard.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const call = async <T>(name: string, args: Record<string, unknown>) =>
      structured<T>(await agent.callTool({ name, arguments: args }));
    const { passages } = await call<{ passages: { passageId: string }[] }>("search", {
      query: "pears tonnes 2026",
    });
    const { citations } = await call<{ citations: { cite: string }[] }>("cite", {
      citations: [{ passageId: passages[0]?.passageId, quote: "Pears came to 610 tonnes in 2026" }],
    });
    const pears = citations[0]?.cite ?? "";
    const { mindId } = await call<{ mindId: string }>("create_mind", {
      title: "Harvest report",
      markdown: ["| Fruit | Tonnes |", "|---|---|", `| Pears | 610 ${pears} |`].join("\n"),
    });
    const check = async (verdict: string) => {
      const given = await call<Task>("check_mind_yourself", { mindId });
      const results = given.sentences.map(({ n, text }) =>
        /^\d/.test(text) ? { n, verdict, cites: [pears] } : { n, verdict: "nothing to check" },
      );
      return call<Reported>("report_check", { mindId, task: given.task, results });
    };
    await check("supported");

    // The User types 710 over 610: the agent's check finds it contradicted.
    const client = await connectToMind(core, mindId);
    await client.settled();
    const typed = (node: JSONContent): JSONContent => ({
      ...node,
      ...(node.text === "610" && { text: "710" }),
      ...(node.content && { content: node.content.map(typed) }),
    });
    editMind(client, (blocks) => blocks.map(typed));
    await client.settled();
    expect(await check("contradicted")).toMatchObject({ marked: 1 });

    // The agent puts 610 back and checks the cell again.
    const named = await call<{ markdown: string; version: string }>("read_mind", {
      mindId,
      named: true,
    });
    const cell = /(¶\d+) 710 /.exec(named.markdown)?.[1];
    await call("propose_changes", {
      mindId,
      version: named.version,
      changes: [{ paragraph: cell, text: `610 ${pears}` }],
    });
    expect(await check("supported")).toMatchObject({ marked: 1, unreported: [] });
    await client.settled();
    expect(
      claimSpans(readMind(client)).map((span) => [
        span.sentence.text.trim(),
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions: null,
          folderId: null,
          scope: null,
        }).state,
      ]),
    ).toEqual([["610", "supported"]]);
  });

  // protects=a Note the agent rewrote a paragraph of after its check counts as not checked yet only what its check is given again, so asked later whether the Note is right the agent has no unchecked sentence it can't report on (#3541); fails_when=a space the rewrite kept carries an earlier result past the next sentence, and the Note counts that result as changed while check_mind_yourself says nothing is left
  it("after the agent rewrites a paragraph it checked, counts as not checked just what it gives again", async () => {
    const { core, agent, coast } = await paired();
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    const lead = "**Spring tides matter most.**";
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Spring tides",
          markdown: `${lead} Spring tides come twice a month ${twice}, so we plan around them. Their range is the largest of the month ${largest}, the biggest of all (twice that of neaps) ${largest}. They come at new moon and full moon ${twice}. Fishing boats wait for them ${twice}, so the harbour is busy.`,
          folderId: coast.id,
        },
      }),
    );
    const first = await task(agent, mindId);
    structured<Reported>(
      await report(
        agent,
        mindId,
        first.task,
        first.sentences.map(({ n }) =>
          n === 1 ? { n, verdict: "own view" } : { n, verdict: "supported", cites: [twice] },
        ),
      ),
    );

    const { version } = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version,
          changes: [
            {
              paragraph: "¶1",
              text: `${lead} Spring tides come twice a month ${twice}, so we plan around them. Their range of the month is the largest of all ${largest}, and they come at new and full moon ${twice}.`,
            },
          ],
        },
      }),
    );
    const again = await task(agent, mindId);
    structured<Reported>(
      await report(
        agent,
        mindId,
        again.task,
        again.sentences.map(({ n }) => ({ n, verdict: "supported", cites: [largest, twice] })),
      ),
    );

    const done = structured<Task & { checked?: { notChecked: number } }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
    );
    expect(done.sentences).toEqual([]);
    expect(done.checked?.notChecked).toBe(0);
    // The Note's page reads its marks the same way: none of them reads as changed.
    const shown = await marks(core, mindId, coast.id);
    expect(shown.find((each) => each.state === "own-view")?.text).toBe("Spring tides matter most.");
    expect(shown.map((each) => each.state)).not.toContain("needs-recheck");
  });

  // protects=after an agent rewrites a list item with a new cite token on an unchanged first sentence and replaces the marked second sentence, check_mind_yourself and the Note's marks agree so one round of re-check leaves nothing "not checked" (#3542); fails_when=a trailing space or stale mark left by the rewrite shows needs-recheck in the Note while check_mind_yourself omits that sentence
  it("after rewriting a list item with a new cite token on an unchanged sentence, Note marks and check_mind_yourself agree (#3542)", async () => {
    const { core, agent, coast } = await paired();
    const twice1 = await cited(agent, "Spring tides happen twice a month");
    const largest1 = await cited(agent, "The range of a spring tide is the largest of the month.");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Credit memo",
          markdown: [
            "## Findings",
            "",
            `- **Tides:** Spring tides happen twice a month. ${twice1} Their range is tiny, barely noticeable, and has zero effect on the inner harbour channel during winter storms. ${largest1}`,
            `- **Channel work:** Spring tides come at new moon and full moon. ${twice1}`,
          ].join("\n"),
          folderId: coast.id,
        },
      }),
    );

    const first = await task(agent, mindId);
    expect(first.sentences).toHaveLength(3);
    structured<Reported>(
      await report(agent, mindId, first.task, [
        { n: 1, verdict: "supported", cites: [twice1] },
        { n: 2, verdict: "partly supported", cites: [largest1] },
        { n: 3, verdict: "supported", cites: [twice1] },
      ]),
    );

    // Mint fresh tokens (as Claude Code does after searching again) and rewrite the whole list item
    // (>40% changed): first sentence identical words + new cite token, second sentence replaced.
    const twice2 = await cited(
      agent,
      "Spring tides happen twice a month, at new moon and full moon.",
    );
    const largest2 = await cited(agent, "The range of a spring tide is the largest of the month.");
    const named = structured<{ markdown: string; version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    const listPara = named.markdown
      .split("\n")
      .find((line) => line.includes("Tides:"))
      ?.match(/^(¶\d+)/)?.[1];
    expect(listPara).toBeTruthy();

    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: named.version,
          changes: [
            {
              paragraph: listPara,
              text: `- **Tides:** Spring tides happen twice a month. ${twice2} The range of a spring tide is the largest of the month. ${largest2}`,
            },
          ],
        },
      }),
    );

    const again = await task(agent, mindId);
    expect(again.sentences.length).toBeGreaterThanOrEqual(1);
    const reported = structured<Reported>(
      await report(
        agent,
        mindId,
        again.task,
        again.sentences.map(({ n, text }) => ({
          n,
          verdict: "supported",
          cites: text.includes("twice") ? [twice2] : [largest2],
        })),
      ),
    );
    expect(reported.unconfirmed).toEqual([]);
    expect(reported.unreported).toEqual([]);

    const done = structured<Task & { checked?: { notChecked: number; needLook: number } }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
    );
    const client = await connectToMind(core, mindId);
    await client.settled();
    const doc = readMind(client);
    const versions = new Map(
      (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
    );
    const judgedNow = new Map(Object.entries((await core.judgedWithNow(mindId)).lines));
    const uiClaims = claimsOf(doc, {
      footing: "not-yet-known",
      versions,
      folderId: coast.id,
      scope: null,
      judgedNow,
    }).claims;
    expect(done.sentences).toEqual([]);
    expect(done.checked?.notChecked).toBe(0);
    expect(uiClaims.map((c) => c.shown.state)).toEqual(["supported", "supported", "supported"]);

    // Also verify when the replacement second sentence is "nothing to check": stale marks must not
    // linger on the second sentence or turn the unchanged first sentence into needs-recheck.
    const named2 = structured<{ markdown: string; version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: named2.version,
          changes: [
            {
              paragraph: listPara,
              text: `- **Tides:** Spring tides happen twice a month. ${twice2} See the notes below for details.`,
            },
          ],
        },
      }),
    );
    const again2 = await task(agent, mindId);
    structured<Reported>(
      await report(
        agent,
        mindId,
        again2.task,
        again2.sentences.map(({ n, text }) =>
          text.includes("See the notes")
            ? { n, verdict: "nothing to check" }
            : { n, verdict: "supported", cites: [twice2] },
        ),
      ),
    );
    const done2 = structured<Task & { checked?: { notChecked: number } }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
    );
    await client.settled();
    const uiClaims2 = claimsOf(readMind(client), {
      footing: "not-yet-known",
      versions,
      folderId: coast.id,
      scope: null,
      judgedNow: new Map(Object.entries((await core.judgedWithNow(mindId)).lines)),
    }).claims;
    expect(done2.sentences).toEqual([]);
    expect(done2.checked?.notChecked).toBe(0);
    expect(uiClaims2.map((c) => c.shown.state)).not.toContain("needs-recheck");
  });
});
