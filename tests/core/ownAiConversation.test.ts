/**
 * A request typed at a Note's foot, run on the User's own Claude Code in the background, in the
 * Note's one conversation (ADR-0034, #3627). The runner here stands in for the command line: it
 * connects through the shim with the launch IncarnaMind gave it, as `claude` would, and calls the
 * Tools. A change to the Note asked from applies at once (inside the selection, if any), any other
 * waits; the conversation continues; Stop, a lost connection and a consent taken back end it; and
 * the conversation goes with the Note, the connection and the consent.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { OwnAiAsk, OwnAiRunner, OwnAiStatus } from "../../src/core/adapters";
import type {
  AgentLaunch,
  NoteAction,
  NoteAnswer,
  NoteSelectionBlock,
  NoteTurnEvent,
} from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { translate } from "../../src/shared/i18n";
import { NODE_CHARACTER } from "../../src/shared/proposals";
import {
  agentsAdapter,
  buildAgentShim,
  connectLegacyAgent,
  connectModernAgent,
  startAgentsCore,
} from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, shownWithChanges, writeMind } from "../helpers/minds";
import { plainDeck } from "../helpers/pptx";

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
      // As the command line does, once the request is on its way to the model.
      request.started?.();
      return act(await connect(request.server), request);
    },
  };
  return { adapter, runs, purged };
}

interface Gate {
  shut: Promise<void>;
  open(): void;
  at: Promise<void>;
  reached(): void;
}

/** A promise to hold a step at, and how to let it go. */
function gate(): Gate {
  let open = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const at = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return { shut, open: () => open(), at, reached: () => reached() };
}

/** A paragraph of the User's holding a Citation the agent can't cite, a footnote and a formula. */
const heldParagraph = () => ({
  type: "paragraph",
  attrs: { id: "held" },
  content: [
    { type: "text", text: "Spring tides delay the ferry " },
    {
      type: "citation",
      attrs: {
        passageId: "passage-tides",
        documentId: "tides",
        documentName: "Tides",
        contentHash: "hash-tides",
        quote: "Spring tides.",
        check: "found",
      },
    },
    {
      type: "footnote",
      attrs: { id: "n1" },
      content: [{ type: "text", text: "Counted at the quay." }],
    },
    { type: "text", text: " by " },
    { type: "inlineMath", attrs: { latex: "x" } },
    { type: "text", text: " minutes." },
  ],
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = { title: "Ferry page", html: "<p>The ferry carried passengers.</p>" };

/** The models Claude Code lists in its `initialize` answer, as the run hears them. */
const MODELS = [
  {
    value: "default",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Default (recommended)",
    description: "Sonnet 5.5",
  },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "" },
];

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
    held,
  }: { readOnly?: boolean; cited?: boolean; quietMs?: number; held?: Gate } = {},
) {
  const files = createCanvasFiles(join(await createTempDataFolder(), "Canvases"));
  // `held`: a page's files are written only once it opens, so its call runs until then.
  const canvasFiles = held
    ? {
        ...files,
        async write(hash: string, bytes: Uint8Array) {
          held.reached();
          await held.shut;
          await files.write(hash, bytes);
        },
      }
    : files;
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
    sources,
    reportId: report.id,
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
    // Its steps, in order, for the conversation: its own lines and each call, the reading naming
    // its Document; and how many Documents its searches found, for "Reading 1 of 1".
    const last = working.at(-1);
    expect(last?.steps).toEqual([
      { kind: "said", text: "I" },
      { kind: "said", text: "Reading the report" },
      { kind: "call", tool: "search", summary: "ferry passengers", done: true },
      { kind: "call", tool: "read_passages", summary: "Report", documentId: expect.any(String) },
    ]);
    expect(last?.documentsFound).toBe(1);
  });

  // protects=a run that has sent nothing for a while is said to be quiet, and no longer once it sends again; fails_when=the line stays the same for minutes with nothing to say the AI is silent
  it("says when the AI has sent nothing for a while", async () => {
    let saidAt = 0;
    const run = runner(async (_agent, request) => {
      saidAt = performance.now();
      request.progress?.({ kind: "said", text: "Reading the report" });
      await pause(900);
      request.progress?.({ kind: "heard" });
      await pause(500);
      return { kind: "finished", reply: "The ferry carried 212,000 passengers." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter, { quietMs: 300 });
    let quietAt = 0;
    core.on("agents.noteTurn", (turn) => {
      if (turn.quiet && quietAt === 0) quietAt = performance.now();
    });
    await core.askInNote({ mindId, words: "what does the report say about the ferry?" });
    expect(await ended()).toMatchObject({ state: "landed", quiet: false });
    const working = turns.filter((turn) => turn.state === "working");
    const quiet = working.findIndex((turn) => turn.quiet);
    expect(working[quiet]?.doing).toEqual({ kind: "said", text: "Reading the report" });
    expect(quietAt - saidAt).toBeGreaterThanOrEqual(280);
    expect(working.slice(quiet + 1).some((turn) => !turn.quiet)).toBe(true);
  });

  // protects=while the AI condenses its conversation, the line says so and not that the AI is quiet, and goes back to the run's own line after; fails_when=a compaction reads as the AI gone silent
  it("says it condenses the conversation, not that the AI is quiet, while it does", async () => {
    const run = runner(async (_agent, request) => {
      request.progress?.({ kind: "compacting" });
      await pause(1_200);
      request.progress?.({ kind: "compacted" });
      // Long enough for the windows to hear it, not for the quiet limit to pass.
      await pause(300);
      return { kind: "finished", reply: "OK." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter, { quietMs: 600 });
    await core.askInNote({ mindId, words: "anything new?" });
    expect(await ended()).toMatchObject({ state: "landed" });
    const doings = turns.filter((turn) => turn.state === "working").map((turn) => turn.doing);
    expect(doings).toContainEqual({ kind: "compacting" });
    expect(doings.at(-1)).toEqual({ kind: "thinking" });
    expect(turns.filter((turn) => turn.quiet)).toEqual([]);
  });

  // protects=once condensing is over, the line says the AI is quiet again when it is; fails_when=a run silent after compacting shows a line that never changes
  it("says the AI is quiet again after condensing, when it is", async () => {
    const run = runner(async (_agent, request) => {
      request.progress?.({ kind: "compacting" });
      await pause(200);
      request.progress?.({ kind: "compacted" });
      await pause(1_200);
      return { kind: "finished", reply: "OK." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter, { quietMs: 600 });
    await core.askInNote({ mindId, words: "anything new?" });
    expect(await ended()).toMatchObject({ state: "landed" });
    const working = turns.filter((turn) => turn.state === "working");
    const condensed = working.findIndex((turn) => turn.doing?.kind === "compacting");
    expect(condensed).toBeGreaterThanOrEqual(0);
    expect(working.slice(condensed).some((turn) => turn.quiet)).toBe(true);
  });

  // protects=a compaction that didn't finish in time ends the request with its own plain reason; fails_when=it reads as the AI gone silent, or as a generic failure
  it("ends with its own reason when condensing didn't finish", async () => {
    const run = runner(async () => ({ kind: "failed", reason: "compaction" }));
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "anything new?" });
    expect(await ended()).toMatchObject({ state: "failed", problem: "compaction" });
  });

  // protects=while a call of the run runs in IncarnaMind, however long, the line doesn't say the AI is quiet: it waits on IncarnaMind; fails_when=the User reads that their AI is silent while IncarnaMind is the one at work
  it("doesn't say the AI is quiet while a call of it runs here", async () => {
    const held = gate();
    const run = runner(async (agent) => {
      const published = agent.callTool({ name: "publish_canvas", arguments: PAGE });
      await held.at;
      await pause(900);
      held.open();
      await published;
      return { kind: "finished", reply: "Made a page." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter, { quietMs: 300, held });
    await core.askInNote({ mindId, words: "make a page of the ferry figures" });
    expect(await ended()).toMatchObject({ state: "landed" });
    expect(turns.filter((turn) => turn.quiet)).toEqual([]);
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
    const held = gate();
    const run = runner(async (agent) => {
      // Left running: the run's end closes its connection under it, and the call still finishes.
      agent
        .callTool({ name: "publish_canvas", arguments: PAGE })
        .catch((error: unknown) => expect(String(error)).toMatch(/Connection closed/));
      await held.at;
      return { kind: "failed", reason: "stalled" };
    });
    const { core, mindId, turns, ended } = await written(run.adapter, { quietMs: 300, held });
    await core.askInNote({ mindId, words: "anything new?" });
    expect(await ended()).toMatchObject({ state: "failed", problem: "stalled" });
    // The call reached IncarnaMind before the end, and ends after it; then the quiet limit passes.
    held.open();
    await expect.poll(async () => (await core.listCanvases()).length).toBe(1);
    await pause(700);
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

  // protects=this run's own rewrite reads back with the Citation and footnote it keeps by handle and its inline formula, and a paragraph it adds with its Citation as a token and its formula, as an ordinary read gives them; fails_when=the agent reads its own paragraphs without their Citations, footnotes or formulas, and may write them again
  it("reads its own paragraphs back with their Citations, footnotes and formulas", async () => {
    const seen: { again?: string; cite?: string } = {};
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      const found = structured<{ passages: { passageId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "ferry passengers 2025" } }),
      ).passages;
      seen.cite =
        structured<{ citations: { cite: string | null }[] }>(
          await agent.callTool({
            name: "cite",
            arguments: { citations: found.map(({ passageId }) => ({ passageId, quote: FERRY })) },
          }),
        ).citations.find((each) => each.cite !== null)?.cite ?? "";
      const read = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: read.version,
          changes: [
            {
              paragraph: "¶1",
              text: "Spring tides delay the ferry [kept:1] [note:1] by $x+1$ minutes.",
            },
            { paragraph: "¶1+", text: `The report counts them. ${FERRY} ${seen.cite} by $y^2$.` },
          ],
        },
      });
      seen.again = structured<{ markdown: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      ).markdown;
      return { kind: "finished", reply: "Done." };
    });
    const { core, mindId, client, ended } = await written(run.adapter);
    writeMind(client, [heldParagraph(), note(FARES)]);
    await client.settled();
    await core.askInNote({ mindId, words: "rewrite the first paragraph and add the count" });
    await ended();
    const yours = translate("en", "agents.mind.yours");
    expect(seen.again).toContain(
      `¶1 ${yours} Spring tides delay the ferry [kept:1] [note:1] by $x+1$ minutes.`,
    );
    expect(seen.again).toContain(
      `${yours} The report counts them. ${FERRY} ${seen.cite} by $y^2$.`,
    );
  });

  // protects=a whole paragraph this run takes out reads as taken out by it, under its own name, in the Note asked from; a second change to it is refused as the run's own; in another Note, where the removal waits for the User, it reads as waiting with its words; fails_when=the paragraph reads as words this request keeps, or as an empty paragraph of its own
  it("reads a paragraph it took out as taken out, and one waiting elsewhere as waiting", async () => {
    let otherId = "";
    const seen: { result?: string; again?: string; twice?: string; elsewhere?: string } = {};
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      const read = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      const done = structured<{ status: string; markdown: string }>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId,
            version: read.version,
            changes: [{ paragraph: "¶2", remove: true }],
          },
        }),
      );
      expect(done.status).toBe("applied");
      seen.result = done.markdown;
      const again = structured<{ markdown: string; version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      seen.again = again.markdown;
      seen.twice = refusal(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId,
            version: again.version,
            changes: [{ paragraph: "¶2", text: "Fares rose by a tenth." }],
          },
        }),
      );
      const other = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: otherId, named: true } }),
      );
      seen.elsewhere = structured<{ status: string; markdown: string }>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: otherId,
            version: other.version,
            changes: [{ paragraph: "¶1", remove: true }],
          },
        }),
      ).markdown;
      return { kind: "finished", reply: "Done." };
    });
    const paired = await written(run.adapter);
    otherId = paired.otherId;
    await paired.core.askInNote({ mindId: paired.mindId, words: "drop the fares" });
    await paired.ended();
    const removed = translate("en", "agents.mind.yoursRemoved");
    const yours = translate("en", "agents.mind.yours");
    for (const markdown of [seen.result, seen.again]) {
      expect(markdown).toContain(`¶2 ${removed}`);
      expect(markdown).not.toContain(FARES);
      expect(markdown).not.toContain(`¶2 ${yours}`);
    }
    expect(seen.twice).toBe(translate("en", "agents.problem.yours", { paragraph: "¶2" }));
    expect(seen.elsewhere).toContain(`¶1 ${translate("en", "agents.mind.waiting")} ${FARES}`);
    expect(seen.elsewhere).not.toContain(removed);
    expect(translate("zh-CN", "agents.mind.yoursRemoved")).not.toBe(removed);
  });

  // protects=a change that applies at once in the Note asked from reads, in the same run, as in the Note: in the result and in a later read, with the Note's names and version; a second change to that paragraph is refused as the agent's own, never as one for the User to accept; a change that waits, here or in another Note, and an outside agent's, read as waiting; fails_when=the agent is shown the Note as if its change hadn't landed, and may write it again
  it("reads the Note with this request's own change in, and never as if it hadn't landed", async () => {
    const seen: Record<string, unknown> = {};
    let outside: Agent | null = null;
    let otherId = "";
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      const found = structured<{ passages: { passageId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "ferry passengers 2025" } }),
      ).passages;
      const cite =
        structured<{ citations: { cite: string | null }[] }>(
          await agent.callTool({
            name: "cite",
            arguments: { citations: found.map(({ passageId }) => ({ passageId, quote: FERRY })) },
          }),
        ).citations.find((each) => each.cite !== null)?.cite ?? "";
      seen.cite = cite;
      const read = structured<{ markdown: string; version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      const done = structured<{ status: string; markdown: string; version: string }>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId,
            version: read.version,
            changes: [
              { paragraph: "¶2", text: "Fares rose by a tenth." },
              {
                paragraph: "¶2+",
                text: `The council meets the ferry company in January. ${FERRY} ${cite}`,
              },
            ],
          },
        }),
      );
      seen.result = done;
      // Meanwhile an outside agent over the connection reads the Note as it is: the change waits.
      seen.outside = outside
        ? structured<{ markdown: string }>(
            await outside.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
          )
        : null;
      // A change this run makes in another Note waits there, and reads as waiting.
      const other = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: otherId, named: true } }),
      );
      seen.elsewhere = structured<{ status: string; markdown: string }>(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: otherId,
            version: other.version,
            changes: [{ paragraph: "¶1", text: "Fares rose by a tenth." }],
          },
        }),
      );
      seen.again = structured<{ markdown: string; version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      seen.twice = refusal(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId,
            version: (seen.again as { version: string }).version,
            changes: [{ paragraph: "¶2", text: "Fares rose by a tenth." }],
          },
        }),
      );
      return { kind: "finished", reply: "Shortened the fares." };
    });
    const paired = await written(run.adapter);
    const { core, mindId, client, ended, claude } = paired;
    otherId = paired.otherId;
    outside = await connectLegacyAgent(claude.launch);
    await core.askInNote({ mindId, words: "shorten the fares and add the January meeting" });
    const end = await ended();
    const yours = translate("en", "agents.mind.yours");
    const waiting = translate("en", "agents.mind.waiting");
    const result = seen.result as { status: string; markdown: string; version: string };
    const again = seen.again as { markdown: string; version: string };
    expect(result.status).toBe("applied");
    // The result and a later read show the change in, marked as this request's own: not waiting,
    // its Citation read back as a token, as an ordinary read gives it.
    for (const markdown of [result.markdown, again.markdown]) {
      expect(markdown).toContain(`¶2 ${yours} Fares rose by a tenth.`);
      expect(markdown).toContain(`${yours} The council meets the ferry company in January.`);
      expect(markdown).toMatch(
        new RegExp(
          `${yours.replace(/[()]/g, "\\$&")} The council meets[^\\n]*\\[cite:[a-z0-9]+\\]`,
        ),
      );
      expect(markdown).not.toContain(waiting);
      expect(markdown).not.toContain(FARES);
    }
    // An outside agent reads the Note as it is meanwhile; another Note's change waits there.
    expect((seen.outside as { markdown: string }).markdown).toContain(`¶2 ${waiting} ${FARES}`);
    const elsewhere = seen.elsewhere as { status: string; markdown: string };
    expect(elsewhere.status).toBe("waiting");
    expect(elsewhere.markdown).toContain(`¶1 ${waiting}`);
    expect(elsewhere.markdown).not.toContain(yours);
    // Its names and version are the Note's, so a next change is placed as it reads.
    expect(again.version).toBe(result.version);
    expect(seen.twice).toBe(translate("en", "agents.problem.yours", { paragraph: "¶2" }));
    expect(seen.twice).not.toContain("Accept or reject");
    // The window that asked puts it in once the request ends: once, the paragraph added once.
    await core.applyAskedChanges({
      answerId: end?.turnId ?? "",
      mindId,
      requests: (end?.applied ?? []).map((each) => each.request),
    });
    await client.settled();
    await client.settled();
    expect(shownWithChanges(client).slice(0, 2)).toEqual([FERRY, "Fares rose by a tenth."]);
    expect(shownWithChanges(client)).toHaveLength(3);
    expect(shownWithChanges(client)[2]).toContain(
      "The council meets the ferry company in January.",
    );
  });

  // protects=after Stop the change stays waiting, and the next request reads it truthfully as waiting, not as its own; fails_when=a later run reads another run's change as in the Note
  it("reads a stopped request's change as waiting in the next request", async () => {
    let first = true;
    let read = "";
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      if (first) {
        first = false;
        const named = structured<{ version: string }>(
          await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
        );
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId,
            version: named.version,
            changes: [{ paragraph: "¶2", text: "Fares rose by a tenth." }],
          },
        });
        return untilStopped(agent, request);
      }
      read = structured<{ markdown: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      ).markdown;
      return { kind: "finished", reply: "Read it." };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "shorten the fares" });
    await expect.poll(() => run.runs.length).toBe(1);
    await pause(300);
    await core.stopInNote(mindId);
    await ended();
    await core.askInNote({ mindId, words: "what does it say now?" });
    await ended(2);
    expect(read).toContain(`¶2 ${translate("en", "agents.mind.waiting")} ${FARES}`);
    expect(read).not.toContain(translate("en", "agents.mind.yours"));
  });

  // protects=a change that waits reads as waiting, to the run that made it and to an outside agent over the connection, as before; fails_when=a waiting change reads as in the Note
  it("reads a change that waits as waiting, here, in another Note and to an outside agent", async () => {
    const results: { status: string; markdown: string }[] = [];
    const run = runner(async (agent, request) => {
      const mindId = mindIdOf(request);
      const read = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      results.push(
        structured(
          await agent.callTool({
            name: "propose_changes",
            arguments: {
              mindId,
              version: read.version,
              changes: [{ paragraph: "¶2", text: "Fares rose by a tenth." }],
            },
          }),
        ),
      );
      return { kind: "finished", reply: "" };
    });
    const { core, mindId, claude, ended, selectionOf, otherId } = await written(run.adapter);
    // Beyond the words selected: it waits.
    await core.askInNote({
      mindId,
      words: "fix the fares",
      selection: selectionOf(0, "212,000 passengers"),
    });
    await ended();
    const waiting = translate("en", "agents.mind.waiting");
    expect(results[0]?.status).toBe("waiting");
    expect(results[0]?.markdown).toContain(`¶2 ${waiting}`);
    expect(results[0]?.markdown).not.toContain(translate("en", "agents.mind.yours"));
    // An outside agent over the connection, in the other Note: it waits, as before.
    const agent = await connectLegacyAgent(claude.launch);
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: otherId, named: true } }),
    );
    const outside = structured<{ status: string; markdown: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: otherId,
          version: read.version,
          changes: [{ paragraph: "¶1", text: "Fares rose by a tenth." }],
        },
      }),
    );
    expect(outside.status).toBe("waiting");
    expect(outside.markdown).toContain(`¶1 ${waiting}`);
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

  // protects=looking for the models starts nothing of the User's agent, with or without the consent; the list comes from a request's own run, which asks for it, and shows only while a request from the Note could run; fails_when=the list starts the agent, shows before a run answered it, or outlives the consent or the connection
  it("lists the models a request's run heard, and starts nothing to look", async () => {
    let calls = 0;
    const run = runner(async (_agent, request) => {
      request.progress?.({ kind: "models", models: MODELS });
      return { kind: "finished", reply: "Done." };
    });
    const counted: OwnAiRunner = {
      ...run.adapter,
      installed: async () => {
        calls += 1;
        return true;
      },
      status: async () => {
        calls += 1;
        return { kind: "ready" };
      },
    };
    const { core, mindId, claude } = await written(counted);
    await core.revokeConsent("hosted-agents", `agent:${claude.pairing.id}`);
    expect(await core.noteModels(mindId)).toEqual([]);
    expect(calls).toBe(0);
    expect(run.runs).toEqual([]);

    const given = await written(counted);
    calls = 0;
    expect(await given.core.noteModels(given.mindId)).toEqual([]);
    expect(calls).toBe(0);
    await given.core.askInNote({ mindId: given.mindId, words: "shorter" });
    await given.ended();
    expect(run.runs.at(-1)?.listModels).toBe(true);
    expect(await given.core.noteModels(given.mindId)).toEqual(MODELS);
    await given.core.revokeConsent("hosted-agents", `agent:${given.claude.pairing.id}`);
    expect(await given.core.noteModels(given.mindId)).toEqual([]);
  });

  // protects=a reply's Citation is shown as one only when IncarnaMind gave that token to this connection; a made-up token is not; fails_when=a token the agent made up, or one of another connection, reaches the conversation as a Citation
  it("keeps only the reply's Citations IncarnaMind gave this connection", async () => {
    const run = runner(async (agent) => {
      const found = structured<{ passages: { passageId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "ferry passengers 2025" } }),
      ).passages;
      const { citations } = structured<{ citations: { cite: string | null }[] }>(
        await agent.callTool({
          name: "cite",
          arguments: {
            citations: found.map(({ passageId }) => ({ passageId, quote: FERRY })),
          },
        }),
      );
      const given = citations.find((each) => each.cite !== null)?.cite ?? "";
      return {
        kind: "finished",
        reply: `The ferry carried 212,000 passengers.${given} Fares rose.[cite:k3x9a2b7]`,
      };
    });
    const cited = async (each: Awaited<ReturnType<typeof written>>) => {
      await each.core.askInNote({ mindId: each.mindId, words: "what does the report say?" });
      await each.ended();
      const [turn] = await each.core.noteConversation(each.mindId);
      return turn;
    };
    const here = await written(run.adapter);
    const turn = await cited(here);
    expect(turn?.citations).toEqual([
      { token: expect.any(String), documentName: "Report", quote: FERRY },
    ]);
    expect(turn?.reply).toContain(`[cite:${turn?.citations[0]?.token}]`);
    expect(turn?.citations.map((each) => each.token)).not.toContain("k3x9a2b7");

    // Checked again against the Document as it is now: deleted, changed, or out of the
    // connection's reach, it is no Citation any more.
    const citationsNow = async (each: Awaited<ReturnType<typeof written>>) =>
      (await each.core.noteConversation(each.mindId))[0]?.citations ?? [];
    await here.core.deleteDocument(here.reportId);
    expect(await citationsNow(here)).toEqual([]);

    const changed = await written(run.adapter);
    expect((await cited(changed))?.citations).toHaveLength(1);
    await writeSourceFile(changed.sources, "Report.md", "# Report\n\nThe ferry ran all year.\n");
    await addAndProcess(changed.core, [join(changed.sources, "Report.md")]);
    expect(await citationsNow(changed)).toEqual([]);

    const moved = await written(run.adapter);
    expect((await cited(moved))?.citations).toHaveLength(1);
    await moved.core.assignDocumentGroup(moved.reportId, null);
    expect(await citationsNow(moved)).toEqual([]);
  });

  // protects=only a model the User's agent itself offered goes to it as its model; anything else is refused before anything starts; fails_when=a value the renderer sends reaches the command line unchecked
  it("sends only a model the agent offered", async () => {
    const run = runner(async (_agent, request) => {
      request.progress?.({
        kind: "models",
        models: [...MODELS, { ...MODELS[1], value: "haiku\r\ncalc.exe" }] as typeof MODELS,
      });
      return { kind: "finished", reply: "Done." };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await expect(core.askInNote({ mindId, words: "shorter", model: "haiku" })).rejects.toThrow(
      translate("en", "error.agent.askRequest"),
    );
    expect(run.runs).toEqual([]);
    await core.askInNote({ mindId, words: "shorter" });
    await ended();
    expect(run.runs[0]?.model).toBeUndefined();
    await expect(
      core.askInNote({ mindId, words: "shorter", model: "--dangerously-skip-permissions" }),
    ).rejects.toThrow(translate("en", "error.agent.askRequest"));
    expect(run.runs).toHaveLength(1);
    await core.askInNote({ mindId, words: "shorter", model: "haiku" });
    await ended(2);
    expect(run.runs[1]?.model).toBe("haiku");
    // A line break ends the command on Windows' cmd.exe: never sent, even when the agent lists it.
    for (const model of ["haiku\r\ncalc.exe", "sonnet\ncalc.exe"]) {
      await expect(core.askInNote({ mindId, words: "shorter", model })).rejects.toThrow(
        translate("en", "error.agent.askRequest"),
      );
    }
    expect(run.runs).toHaveLength(2);
    expect((await core.noteModels(mindId)).map((each) => each.value)).not.toContain(
      "haiku\r\ncalc.exe",
    );
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
    expect(tried).toEqual(Array(2).fill(translate("en", "agents.problem.runNoPath")));
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

describe("what the User's own AI asks in a Note's conversation, and does with its own tools (#3653)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  const COMMAND: NoteAction = {
    kind: "command",
    value: "python3 late_crossings.py --crossing 07:40 delays-2026.csv",
    inFolder: true,
  };
  const asked = (step: string, action: NoteAction = COMMAND): OwnAiAsk => ({
    step,
    action,
    wider: { rules: ["Bash(python3 late_crossings.py:*)"] },
  });
  /** The command line: asks `question` with its step begun, then ends it as answered. */
  const asking = (question: OwnAiAsk, before?: (request: RunRequest) => void) =>
    runner(async (_agent, request) => {
      before?.(request);
      const step = question.step ?? "";
      request.progress?.({ kind: "own", id: step, action: question.action, state: "going" });
      let answer: NoteAnswer;
      try {
        answer = (await request.own?.ask(question, request.signal)) ?? "deny";
      } catch {
        return { kind: "finished", reply: "" };
      }
      request.progress?.({
        kind: "own",
        id: step,
        action: question.action,
        state: answer === "deny" ? "failed" : "done",
      });
      return { kind: "finished", reply: answer === "deny" ? "Didn't run it." : "Ran it." };
    });
  const waitingIn = (turns: NoteTurnEvent[]) =>
    expect
      .poll(() => turns.at(-1)?.questions.length ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(0)
      .then(() => turns.at(-1)?.questions ?? []);

  // protects=a step of the AI's own that needs the User's yes waits for it in every window, with exactly what it would run and the answers its question offers, and the answer goes back to the AI; the run has its own abilities and IncarnaMind's Tools; fails_when=the step runs unasked, the question is lost, or an answer reaches the wrong question
  it("waits for the User's answer, and gives it to the AI", async () => {
    const run = asking(asked("toolu_1"));
    const { core, mindId, turns, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count the late crossings" });
    const [question] = await waitingIn(turns);
    expect(question).toMatchObject({
      action: COMMAND,
      answers: ["deny", "request", "once"],
      wider: { rules: ["Bash(python3 late_crossings.py:*)"] },
      read: null,
    });
    expect(run.runs[0]?.own).toBeDefined();
    expect(run.runs[0]?.tools).toBe("all");
    // A window opened meanwhile reads it too.
    expect((await core.noteTurnNow(mindId))?.questions).toEqual([question]);
    expect((await core.noteConversation(mindId)).at(-1)?.questions).toEqual([question]);
    await core.answerInNote(mindId, question?.id ?? "", "request");
    const end = await ended();
    expect(end).toMatchObject({ state: "landed", reply: "Ran it.", questions: [] });
    expect(end?.steps).toContainEqual({ kind: "own", action: COMMAND, by: "request" });
  });

  // protects=Deny keeps the step from running and the step says it was denied; an answer the question doesn't offer, or for a question no longer waiting, does nothing; fails_when=a denied step reads as run, or a stray answer allows something
  it("denies, and does nothing with an answer not offered", async () => {
    const run = asking({ ...asked("toolu_1"), wider: null });
    const { core, mindId, turns, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count the late crossings" });
    const [question] = await waitingIn(turns);
    expect(question?.answers).toEqual(["deny", "once"]);
    await core.answerInNote(mindId, question?.id ?? "", "request");
    await core.answerInNote(mindId, "another-question", "once");
    expect((await core.noteTurnNow(mindId))?.questions).toHaveLength(1);
    await core.answerInNote(mindId, question?.id ?? "", "deny");
    const end = await ended();
    expect(end).toMatchObject({ state: "landed", reply: "Didn't run it." });
    expect(end?.steps).toContainEqual({ kind: "own", action: COMMAND, by: "deny" });
  });

  // protects=once a request read text the User didn't write (a web page it opened), nothing it asks after offers the wider answer, and the card says what it read; fails_when=a page can give itself a standing yes for the rest of the request
  it("offers no answer for the rest of the request after it read a page", async () => {
    const page: NoteAction = {
      kind: "web",
      value: "https://kestrelbay-harbour.example/notice",
      host: "kestrelbay-harbour.example",
    };
    const run = asking(asked("toolu_2"), (request) => {
      request.progress?.({ kind: "own", id: "toolu_1", action: page, state: "going" });
      request.progress?.({ kind: "own", id: "toolu_1", action: page, state: "done" });
    });
    const { core, mindId, turns } = await written(run.adapter);
    await core.askInNote({ mindId, words: "check the notice, then count" });
    const [question] = await waitingIn(turns);
    expect(question).toMatchObject({
      answers: ["deny", "once"],
      wider: null,
      read: { kind: "web", host: "kestrelbay-harbour.example" },
    });
    await core.stopInNote(mindId);
  });

  // protects=two questions open at once both wait, oldest first, and each answer goes to its own; fails_when=the second hides the first, or answers cross
  it("keeps two questions apart", async () => {
    const got: NoteAnswer[] = [];
    const run = runner(async (_agent, request) => {
      const ask = (step: string) =>
        request.own?.ask(asked(step), request.signal) ?? Promise.resolve("deny" as const);
      got.push(...(await Promise.all([ask("toolu_1"), ask("toolu_2")])));
      return { kind: "finished", reply: "Both answered." };
    });
    const { core, mindId, turns, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count twice" });
    await expect.poll(() => turns.at(-1)?.questions.length ?? 0, { timeout: 5_000 }).toBe(2);
    const [first, second] = turns.at(-1)?.questions ?? [];
    await core.answerInNote(mindId, second?.id ?? "", "once");
    expect((await core.noteTurnNow(mindId))?.questions).toEqual([first]);
    await core.answerInNote(mindId, first?.id ?? "", "deny");
    await ended();
    expect(got).toEqual(["deny", "once"]);
  });

  // protects=Stop with a question open ends the run, the question goes, and its step says it was stopped before the User answered; an answer racing it does nothing; fails_when=Stop waits on the question, or a late answer reaches the AI
  it("stops with a question open", async () => {
    let signal: AbortSignal | undefined;
    const run = asking(asked("toolu_1"), (request) => {
      signal = request.signal;
    });
    const { core, mindId, turns, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count the late crossings" });
    const [question] = await waitingIn(turns);
    await core.stopInNote(mindId);
    await core.answerInNote(mindId, question?.id ?? "", "once");
    const end = await ended();
    expect(end).toMatchObject({ state: "stopped" });
    expect(signal?.aborted).toBe(true);
    expect(end?.steps).toContainEqual({ kind: "own", action: COMMAND, by: "stopped" });
    expect((await core.noteConversation(mindId)).at(-1)).toMatchObject({
      outcome: "stopped",
      questions: [],
      closed: null,
    });
  });

  // protects=a question open when IncarnaMind closes reads, after the next start, as asked and not run, so it never hangs the conversation; fails_when=the turn says only that it stopped, or reads as still asking
  it("says after a restart what was asked and that it didn't run", async () => {
    const run = asking(asked("toolu_1"));
    const { core, mindId, turns, dataDir } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count the late crossings" });
    await waitingIn(turns);
    await core.close();
    const again = startCore(dataDir, { ownAi: run.adapter, agents: await agentsAdapter(dataDir) });
    try {
      expect((await again.noteConversation(mindId)).at(-1)).toMatchObject({
        request: "count the late crossings",
        outcome: "stopped",
        questions: [],
        closed: { kind: "command", value: COMMAND.value },
      });
    } finally {
      await again.close();
    }
  });

  // protects=the AI's own mode is heard and kept with the request, so the conversation can say once that it asks nothing; fails_when=a mode that asks nothing goes unsaid
  it("keeps the AI's own mode with the request", async () => {
    const run = runner(async (_agent, request) => {
      request.progress?.({ kind: "mode", mode: "auto" });
      request.progress?.({ kind: "own", id: "toolu_1", action: COMMAND, state: "going" });
      request.progress?.({ kind: "own", id: "toolu_1", action: COMMAND, state: "done" });
      return { kind: "finished", reply: "Counted." };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count the late crossings" });
    const end = await ended();
    expect(end).toMatchObject({ mode: "auto" });
    expect(end?.steps).toContainEqual({ kind: "own", action: COMMAND });
    expect((await core.noteConversation(mindId)).at(-1)?.mode).toBe("auto");
  });

  // protects=a deck the AI made with its own tools reaches the Library from the conversation by hand_over_file, as from a paired agent; fails_when=the conversation's grant refuses it
  it("hands a file it made over to the Library", async () => {
    const folder = await mkdtemp(join(tmpdir(), "own-ai-made-"));
    const deck = join(folder, "Ferry delays.pptx");
    await writeFile(deck, plainDeck([{ title: "Ferry delays" }, { lines: [FERRY] }]));
    let handed: unknown = null;
    const run = runner(async (agent) => {
      handed = structured(
        await agent.callTool({ name: "hand_over_file", arguments: { path: deck } }),
      );
      return { kind: "finished", reply: "Handed over." };
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.askInNote({ mindId, words: "make a deck of the delays" });
    await ended();
    expect(handed).toMatchObject({ title: "Ferry delays" });
    expect((await core.listDocuments()).map((each) => each.name)).toContain("Ferry delays");
  });

  // protects=a conversation begun before its AI kept its own abilities, whose kept system prompt said it had none, begins anew once, under a new id, and says so; IncarnaMind's record of it stays; later requests continue the new one; fails_when=it resumes the old one and the AI refuses every tool of its own, or every request starts anew
  it("begins a conversation from before anew, once", async () => {
    const run = runner(async () => ({ kind: "finished", reply: "Done." }));
    const { core, mindId, ended, dataDir, turns } = await written(run.adapter);
    await core.askInNote({ mindId, words: "make it shorter" });
    await ended(1);
    await core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE own_ai_conversations SET renewed = 1");
    } finally {
      db.close();
    }
    const again = startCore(dataDir, { ownAi: run.adapter, agents: await agentsAdapter(dataDir) });
    const told: NoteTurnEvent[] = [];
    again.on("agents.noteTurn", (turn) => told.push(turn));
    const endOf = (count: number) =>
      expect
        .poll(() => told.filter((turn) => turn.state !== "working").length, { timeout: 5_000 })
        .toBe(count)
        .then(() => told.filter((turn) => turn.state !== "working").at(-1));
    try {
      await again.askInNote({ mindId, words: "count the late crossings" });
      expect(await endOf(1)).toMatchObject({ state: "landed", renewed: true, fresh: false });
      await again.askInNote({ mindId, words: "and once more" });
      expect(await endOf(2)).toMatchObject({ state: "landed", renewed: false });
      const [first, renewed, next] = run.runs;
      expect(renewed?.conversation).toMatchObject({ key: first?.conversation?.key, resume: false });
      expect(renewed?.conversation?.sessionId).not.toBe(first?.conversation?.sessionId);
      expect(next?.conversation).toEqual({ ...renewed?.conversation, resume: true });
      expect((await again.noteConversation(mindId)).map((turn) => turn.request)).toEqual([
        "make it shorter",
        "count the late crossings",
        "and once more",
      ]);
      expect(turns.every((turn) => !turn.renewed)).toBe(true);
    } finally {
      await again.close();
    }
  });

  // protects=what the AI asked goes with the conversation; fails_when=a deleted conversation keeps the commands it asked to run
  it("deletes what was asked with the conversation", async () => {
    const run = asking(asked("toolu_1"));
    const { core, mindId, turns, ended, dataDir } = await written(run.adapter);
    await core.askInNote({ mindId, words: "count the late crossings" });
    const [question] = await waitingIn(turns);
    await core.answerInNote(mindId, question?.id ?? "", "once");
    await ended();
    await core.deleteMind(mindId);
    await core.deletePermanently([{ kind: "mind", id: mindId }]);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      expect(db.all("SELECT value, server, answer FROM own_ai_questions")).toEqual([
        { value: "", server: null, answer: "once" },
      ]);
    } finally {
      db.close();
    }
  });
});
