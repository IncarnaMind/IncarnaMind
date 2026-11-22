/**
 * A request typed at a Note's foot, run on the User's own Claude Code in the background, in the
 * Note's one conversation (ADR-0034, #3627). The runner here stands in for the command line: it
 * connects through the shim with the launch IncarnaMind gave it, as `claude` would, and calls the
 * Tools. A change to the Note asked from applies at once (inside the selection, if any), any other
 * waits; the conversation continues; Stop, a lost connection and a consent taken back end it; and
 * the conversation goes with the Note, the connection and the consent.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { OwnAiRunner, OwnAiStatus } from "../../src/core/adapters";
import type { AgentLaunch, NoteSelectionBlock, NoteTurnEvent } from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { translate } from "../../src/shared/i18n";
import { NODE_CHARACTER } from "../../src/shared/proposals";
import {
  buildAgentShim,
  connectLegacyAgent,
  connectModernAgent,
  startAgentsCore,
} from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { createTempDataFolder } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, shownWithChanges, writeMind } from "../helpers/minds";

const FERRY = "The ferry carried 212,000 passengers in 2025.";
const FARES = "Fares rose by ten percent.";
const TIMETABLE = "On Tuesday the ferry runs at 07:10 and 18:40.";

/** What the tests call of the command line's connection, on either protocol. */
interface Agent {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
type RunRequest = Parameters<OwnAiRunner["run"]>[0];
type RunEnd = Awaited<ReturnType<OwnAiRunner["run"]>>;

const structured = <T>(result: unknown): T => {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
};

const refusal = (result: unknown): string => {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
};

const mindIdOf = (request: RunRequest) => request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";

/** The agent rewrites the paragraphs that hold `was`, each to its `now`, in one call. */
async function rewrite(agent: Agent, mindId: string, changes: [string, string][]) {
  const read = structured<{ markdown: string; version: string }>(
    await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
  );
  const lines = read.markdown.split("\n");
  return structured<{ status: string; why?: string }>(
    await agent.callTool({
      name: "propose_changes",
      arguments: {
        mindId,
        version: read.version,
        changes: changes.map(([was, now]) => ({
          paragraph: lines.find((line) => line.includes(was))?.match(/¶\d+/)?.[0] ?? "¶9",
          text: now,
        })),
      },
    }),
  );
}

/** A command line that works until it is stopped. */
const untilStopped = (_agent: Agent, request: RunRequest) =>
  new Promise<RunEnd>((resolve) => {
    const end = () => resolve({ kind: "finished", reply: "" });
    if (request.signal.aborted) end();
    request.signal.addEventListener("abort", end, { once: true });
  });

/** A runner whose command line is `act`, connected by `connect`: it records each run and each purge. */
function runner(
  act: (agent: Agent, request: RunRequest) => Promise<RunEnd>,
  status: OwnAiStatus = { kind: "ready" },
  connect: (launch: AgentLaunch) => Promise<Agent> = connectLegacyAgent,
) {
  const runs: RunRequest[] = [];
  const purged: string[] = [];
  const adapter: OwnAiRunner = {
    installed: async () => true,
    status: async () => status,
    async purge(key) {
      purged.push(key);
      return true;
    },
    async run(request) {
      runs.push(request);
      return act(await connect(request.server), request);
    },
  };
  return { adapter, runs, purged };
}

/**
 * A User with no model set up, a Document in "Harbour", a Note they wrote there and another, and
 * Claude Code connected, allowed to propose changes unless `readOnly`. `cited`: the Note's first
 * sentence rests on the report with a Citation after it.
 */
async function written(
  ownAi: OwnAiRunner,
  {
    readOnly = false,
    cited = false,
    quietMs,
  }: { readOnly?: boolean; cited?: boolean; quietMs?: number } = {},
) {
  const canvasFiles = createCanvasFiles(join(await createTempDataFolder(), "Canvases"));
  const started = await startAgentsCore(
    checkingModel({}, []),
    { canvasFiles, ownAi, ...(quietMs !== undefined && { ownAiQuietMs: quietMs }) },
    { modelSetUp: false },
  );
  const { core } = started;
  const sources = await createSourceFolder();
  const [report] = await addAndProcess(core, [
    await writeSourceFile(sources, "Report.md", `# Report\n\n${FERRY}\n`),
  ]);
  if (!report) throw new Error("The report wasn't added.");
  const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
  await core.assignDocumentGroup(report.id, harbour.id);
  await core.setAgentsEnabled(true);
  const claude = await core.connectAgent({
    name: "Claude Code",
    client: "claude-code",
    folderIds: [harbour.id],
    propose: !readOnly,
  });
  const mind = await core.createMind({ title: "Ferry notes", folderId: harbour.id });
  const client = await connectToMind(core, mind.id);
  const first = note(FERRY);
  if (cited) {
    const agent = await connectLegacyAgent(claude.launch);
    const found = structured<{ passages: { passageId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "ferry passengers 2025" } }),
    ).passages[0];
    if (!found) throw new Error("The report wasn't found.");
    first.content = [
      ...(first.content ?? []),
      {
        type: "citation",
        attrs: {
          passageId: found.passageId,
          documentId: report.id,
          documentName: "Report",
          contentHash: report.contentHash,
          quote: FERRY,
          check: "found",
        },
      },
    ];
  }
  writeMind(client, [first, note(FARES)]);
  await client.settled();
  const other = await core.createMind({ title: "Fares", folderId: harbour.id });
  const otherClient = await connectToMind(core, other.id);
  writeMind(otherClient, [note(FARES)]);
  await otherClient.settled();
  const turns: NoteTurnEvent[] = [];
  core.on("agents.noteTurn", (turn) => turns.push(turn));
  const ended = (count = 1) =>
    expect
      .poll(() => turns.filter((turn) => turn.state !== "working").length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(count)
      .then(() => turns.filter((turn) => turn.state !== "working")[count - 1]);
  const blockIdOf = (index: number) => String(readMind(client).child(index).attrs.id);
  const selectionOf = (index: number, words: string): NoteSelectionBlock[] => {
    const text = index === 0 ? FERRY : FARES;
    const at = text.indexOf(words);
    return [
      {
        blockId: blockIdOf(index),
        before: text.slice(0, at),
        after: text.slice(at + words.length),
      },
    ];
  };
  return {
    ...started,
    core,
    mindId: mind.id,
    otherId: other.id,
    client,
    otherClient,
    claude,
    turns,
    ended,
    selectionOf,
  };
}

describe("a request at a Note's foot, on the User's own Claude Code (#3627)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a change to the selected words of the Note asked from applies at once, with Undo, through the same asked-changes path as the assistant's, and changes nothing outside them; the run gets every Tool of IncarnaMind's server, none of its own, and the request's words and selection; fails_when=the change waits, applies outside the selection, or the run is given less or more than the connection's Tools
  it("applies a change inside the selection at once, and nothing else", async () => {
    const run = runner(async (agent, request) => {
      const done = await rewrite(agent, mindIdOf(request), [
        [FERRY, "The ferry carried about 212,000 people in 2025."],
      ]);
      expect(done).toMatchObject({ status: "applied" });
      return { kind: "finished", reply: "Rewrote the passengers as people." };
    });
    const { core, mindId, client, ended, selectionOf } = await written(run.adapter);

    const start = await core.askInNote({
      mindId,
      words: "say people, not passengers",
      quote: "212,000 passengers",
      selection: selectionOf(0, "212,000 passengers"),
    });
    expect(start).toMatchObject({ kind: "started" });
    const end = await ended();
    expect(end).toMatchObject({ state: "landed", reply: "Rewrote the passengers as people." });
    expect(end?.applied).toHaveLength(1);
    const [request] = run.runs;
    expect(request?.tools).toBe("all");
    expect(request?.prompt).toContain("say people, not passengers");
    expect(request?.prompt).toContain("“212,000 passengers”");

    // The window that asked applies it as the assistant's are: here, the core's own path.
    const application = await core.applyAskedChanges({
      answerId: end?.turnId ?? "",
      mindId,
      requests: (end?.applied ?? []).map((each) => each.request),
    });
    expect(application?.held).toBeFalsy();
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      "The ferry carried about 212,000 people in 2025.",
      FARES,
    ]);
  });

  // protects=the window shows a Note's input only where the command line is on this computer, and asks by the link elsewhere; fails_when=a Note offers an input that can only open the link, or hides it where the command line is
  it("says whether the command line can run here", async () => {
    const run = runner(async () => ({ kind: "finished", reply: "" }));
    const here = await written(run.adapter);
    expect(await here.core.ownAiRunsHere()).toBe(true);
    const away = await written({ ...run.adapter, installed: async () => false });
    expect(await away.core.ownAiRunsHere()).toBe(false);
    expect(await away.core.askInNote({ mindId: away.mindId, words: "shorter" })).toEqual({
      kind: "link",
    });
  });

  // protects=while a request runs, every window hears when it started and what it is doing: the AI's own words for a step, standing through that step's calls; thinking once it thinks again after them; and a call with what it names (the Document a reading read) when it said nothing for it; fails_when=the line can only show the last Tool's name, the AI's words flash and go, or no Document is named
  it("tells what the run is doing as it goes", async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
    const run = runner(async (agent, request) => {
      request.progress?.({ kind: "said", text: "I" });
      request.progress?.({ kind: "said", text: "Reading the report" });
      await pause();
      const found = structured<{ passages: { documentId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "ferry passengers" } }),
      ).passages[0];
      await pause();
      request.progress?.({ kind: "thinking" });
      await pause();
      await agent.callTool({ name: "read_passages", arguments: { documentId: found?.documentId } });
      await pause();
      return { kind: "finished", reply: "The ferry carried 212,000 passengers." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "what does the report say about the ferry?" });
    await ended();
    const working = turns.filter((turn) => turn.state === "working");
    expect(working[0]?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const doings = working.map((turn) => turn.doing);
    expect(doings).not.toContainEqual({ kind: "said", text: "I" });
    expect(doings).not.toContainEqual(expect.objectContaining({ kind: "call", tool: "search" }));
    expect(doings).toEqual(
      expect.arrayContaining([
        { kind: "said", text: "Reading the report" },
        { kind: "thinking" },
        { kind: "call", tool: "read_passages", summary: "Report", count: 1 },
      ]),
    );
  });

  // protects=a run that has sent nothing for a while is said to be quiet, and no longer once it sends again; fails_when=the line stays the same for minutes with nothing to say the AI is silent
  it("says when the AI has sent nothing for a while", async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const run = runner(async (_agent, request) => {
      request.progress?.({ kind: "said", text: "Reading the report" });
      await pause(900);
      request.progress?.({ kind: "heard" });
      await pause(500);
      return { kind: "finished", reply: "The ferry carried 212,000 passengers." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter, { quietMs: 300 });
    await core.askInNote({ mindId, words: "what does the report say about the ferry?" });
    expect(await ended()).toMatchObject({ state: "landed", quiet: false });
    const working = turns.filter((turn) => turn.state === "working");
    const quiet = working.findIndex((turn) => turn.quiet);
    expect(working[quiet]?.doing).toEqual({ kind: "said", text: "Reading the report" });
    expect(working.slice(quiet + 1).some((turn) => !turn.quiet)).toBe(true);
    expect(working.slice(0, quiet).every((turn) => !turn.quiet)).toBe(true);
  });

  // protects=a Note the AI writes is named with its id at the end, so the line can open it; fails_when=the line says it wrote a Note the User has no way to open
  it("names the Note it wrote, to open", async () => {
    let wrote = "";
    const run = runner(async (agent) => {
      wrote = structured<{ mindId: string }>(
        await agent.callTool({
          name: "create_mind",
          arguments: { title: "Ferry summary", markdown: "The ferry carried passengers." },
        }),
      ).mindId;
      return { kind: "finished", reply: "I wrote “Ferry summary”." };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "summarise the report in a new note" });
    const end = await ended();
    expect(wrote).not.toBe("");
    expect(end).toMatchObject({
      state: "landed",
      made: [{ mindId: wrote, title: "Ferry summary" }],
    });
  });

  // protects=once a turn has ended, a call of its run that finishes later tells no window it is working again; fails_when=the input stays on Working for good, with nothing to stop
  it("tells nothing of a run after its turn ended", async () => {
    const run = runner(async (agent) => {
      // Left running: the run's end closes its connection under it, and the call still finishes.
      agent
        .callTool({ name: "search", arguments: { query: "ferry passengers" } })
        .catch((error: unknown) => expect(String(error)).toMatch(/Connection closed/));
      return { kind: "failed", reason: "stalled" };
    });
    const { core, mindId, turns, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "anything new?" });
    expect(await ended()).toMatchObject({ state: "failed", problem: "stalled" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const last = turns.findIndex((turn) => turn.state !== "working");
    expect(turns.slice(last + 1)).toEqual([]);
  });

  // protects=a turn ends when its run does, though the command line's connection is still open and listening for the Tool list to change, as Claude Code's can be then; fails_when=closing that connection waits on a message to a socket already gone, and the request stays working for good
  it("ends a turn whose command line hasn't let go of its connection yet", async () => {
    const run = runner(
      async (agent, request) => {
        await rewrite(agent, mindIdOf(request), [[FARES, "Fares rose by a tenth."]]);
        return { kind: "finished", reply: "Rewrote the fares." };
      },
      { kind: "ready" },
      (launch) => connectModernAgent(launch, () => undefined),
    );
    const { core, mindId, ended } = await written(run.adapter);

    await core.askInNote({ mindId, words: "say a tenth" });
    expect(await ended()).toMatchObject({ state: "landed", reply: "Rewrote the fares." });
  });

  // protects=the spacing next to the selected words may change with them, as it does when a figure in a Chinese sentence is written out in characters; fails_when=that change waits as if it changed words outside the selection
  it("keeps a change inside the selection when only the spacing next to it changes", async () => {
    const SHIPS = "去年渡轮共运送乘客 212,000 人次。";
    const run = runner(async (agent, request) => {
      const done = await rewrite(agent, mindIdOf(request), [
        [SHIPS, "去年渡轮共运送乘客二十一万二千人次。"],
      ]);
      expect(done.status).toBe("applied");
      return { kind: "finished", reply: "" };
    });
    const { core, mindId, ended } = await written(run.adapter);
    const folderId = (await core.listMinds()).find((mind) => mind.id === mindId)?.folderId ?? null;
    const ferry = await core.createMind({ title: "渡轮", folderId });
    const client = await connectToMind(core, ferry.id);
    writeMind(client, [note(SHIPS)]);
    await client.settled();

    await core.askInNote({
      mindId: ferry.id,
      words: "写成汉字",
      quote: "212,000",
      selection: [
        {
          blockId: String(readMind(client).child(0).attrs.id),
          before: "去年渡轮共运送乘客 ",
          after: " 人次。",
        },
      ],
    });
    expect((await ended())?.applied).toHaveLength(1);
  });

  // protects=a request's line and end tell only its own run's calls: the same connection's other work, such as the User's own session changing another Note meanwhile, tells nothing there; fails_when=a request reports a change or a refusal it didn't make
  it("tells only its own run's calls", async () => {
    let elsewhere: () => Promise<void> = async () => undefined;
    const run = runner(async () => {
      await elsewhere();
      return { kind: "finished", reply: "Nothing to change." };
    });
    const started = await written(run.adapter);
    const { core, mindId, otherId, claude, ended } = started;
    const own = await connectLegacyAgent(claude.launch);
    elsewhere = async () => {
      await rewrite(own, otherId, [[FARES, "Fares rose by a tenth."]]);
    };
    await core.askInNote({ mindId, words: "anything to fix?" });
    expect(await ended()).toMatchObject({
      state: "landed",
      applied: [],
      waiting: [],
      made: [],
      reply: "Nothing to change.",
    });
  });

  // protects=the window and the core read a Citation next to the selection as one mark: a change inside the selection that keeps it applies at once, one that drops it waits, though its words read the same; fails_when=a Citation the User didn't point at goes without them, or one kept makes the change wait
  it("lets a change that drops a Citation outside the selection wait", async () => {
    const asked = async (keep: boolean) => {
      let status = "";
      const run = runner(async (agent, request) => {
        const mindId = mindIdOf(request);
        const read = structured<{ markdown: string; version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        const line = read.markdown.split("\n").find((each) => each.includes("212,000")) ?? "";
        const token = line.match(/\[cite:[a-z0-9]+\]/)?.[0] ?? "";
        expect(token).not.toBe("");
        const done = structured<{ status: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: read.version,
              changes: [
                {
                  paragraph: line.match(/¶\d+/)?.[0] ?? "¶9",
                  text: `The ferry carried 212,000 PASSENGERS in 2025.${keep ? token : ""}`,
                },
              ],
            },
          }),
        );
        status = done.status;
        return { kind: "finished", reply: "" };
      });
      const { core, mindId, ended, selectionOf } = await written(run.adapter, { cited: true });
      const [block] = selectionOf(0, "passengers");
      if (!block) throw new Error("No selection.");
      // As the window reads the text after the words: the Citation after the sentence as one mark.
      await core.askInNote({
        mindId,
        words: "capitals",
        quote: "passengers",
        selection: [{ ...block, after: `${block.after}${NODE_CHARACTER}` }],
      });
      const applied = (await ended())?.applied.length;
      return { status, applied };
    };
    expect(await asked(true)).toEqual({ status: "applied", applied: 1 });
    expect(await asked(false)).toEqual({ status: "waiting", applied: 0 });
  });

  // protects=with words selected, a call that changes more of the Note asked from waits for the User, and says why; a change to another Note always waits; fails_when=a change beyond what the User pointed at applies without them
  it("lets a change beyond the selection, or in another Note, wait", async () => {
    let why = "";
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      const done = await rewrite(agent, mindId, [
        [FERRY, "The ferry carried about 212,000 people in 2025."],
        [FARES, "Fares rose by a tenth."],
      ]);
      expect(done.status).toBe("waiting");
      why = done.why ?? "";
      return { kind: "finished", reply: "" };
    });
    const { core, mindId, client, ended, selectionOf } = await written(run.adapter);
    await core.askInNote({
      mindId,
      words: "people",
      selection: selectionOf(0, "212,000 passengers"),
    });
    const end = await ended();
    expect(end?.applied).toEqual([]);
    expect(end?.waiting).toEqual([{ mindId, title: "Ferry notes", count: expect.any(Number) }]);
    expect(why).toBe(translate("en", "agents.propose.outsideSelection"));
    await client.settled();
    expect(shownWithChanges(client).join("\n")).toContain("{+");

    const elsewhere = runner(async (agent) => {
      const done = await rewrite(agent, other.otherId, [[FARES, "Fares rose by a tenth."]]);
      expect(done.status).toBe("waiting");
      return { kind: "finished", reply: "" };
    });
    const other = await written(elsewhere.adapter);
    await other.core.askInNote({ mindId: other.mindId, words: "fix the fares note too" });
    const otherEnd = await other.ended();
    expect(otherEnd?.applied).toEqual([]);
    expect(otherEnd?.waiting).toEqual([
      { mindId: other.otherId, title: "Fares", count: expect.any(Number) },
    ]);
  });

  // protects=one conversation per Note: the first request starts it under an id IncarnaMind makes, every later one continues it in the same working folder; a conversation the agent no longer has starts anew once, and says so; fails_when=a follow-up starts a new conversation, or a cleared one fails the request
  it("continues the Note's conversation, and starts a new one once when it is gone", async () => {
    let lose = false;
    const run = runner(async (_agent, request) => {
      if (lose && request.conversation?.resume)
        return { kind: "failed", reason: "lost-conversation" };
      return { kind: "finished", reply: "Done." };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "make it shorter" });
    await ended(1);
    await core.askInNote({ mindId, words: "and the next paragraph" });
    await ended(2);
    const [first, second] = run.runs;
    expect(first?.conversation).toMatchObject({ resume: false });
    expect(second?.conversation).toEqual({ ...first?.conversation, resume: true });

    lose = true;
    await core.askInNote({ mindId, words: "once more" });
    const third = await ended(3);
    expect(third).toMatchObject({ state: "landed", fresh: true });
    const [, , lost, again] = run.runs;
    expect(lost?.conversation?.resume).toBe(true);
    expect(again?.conversation).toMatchObject({ key: first?.conversation?.key, resume: false });
    expect(again?.conversation?.sessionId).not.toBe(first?.conversation?.sessionId);
    expect((await core.noteConversation(mindId)).map((turn) => turn.request)).toEqual([
      "make it shorter",
      "and the next paragraph",
      "once more",
    ]);
  });

  // protects=Stop ends the run and leaves the Note as it was; fails_when=a stopped request changes the Note or keeps running
  it("stops on Stop, and leaves the Note as it was", async () => {
    const { core, mindId, client, ended } = await written(runner(untilStopped).adapter);
    await core.askInNote({ mindId, words: "rewrite everything" });
    await core.stopInNote(mindId);
    expect(await ended()).toMatchObject({ state: "stopped", applied: [] });
    await client.settled();
    expect(shownWithChanges(client)).toEqual([FERRY, FARES]);
  });

  // protects=a lost connection or a consent taken back ends the run with its reason, and deletes the connection's conversations, the agent's copy too; fails_when=a run goes on without its connection or consent, or its conversation stays on disk
  it("ends with the connection or the consent, and deletes the conversation", async () => {
    const away = runner(untilStopped);
    const gone = await written(away.adapter);
    await gone.core.askInNote({ mindId: gone.mindId, words: "shorter" });
    await gone.core.disconnectAgent(gone.claude.pairing.id);
    expect(await gone.ended()).toMatchObject({ state: "failed", problem: "access" });
    await expect.poll(() => away.purged.length).toBe(1);
    expect(away.purged[0]).toBe(away.runs[0]?.conversation?.key);
    expect(await gone.core.noteConversation(gone.mindId)).toEqual([]);

    const back = runner(untilStopped);
    const taken = await written(back.adapter);
    await taken.core.askInNote({ mindId: taken.mindId, words: "shorter" });
    await taken.core.revokeConsent("hosted-agents", `agent:${taken.claude.pairing.id}`);
    expect(await taken.ended()).toMatchObject({ state: "failed", problem: "taken-back" });
    await expect.poll(() => back.purged).toEqual([back.runs[0]?.conversation?.key]);
  });

  // protects=a connection that may only read ends a request that would change something with the line that offers to let it propose, and a request that only reads still answers, its Markdown kept for the conversation to show; fails_when=the read-only refusal shows as a generic failure, an explanation is refused, or its answer loses its structure
  it("says a read-only connection may only read, and still answers what only reads", async () => {
    let explain = false;
    const run = runner(async (agent, request) => {
      if (explain) {
        return { kind: "finished", reply: "It counts **each crossing**:\n- out\n- and back" };
      }
      refusal(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mindIdOf(request),
            version: "v",
            changes: [{ paragraph: "¶1", text: "x" }],
          },
        }),
      );
      return { kind: "finished", reply: "I can't change it." };
    });
    const { core, mindId, ended } = await written(run.adapter, { readOnly: true });
    await core.askInNote({ mindId, words: "shorter" });
    expect(await ended(1)).toMatchObject({ state: "failed", problem: "read-only" });
    explain = true;
    await core.askInNote({ mindId, words: "explain this" });
    // Kept as the AI wrote it: the conversation shows its Markdown, the line its first words.
    const answer = "It counts **each crossing**:\n- out\n- and back";
    expect(await ended(2)).toMatchObject({ state: "landed", reply: answer });
    expect((await core.noteConversation(mindId)).at(-1)?.reply).toBe(answer);
  });

  // protects=a Folder linking made and the User gave the connection is read in a Note's conversation as by any other call of that connection, and one it wasn't given isn't (#3613); fails_when=the conversation finds the linked folder's file where a call doesn't, or misses it where a call finds it
  it("reads a Folder linking made as the connection's other calls do", async () => {
    const found: string[][] = [];
    const search = async (agent: Agent) =>
      structured<{ passages: { documentId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "timetable ferry Tuesday" } }),
      ).passages.map((each) => each.documentId);
    const run = runner(async (agent) => {
      found.push(await search(agent));
      return { kind: "finished", reply: "Found it." };
    });
    const { core, mindId, claude, ended } = await written(run.adapter);
    const folder = await createSourceFolder();
    await writeSourceFile(folder, "Timetable.md", `# Timetable\n\n${TIMETABLE}\n`);
    const linked = await core.addLinkedFolder(folder);
    await core.reconcileDocuments();
    const [timetable] = await waitForProcessing(
      core,
      (await core.listDocuments({ linkedFolderId: linked.id })).map((each) => each.id),
    );
    if (!linked.bound || !timetable) throw new Error("Linking made no Folder.");
    const call = await connectLegacyAgent(claude.launch);

    expect(await search(call)).not.toContain(timetable.id);
    await core.askInNote({ mindId, words: "when does the ferry run on Tuesday?" });
    await ended(1);
    expect(found[0]).not.toContain(timetable.id);

    await core.updateAgent(claude.pairing.id, {
      folderIds: [...claude.pairing.folderIds, linked.bound.folder.id],
    });
    expect(await search(call)).toContain(timetable.id);
    await core.askInNote({ mindId, words: "when does the ferry run on Tuesday?" });
    await ended(2);
    expect(found[1]).toContain(timetable.id);
  });

  // protects=the run has the connection's Tools but no file by its path: cite's path, a hand-over and a Canvas's files are refused; fails_when=a request at a Note's foot opens a file the User never gave it
  it("opens no file by its path", async () => {
    const tried: string[] = [];
    const folder = await createSourceFolder();
    const picture = join(folder, "chart.png");
    await writeFile(
      picture,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    let pictureLeftOut: unknown[] = [];
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      const read = structured<{ markdown: string; version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      pictureLeftOut = structured<{ refused: unknown[] }>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId,
            version: read.version,
            changes: [
              {
                paragraph: `${read.markdown.match(/¶\d+/g)?.at(-1) ?? "¶1"}+`,
                text: `![Chart](${picture})`,
              },
            ],
          },
        }),
      ).refused;
      tried.push(
        refusal(
          await agent.callTool({
            name: "cite",
            arguments: { citations: [{ path: "/etc/hosts", quote: "localhost" }] },
          }),
        ),
        refusal(
          await agent.callTool({ name: "hand_over_file", arguments: { path: "/etc/hosts" } }),
        ),
        refusal(
          await agent.callTool({
            name: "publish_canvas",
            arguments: { title: "Page", html: "<p>Hi</p>", files: ["/etc/hosts"] },
          }),
        ),
      );
      return { kind: "finished", reply: "" };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "cite my hosts file" });
    await ended();
    expect(tried).toEqual(Array(3).fill(translate("en", "agents.problem.runNoPath")));
    // A picture by its path is left out, unread.
    expect(pictureLeftOut).toHaveLength(1);
    expect((await core.listDocuments()).map((each) => each.name)).not.toContain("hosts");
  });

  // protects=a connection allowed only to check is asked once more, at its first request at a Note's foot, what that sends; a check on it asks nothing; fails_when=the request goes without the User's yes to its words, or a check asks again
  it("asks once more for what a request sends, of a connection allowed only to check", async () => {
    const run = runner(async () => ({ kind: "finished", reply: "Done." }));
    const { core, mindId, dataDir, ended } = await written(run.adapter);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `UPDATE data_flow_consents SET data_kinds = '["scoped-passages","scoped-minds"]'
         WHERE flow = 'hosted-agents' AND deleted_at IS NULL`,
      );
    } finally {
      db.close();
    }
    const asked: string[] = [];
    core.on("consent.requested", (request) => {
      asked.push(request.flow.id);
      void core.respondToConsent(request.requestId, true);
    });
    expect((await core.checkWithOwnAi(mindId)).kind).toBe("started");
    expect(asked).toEqual([]);
    await core.stopOwnAiCheck(mindId);
    expect((await core.askInNote({ mindId, words: "shorter" })).kind).toBe("started");
    expect(asked).toEqual(["hosted-agents"]);
    await ended();
    await core.askInNote({ mindId, words: "and again" });
    await ended(2);
    expect(asked).toEqual(["hosted-agents"]);
  });

  // protects=the Note deleted for good deletes its conversation, IncarnaMind's record and the agent's copy; Recently deleted keeps it; fails_when=a conversation outlives its Note
  it("deletes the conversation with its Note", async () => {
    const run = runner(async () => ({ kind: "finished", reply: "Done." }));
    const { core, mindId, dataDir, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "shorter", quote: "212,000 passengers" });
    await ended();
    await core.deleteMind(mindId);
    expect(run.purged).toEqual([]);
    await core.deletePermanently([{ kind: "mind", id: mindId }]);
    expect(run.purged).toEqual([run.runs[0]?.conversation?.key]);
    expect(await core.noteConversation(mindId)).toEqual([]);
    // What the User typed and selected, and the reply, are gone from IncarnaMind's record too.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      expect(db.all("SELECT request, selection, reply FROM own_ai_turns")).toEqual([
        { request: "", selection: "", reply: "" },
      ]);
    } finally {
      db.close();
    }
  });
});
