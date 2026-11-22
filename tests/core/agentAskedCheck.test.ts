/**
 * A check the User asks of their own AI lands on a Note they wrote (#3622). Pressing Check with no
 * model set up asks one connected agent (#3587); that agent may then take the Note's sentences with
 * `check_mind_yourself` and mark it with `report_check`, as it does a Note it wrote, until the check
 * lands, the User asks another agent, or the ask lapses. An agent the User didn't ask is refused as
 * before.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkedWith, claimCheckShown } from "../../src/shared/claimChecks";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, note, readMind, writeMind } from "../helpers/minds";
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
const TWICE = "Spring tides happen twice a month";
const LARGEST = "The range of a spring tide is the largest of the month.";

const NOT_YOURS =
  "Only a note this agent wrote with create_mind can be checked. It didn’t write this one.";
const READ_ONLY =
  "This agent may only read. To let it write new notes and propose changes to your notes, allow it in Settings → AI.";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Task {
  task: string;
  sentences: { n: number; text: string }[];
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

/**
 * A User with no model set up, Tides in "Coast", a Note they wrote there, and four connected agents
 * that read Coast: Claude Code and Codex may write, VS Code and Cursor may only read.
 */
async function written() {
  const calls: ModelCall[] = [];
  let clock = new Date("2026-11-22T10:00:00.000Z");
  const started = await startAgentsCore(
    checkingModel({}, calls),
    { now: () => clock },
    { modelSetUp: false },
  );
  const { core } = started;
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const connect = async (name: string, client: string, propose: boolean) => {
    const { pairing, launch } = await core.connectAgent({
      name,
      client,
      folderIds: [coast.id],
      propose,
    });
    return { pairing, agent: await connectLegacyAgent(launch) };
  };
  const claude = await connect("Claude Code", "claude-code", true);
  const codex = await connect("Codex", "codex", true);
  const vscode = await connect("VS Code", "vscode", false);
  const cursor = await connect("Cursor", "cursor", false);
  const mind = await core.createMind({ title: "Tide notes", folderId: coast.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(SPRING), note(NEAP), note(PENGUINS)]);
  await client.settled();
  return {
    core,
    coast,
    calls,
    claude,
    codex,
    vscode,
    cursor,
    client,
    mindId: mind.id,
    /** The User presses Check, and it asks `asked`. */
    press: (asked: { pairing: { id: string } }) =>
      core.askAgent({ pairingId: asked.pairing.id, mindId: mind.id, ask: { kind: "check" } }),
    later: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const task = (agent: Agent, mindId: string) =>
  agent.callTool({ name: "check_mind_yourself", arguments: { mindId } });

const report = (agent: Agent, mindId: string, given: string, results: unknown[]) =>
  agent.callTool({ name: "report_check", arguments: { mindId, task: given, results } });

/** A Citation of `quote`, which Tides holds word for word. */
async function cited(agent: Agent, quote: string): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: "spring tides range" } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
    }),
  );
  const found = citations.find((each) => each.cite !== null)?.cite;
  if (!found) throw new Error(`No Passage holds “${quote}”.`);
  return found;
}

/** The Note's marks as the User sees them, with who judged and the first quote of each card. */
async function marks(setup: Awaited<ReturnType<typeof written>>) {
  const { core, client, coast } = setup;
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    text: span.sentence.text,
    state: claimCheckShown(span.check, {
      footing: "not-yet-known",
      text: span.sentence.text,
      versions,
      folderId: coast.id,
      scope: null,
    }).state,
    by: checkedWith(span.check)?.models.map((model) => model.modelId) ?? [],
    quote: span.check.parts?.[0]?.evidence[0]?.quote ?? null,
  }));
}

/** The agent's full report on the three sentences of `given`. */
async function judged(agent: Agent, given: Task) {
  const n = (text: string) => given.sentences.find((each) => each.text === text)?.n;
  return [
    { n: n(SPRING), verdict: "supported", cites: [await cited(agent, TWICE)] },
    { n: n(NEAP), verdict: "contradicted", cites: [await cited(agent, LARGEST)] },
    { n: n(PENGUINS), verdict: "not found", explanation: "Tides says nothing of penguins." },
  ];
}

describe("a check the User asks of their own AI, on a Note they wrote (#3622)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a User with no model set up who presses Check on a Note they wrote gets its marks from the AI they asked, each card with its quote, and nothing goes to a model of IncarnaMind's; fails_when=the asked agent is refused the Note it was asked to check, or its report lands no marks
  it("marks the Note once the User asked this agent to check it, never before, and the ask ends when it lands", async () => {
    const setup = await written();
    const { claude, mindId, calls } = setup;
    expect(refusal(await task(claude.agent, mindId))).toBe(NOT_YOURS);

    await setup.press(claude);
    const { request } = structured<{ request: string }>(
      await claude.agent.callTool({ name: "read_request", arguments: { note: "Tide notes" } }),
    );
    expect(request).toBe(
      `My message is about my note “Tide notes” in IncarnaMind (mindId: ${mindId}). Check every sentence of it against my Documents: use check_mind_yourself, then hand your results back with report_check. Then tell me which sentences need a look.`,
    );
    const given = structured<Task>(await task(claude.agent, mindId));
    expect(given.sentences.map((each) => each.text)).toEqual([SPRING, NEAP, PENGUINS]);
    expect(
      structured(await report(claude.agent, mindId, given.task, await judged(claude.agent, given))),
    ).toMatchObject({ marked: 3, unconfirmed: [], unreported: [], next: null });

    expect(await marks(setup)).toEqual([
      { text: SPRING, state: "supported", by: ["Claude Code"], quote: TWICE },
      { text: NEAP, state: "contradicted", by: ["Claude Code"], quote: LARGEST },
      { text: PENGUINS, state: "unsupported", by: ["Claude Code"], quote: null },
    ]);
    expect(calls).toEqual([]);
    // The check landed whole: the ask is over, and the Note is the User's again.
    expect(refusal(await task(claude.agent, mindId))).toBe(NOT_YOURS);
  });

  // protects=only the AI the User asked may mark the User's Note: another connected AI, one that may write or one that may only read, is refused in the words it always was; fails_when=asking one agent lets every agent that reads the Folder lay results on it
  it("refuses every agent the User didn't ask, in the words it always did", async () => {
    const setup = await written();
    const { claude, codex, cursor, mindId } = setup;
    await setup.press(claude);
    const given = structured<Task>(await task(claude.agent, mindId));

    expect(refusal(await task(codex.agent, mindId))).toBe(NOT_YOURS);
    expect(refusal(await report(codex.agent, mindId, given.task, []))).toBe(NOT_YOURS);
    expect(refusal(await task(cursor.agent, mindId))).toBe(READ_ONLY);
    expect(refusal(await report(cursor.agent, mindId, given.task, []))).toBe(READ_ONLY);
    expect(await marks(setup)).toEqual([]);
  });

  // protects=a connection that may only read can still check a Note the User asked it to, since marks change none of the Note's words; fails_when=a read-only agent asked by the User is refused as read-only
  it("marks the Note for an agent that may only read, once the User asked it", async () => {
    const setup = await written();
    const { vscode, mindId } = setup;
    expect(refusal(await task(vscode.agent, mindId))).toBe(READ_ONLY);

    await setup.press(vscode);
    const given = structured<Task>(await task(vscode.agent, mindId));
    structured(await report(vscode.agent, mindId, given.task, await judged(vscode.agent, given)));
    expect((await marks(setup)).map((each) => [each.text, each.state, each.by])).toEqual([
      [SPRING, "supported", ["VS Code"]],
      [NEAP, "contradicted", ["VS Code"]],
      [PENGUINS, "unsupported", ["VS Code"]],
    ]);
  });

  // protects=the User may go on writing while their AI checks: a report on sentences that changed since is refused, as for an agent's own Note, and the AI takes them again and lands its marks; fails_when=a stale report lands, or the edit ends the ask and the check is lost
  it("refuses a report on sentences the User changed since, and takes the report the agent makes again", async () => {
    const setup = await written();
    const { claude, client, mindId } = setup;
    await setup.press(claude);
    const stale = structured<Task>(await task(claude.agent, mindId));
    editMind(client, (blocks) => [...blocks.slice(0, 2), note(`${PENGUINS} They leave in May.`)]);
    await client.settled();

    expect(
      refusal(await report(claude.agent, mindId, stale.task, await judged(claude.agent, stale))),
    ).toBe(
      "The note changed after check_mind_yourself gave its sentences. Call check_mind_yourself again, then report.",
    );
    expect(await marks(setup)).toEqual([]);
    const fresh = structured<Task>(await task(claude.agent, mindId));
    const n = (text: string) => fresh.sentences.find((each) => each.text === text)?.n;
    structured(
      await report(claude.agent, mindId, fresh.task, [
        { n: n(SPRING), verdict: "supported", cites: [await cited(claude.agent, TWICE)] },
        { n: n(NEAP), verdict: "contradicted", cites: [await cited(claude.agent, LARGEST)] },
        { n: n(PENGUINS), verdict: "not found" },
        { n: n("They leave in May."), verdict: "not found" },
      ]),
    );
    expect((await marks(setup)).map((each) => each.state)).toEqual([
      "supported",
      "contradicted",
      "unsupported",
      "unsupported",
    ]);
  });

  // protects=told to report again what IncarnaMind couldn't confirm, the asked agent may, and the ask ends once nothing is left; fails_when=the first report ends the ask and the agent's corrected report is refused
  it("keeps the ask while the agent reports again what didn't land", async () => {
    const setup = await written();
    const { claude, mindId } = setup;
    await setup.press(claude);
    const given = structured<Task>(await task(claude.agent, mindId));
    const n = (text: string) => given.sentences.find((each) => each.text === text)?.n;
    expect(
      structured(
        await report(claude.agent, mindId, given.task, [
          { n: n(SPRING), verdict: "supported" },
          { n: n(NEAP), verdict: "contradicted", cites: [await cited(claude.agent, LARGEST)] },
          { n: n(PENGUINS), verdict: "not found" },
        ]),
      ),
    ).toMatchObject({ marked: 3, unconfirmed: [n(SPRING)] });

    const again = structured<Task>(await task(claude.agent, mindId));
    expect(again.sentences.map((each) => each.text)).toEqual([SPRING]);
    structured(
      await report(claude.agent, mindId, again.task, [
        { n: 1, verdict: "supported", cites: [await cited(claude.agent, TWICE)] },
      ]),
    );
    expect((await marks(setup)).map((each) => each.state)).toEqual([
      "supported",
      "contradicted",
      "unsupported",
    ]);
    expect(refusal(await task(claude.agent, mindId))).toBe(NOT_YOURS);
  });

  // protects=the AI that may mark the Note is the one the User asked last: asking another ends the first one's ask, and an ask lapses after half an hour; fails_when=two agents may mark the Note at once, or an ask never ends
  it("ends the ask when the User asks another agent, and after half an hour", async () => {
    const setup = await written();
    const { claude, codex, mindId } = setup;
    await setup.press(claude);
    await setup.press(codex);
    expect(refusal(await task(claude.agent, mindId))).toBe(NOT_YOURS);
    structured(await task(codex.agent, mindId));

    setup.later(29 * 60_000);
    structured(await task(codex.agent, mindId));
    setup.later(2 * 60_000);
    expect(refusal(await task(codex.agent, mindId))).toBe(NOT_YOURS);
  });
});
