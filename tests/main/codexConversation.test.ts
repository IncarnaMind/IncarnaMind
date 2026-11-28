/**
 * A request of a Note's conversation on the User's own Codex, through its app-server (#3653,
 * ADR-0026): what it starts and with what, each approval Codex asks for as the card's question and
 * each answer back as Codex takes it, the steps it takes unasked, Stop with nothing left running,
 * requests sent meanwhile, and the threads it keeps and deletes. A Node program stands in for
 * `codex app-server` (e2e/fixtures/fakeCodexAppServer.mjs), and another for IncarnaMind's server.
 */
import { spawn as spawnNode } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnAiAsk, OwnAiProgress } from "../../src/core/adapters";
import type { NoteAnswer } from "../../src/core/api";
import { createOwnAi } from "../../src/main/ownAi";
import { processRunning } from "../helpers/processRunning";

const launch = vi.hoisted(() => vi.fn());
/** The login shell's environment, as the launcher reads it: its PATH, and a home of the test's. */
const shell = vi.hoisted(() => ({ PATH: "", HOME: "", CODEX_HOME: "" }));
vi.mock("../../src/main/processes", () => ({
  createLoginShellProcesses: () => ({ spawn: launch, environment: async () => shell }),
}));

const FAKE_CODEX = join(__dirname, "../../e2e/fixtures/fakeCodex.mjs");
const TOKEN = "grant-of-the-test";
const KEY = "c0nversation-1";

let bin: string;
let conversations: string;
/** Every start of `codex`: its arguments, the variables given to it and its folder. */
let starts: { args: string[]; env: Record<string, string>; cwd: string | undefined }[];

beforeEach(async () => {
  bin = await realpath(await mkdtemp(join(tmpdir(), "codex-conversation-")));
  conversations = join(bin, "conversations");
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "codex"), 0o755);
  if (process.platform === "win32") await writeFile(join(bin, "codex.cmd"), "@exit /b 0\r\n");
  shell.PATH = bin;
  shell.HOME = join(bin, "home");
  shell.CODEX_HOME = join(bin, "codex-home");
  starts = [];
  launch.mockImplementation(
    async (
      _command: string,
      args: string[],
      options: { cwd?: string; env?: Record<string, string> },
    ) => {
      starts.push({ args, env: options.env ?? {}, cwd: options.cwd });
      const child = spawnNode(process.execPath, [FAKE_CODEX, ...args], {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode"),
        },
        detached: process.platform !== "win32",
        stdio: "pipe",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      return child;
    },
  );
});

afterEach(async () => {
  launch.mockReset();
  await rm(bin, { recursive: true, force: true });
});

const mode = (value: string) => writeFile(join(bin, "mode"), value);
const jsonLines = async (name: string): Promise<Record<string, unknown>[]> => {
  const file = join(bin, name);
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};
const decisions = async () =>
  (await jsonLines("answers.jsonl")).map((each) => each.result as Record<string, unknown>);
const sent = async (method: string) =>
  (await jsonLines("requests.jsonl"))
    .filter((each) => each.method === method)
    .map((each) => each.params as Record<string, unknown>);

const SERVER = {
  command: process.execPath,
  args: ["/Applications/IncarnaMind.app/agentShim.cjs"],
  env: { INCARNAMIND_AGENT_TOKEN: TOKEN, INCARNAMIND_AGENT_SOCKET: "/tmp/a.sock" },
};
const INSTRUCTIONS = "You are asked from a Note in IncarnaMind.";

/** A request of the conversation `KEY`, answering each question with `answer`. */
function converse({
  answer = async () => "once" as NoteAnswer,
  resume = false,
  signal = new AbortController().signal,
  meanwhile,
}: {
  answer?: (asked: OwnAiAsk, signal: AbortSignal) => Promise<NoteAnswer>;
  resume?: boolean;
  signal?: AbortSignal;
  meanwhile?: (send: (id: string, prompt: string) => void) => void;
} = {}) {
  const steps: OwnAiProgress[] = [];
  const asked: OwnAiAsk[] = [];
  let started = 0;
  const own = createOwnAi({ command: null, codexCommand: "codex", conversations });
  const ended = own.run({
    client: "codex",
    server: SERVER,
    tools: "all",
    own: {
      ask: (question, waiting) => {
        asked.push(question);
        return answer(question, waiting);
      },
      ...(meanwhile && { meanwhile }),
    },
    instructions: INSTRUCTIONS,
    prompt: "In their note “Tides”, the User asks: count the late crossings",
    conversation: { key: KEY, sessionId: "session-1", resume },
    listModels: true,
    progress: (step) => steps.push(step),
    started: () => {
      started++;
    },
    signal,
  });
  return { own, ended, steps, asked, started: () => started };
}

const ownSteps = (steps: OwnAiProgress[]) =>
  steps.flatMap((step) =>
    step.kind === "own" ? [{ id: step.id, kind: step.action.kind, state: step.state }] : [],
  );

describe("a Note's conversation on the User's own Codex (#3653)", () => {
  // protects=the request runs Codex's app-server in the conversation's own folder, with IncarnaMind's server added beside the User's own by the names of its grant's variables, IncarnaMind's instructions added to Codex's, no project AGENTS.md and no prompt history kept; a command Codex asks about is the card's question with exactly what it runs and Codex's own answers, Allow once goes back as Codex's "accept" and the command runs; fails_when=the grant is on the command line, the run is sealed, a project AGENTS.md steers it, or the answer reaches Codex as another
  it("asks before a command, and runs it once allowed", async () => {
    await mode("conv-command");
    const run = converse();
    expect(await run.ended).toEqual({ kind: "finished", reply: "Ran it." });
    const folder = join(conversations, KEY);
    expect(existsSync(join(folder, "marker.txt"))).toBe(true);
    expect(run.asked).toEqual([
      {
        step: expect.stringMatching(/^exec-/),
        action: {
          kind: "command",
          value: "touch marker.txt",
          unsandboxed: true,
          reason: "May I create the marker file?",
        },
        suggested: [
          {
            kind: "rules",
            kept: "everywhere",
            rules: [{ kind: "commands", start: "touch marker.txt" }],
          },
        ],
        forRequest: [],
      },
    ]);
    expect(await decisions()).toEqual([{ decision: "accept" }]);
    expect(ownSteps(run.steps)).toEqual([
      { id: run.asked[0]?.step, kind: "command", state: "going" },
      { id: run.asked[0]?.step, kind: "command", state: "done" },
    ]);
    expect(run.started()).toBe(1);
    const [start] = starts;
    expect(start?.args).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "check_for_update_on_startup=false",
    ]);
    expect(start?.cwd).toBe(folder);
    expect(start?.env).toEqual(SERVER.env);
    expect(start?.args.join(" ")).not.toContain(TOKEN);
    const [opened] = await sent("thread/start");
    expect(opened).toEqual({
      cwd: folder,
      developerInstructions: INSTRUCTIONS,
      config: {
        mcp_servers: {
          incarnamind: { command: SERVER.command, enabled: false },
          incarnamind_note: {
            command: SERVER.command,
            args: SERVER.args,
            env_vars: ["INCARNAMIND_AGENT_TOKEN", "INCARNAMIND_AGENT_SOCKET"],
            default_tools_approval_mode: "approve",
            tool_timeout_sec: 120,
          },
        },
        project_doc_max_bytes: 0,
        history: { persistence: "none" },
        features: { memories: false },
      },
    });
    // The thread is kept out of Codex's memories before anything of the Note reaches it.
    const order = (await jsonLines("requests.jsonl")).map((each) => each.method);
    expect(order.indexOf("thread/memoryMode/set")).toBeGreaterThan(order.indexOf("thread/start"));
    expect(order.indexOf("thread/memoryMode/set")).toBeLessThan(order.indexOf("turn/start"));
    expect(await sent("thread/memoryMode/set")).toEqual([
      { threadId: expect.any(String), mode: "disabled" },
    ]);
    expect(run.steps).toContainEqual({ kind: "mode", mode: "on-request" });
    expect(run.steps).toContainEqual({ kind: "model", model: "gpt-6.2-sol" });
    expect(run.steps).toContainEqual({
      kind: "models",
      models: [
        {
          value: "gpt-6.2-sol",
          resolvedModel: "gpt-6.2-sol",
          displayName: "GPT-6.2 Sol",
          description: "",
        },
      ],
    });
  });

  // protects=Deny goes back as the no Codex offers: "cancel" where it offers no "decline", as Codex 0.170 does, which ends its turn, so the request ends there, finished; the command never runs and its step says it failed; fails_when=a denied command runs, IncarnaMind answers with what Codex didn't offer, or the turn it ended reads as a failure
  it("runs nothing it was denied", async () => {
    await mode("conv-command");
    const run = converse({ answer: async () => "deny" });
    expect(await run.ended).toEqual({ kind: "finished", reply: "" });
    expect(existsSync(join(conversations, KEY, "marker.txt"))).toBe(false);
    expect(await decisions()).toEqual([{ decision: "cancel" }]);
    expect(ownSteps(run.steps).at(-1)).toMatchObject({ state: "failed" });
  });

  // protects=a command that runs in another folder and reaches a site shows both, with Codex's reason, and its answer for this request is the site, as Codex grants it; one asking for more files than its sandbox allows is refused at once with Codex's own no; fails_when=the card shows the command alone while Allow grants a site, the folder is left out, or a request granting more than the card shows waits on the User
  it("shows where a command runs and the site it reaches, and refuses one asking for more", async () => {
    await mode("conv-network");
    const run = converse({ answer: async () => "request" });
    expect(await run.ended).toEqual({ kind: "finished", reply: "Ran it." });
    expect(run.asked[0]?.action).toEqual({
      kind: "command",
      value: "curl -sI https://example.com",
      host: "example.com",
      folder: conversations,
      reason: "It needs the network.",
    });
    expect(run.asked[0]?.forRequest).toEqual([
      { kind: "rules", kept: "request", rules: [{ kind: "site", host: "example.com" }] },
    ]);
    await mode("conv-permissions");
    const more = converse();
    expect(await more.ended).toEqual({ kind: "finished", reply: "Didn't run it." });
    expect(more.asked).toEqual([]);
    expect(await decisions()).toEqual([{ decision: "acceptForSession" }, { decision: "decline" }]);
    expect(more.steps).toContainEqual(expect.objectContaining({ kind: "own", state: "refused" }));
  });

  // protects=Codex's own lasting answer goes back exactly as Codex gave it, and its "for this session" one where it offers it, kept until the request ends; fails_when=IncarnaMind writes a rule of its own making, or offers an answer Codex didn't
  it("gives back Codex's lasting answer and its answer for this request as Codex gave them", async () => {
    await mode("conv-command");
    expect(await converse({ answer: async () => "suggested" }).ended).toMatchObject({
      kind: "finished",
    });
    await mode("conv-session");
    const session = converse({ answer: async () => "request" });
    expect(await session.ended).toMatchObject({ kind: "finished", reply: "Ran it." });
    expect(session.asked[0]).toMatchObject({
      suggested: [],
      forRequest: [
        { kind: "rules", kept: "request", rules: [{ kind: "command", value: "touch marker.txt" }] },
      ],
    });
    expect(await decisions()).toEqual([
      {
        decision: {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "marker.txt"] },
        },
      },
      { decision: "acceptForSession" },
    ]);
  });

  // protects=what Codex does without asking, as its own settings allow, shows as steps that go and end, each with what it ran or wrote, never as a question; fails_when=an unasked step is hidden, or waits on the User
  it("shows each step it takes unasked", async () => {
    await mode("conv-unasked");
    const run = converse();
    expect(await run.ended).toEqual({ kind: "finished", reply: "Wrote notes.md." });
    expect(run.asked).toEqual([]);
    expect(run.steps.filter((step) => step.kind === "own")).toEqual([
      { kind: "own", id: "exec-ls", action: { kind: "command", value: "ls" }, state: "going" },
      { kind: "own", id: "exec-ls", action: { kind: "command", value: "ls" }, state: "done" },
      {
        kind: "own",
        id: "patch-notes",
        action: {
          kind: "write",
          value: "notes.md",
          inFolder: true,
          size: { kind: "new", count: 1 },
          content: "Tides\n",
        },
        state: "going",
      },
      expect.objectContaining({ id: "patch-notes", state: "done" }),
    ]);
  });

  // protects=a write to a file Codex reads as its own (a skill under .agents) asks with the card saying it changes how Codex behaves from now on, and denied it isn't written; fails_when=a skill that steers every later request is written unasked or with no word of what it does
  it("asks before writing a file that steers Codex, saying so", async () => {
    await mode("conv-steering");
    const run = converse({ answer: async () => "deny" });
    expect(await run.ended).toEqual({ kind: "finished", reply: "Didn't write it." });
    expect(run.asked[0]?.action).toMatchObject({
      kind: "write",
      value: join(".agents", "skills", "tides", "SKILL.md"),
      inFolder: true,
      steers: true,
    });
    expect(run.asked[0]?.forRequest).toEqual([
      {
        kind: "rules",
        kept: "request",
        rules: [{ kind: "file", path: join(".agents", "skills", "tides", "SKILL.md") }],
      },
    ]);
    expect(existsSync(join(conversations, KEY, ".agents"))).toBe(false);
    expect(await decisions()).toEqual([{ decision: "decline" }]);
  });

  // protects=IncarnaMind's own server for the run, by its own name, is taken without asking and its calls are Tool steps, never Codex's own; a tool of a server the User set up in Codex asks with its server and the input it is sent, and Codex's own "always" and "for this session" answers go back as Codex reads them; fails_when=another server's tool runs unasked, its input shows Codex's display words for what is sent, or a lasting answer is lost
  it("asks before another server's tool, with Codex's own lasting answers", async () => {
    await mode("conv-tool");
    const run = converse({ answer: async () => "suggested" });
    expect(await run.ended).toEqual({ kind: "finished", reply: "Used it." });
    expect(run.asked).toHaveLength(1);
    expect(run.steps).toContainEqual({ kind: "tool", name: "read_mind" });
    expect(ownSteps(run.steps)).toEqual([]);
    expect(run.asked[0]).toMatchObject({
      action: {
        kind: "tool",
        value: "high_water",
        server: "tides",
        input: [
          { name: "Port", value: "Dover" },
          { name: "on", value: '{"day":2}' },
        ],
      },
      suggested: [
        {
          kind: "rules",
          kept: "everywhere",
          rules: [{ kind: "tool", tool: "high_water", server: "tides" }],
        },
      ],
      forRequest: [
        {
          kind: "rules",
          kept: "request",
          rules: [{ kind: "tool", tool: "high_water", server: "tides" }],
        },
      ],
    });
    expect(await decisions()).toEqual([
      { action: "accept", content: {}, _meta: null },
      { action: "accept", content: {}, _meta: { persist: "always" } },
    ]);
  });

  // protects=a request the card can't show (Codex asking the User for input in a form of its own) is refused at once and its step says so, so it never waits for an answer that can't come; fails_when=the run hangs on it
  it("refuses at once what the card can't show", async () => {
    await mode("conv-input");
    const run = converse();
    expect(await run.ended).toEqual({ kind: "finished", reply: "Asked nothing." });
    expect(run.asked).toEqual([]);
    expect(await decisions()).toEqual([{ answers: {} }]);
    expect(run.steps).toContainEqual(expect.objectContaining({ kind: "own", state: "refused" }));
  });

  // protects=Stop with a question open ends the run at once, withdraws the question and ends every process Codex started, its own included; fails_when=Stop waits on the question, or something Codex started keeps running
  it.skipIf(process.platform === "win32")(
    "stops with a question open, and leaves nothing running",
    async () => {
      await mode("conv-wait");
      const stop = new AbortController();
      let withdrawn: AbortSignal | undefined;
      const run = converse({
        signal: stop.signal,
        answer: (_asked, signal) => {
          withdrawn = signal;
          return new Promise<NoteAnswer>(() => {});
        },
      });
      await expect.poll(() => run.asked.length, { timeout: 10_000 }).toBe(1);
      const pids = JSON.parse(await readFile(join(bin, "pids.json"), "utf8")) as number[];
      expect(pids.every(processRunning)).toBe(true);
      stop.abort();
      await expect(run.ended).rejects.toThrow();
      expect(withdrawn?.aborted).toBe(true);
      await expect.poll(() => pids.some(processRunning), { timeout: 10_000 }).toBe(false);
      expect(await decisions()).toEqual([]);
    },
    30_000,
  );

  // protects=the next request continues the thread Codex keeps the conversation as; one Codex no longer has, or never kept, ends as a lost conversation so a new one starts; deleting the conversation deletes its threads in Codex and its folder; fails_when=a request starts a new thread each time, resumes another's, or a deleted conversation's thread stays in the User's Codex
  it("continues its thread, says when Codex lost it, and deletes it with the conversation", async () => {
    await mode("");
    expect(await converse({ resume: true }).ended).toEqual({
      kind: "failed",
      reason: "lost-conversation",
    });
    expect(starts).toEqual([]);
    expect(await converse().ended).toEqual({ kind: "finished", reply: "Done." });
    const [thread] = JSON.parse(await readFile(join(bin, "threads.json"), "utf8")) as string[];
    expect(await converse({ resume: true }).ended).toEqual({ kind: "finished", reply: "Done." });
    expect((await sent("thread/resume")).map((each) => each.threadId)).toEqual([thread]);
    const own = createOwnAi({ command: null, codexCommand: "codex", conversations });
    expect(await own.purge(KEY)).toBe(true);
    expect(starts.at(-1)?.args).toContain("check_for_update_on_startup=false");
    expect(starts.at(-1)?.cwd).toBe(conversations);
    expect(JSON.parse(await readFile(join(bin, "threads.json"), "utf8"))).toEqual([]);
    expect(existsSync(join(conversations, KEY))).toBe(false);
    expect(await converse({ resume: true }).ended).toEqual({
      kind: "failed",
      reason: "lost-conversation",
    });
  });

  // protects=a thread kept for the conversation whose folder in Codex is another's is never resumed, as a new conversation starts instead, and never deleted with it; fails_when=an id written into IncarnaMind's file resumes or deletes a thread of the User's own
  it("never resumes or deletes a thread of another folder", async () => {
    await mode("");
    await converse().ended;
    const [thread = ""] = JSON.parse(await readFile(join(bin, "threads.json"), "utf8")) as string[];
    await writeFile(
      join(bin, "folders.json"),
      JSON.stringify({ [thread]: join(bin, "elsewhere") }),
    );
    expect(await converse({ resume: true }).ended).toEqual({
      kind: "failed",
      reason: "lost-conversation",
    });
    expect(await sent("thread/resume")).toEqual([]);
    const own = createOwnAi({ command: null, codexCommand: "codex", conversations });
    expect(await own.purge(KEY)).toBe(true);
    expect(await sent("thread/delete")).toEqual([]);
    expect(JSON.parse(await readFile(join(bin, "threads.json"), "utf8"))).toEqual([thread]);
  });

  // protects=a resume Codex fails for a reason of its own is a problem with Try again, the conversation kept; only Codex's own missing-thread answer is a lost conversation; ids that can't be read stop the request, and nothing writes over them; fails_when=a passing error throws the conversation away, or an unreadable file is overwritten
  it("says when Codex can't open the thread, and keeps ids it can't read", async () => {
    await mode("");
    await converse().ended;
    await mode("resume-broken");
    expect(await converse({ resume: true }).ended).toEqual({ kind: "failed", reason: "service" });
    const kept = join(conversations, ".codex-threads", `${KEY}.json`);
    await writeFile(kept, "not a list");
    expect(await converse({ resume: true }).ended).toEqual({ kind: "failed", reason: "other" });
    expect(await converse().ended).toMatchObject({ kind: "failed" });
    expect(await readFile(kept, "utf8")).toBe("not a list");
  });

  // protects=threads Codex couldn't delete with their conversation, an unknown method's error among them, are deleted at the next start-up once it can; fails_when=a deleted conversation's thread stays in the User's Codex for good, or "Method not found" counts as deleted
  it("deletes later the threads it couldn't delete with their conversation", async () => {
    await mode("");
    await converse().ended;
    const kept = join(conversations, ".codex-threads", `${KEY}.json`);
    await mode("delete-unsupported");
    const own = createOwnAi({ command: null, codexCommand: "codex", conversations });
    expect(await own.purge(KEY)).toBe(false);
    expect(existsSync(join(conversations, KEY))).toBe(false);
    expect(existsSync(kept)).toBe(true);
    await mode("");
    createOwnAi({ command: null, codexCommand: "codex", conversations });
    await expect.poll(() => existsSync(kept), { timeout: 10_000 }).toBe(false);
    expect(JSON.parse(await readFile(join(bin, "threads.json"), "utf8"))).toEqual([]);
  });

  // protects=a request the User sends while Codex works is steered into its turn, said taken when Codex takes it, and answered there; fails_when=it waits for the turn to end, is lost, or is answered as the first request
  it("steers a request sent meanwhile into the turn going", async () => {
    await mode("conv-steer");
    let send: ((id: string, prompt: string) => void) | undefined;
    const run = converse({
      meanwhile: (given) => {
        send = given;
      },
    });
    await expect
      .poll(() => run.steps.some((step) => step.kind === "said" && step.text === "Counting."), {
        timeout: 10_000,
      })
      .toBe(true);
    send?.("turn-2", "and the early ones");
    expect(await run.ended).toEqual({ kind: "finished", reply: "Answered: and the early ones" });
    expect(run.steps).toContainEqual({ kind: "taken", id: "turn-2" });
    expect(await sent("turn/steer")).toEqual([
      expect.objectContaining({
        clientUserMessageId: "turn-2",
        expectedTurnId: expect.any(String),
      }),
    ]);
  });

  // protects=Codex set never to ask, or with full access on its own request, names that, which the conversation says once in plain words; a plan's limit ends the request as one; fails_when=a run that asks nothing goes unsaid, or a limit reads as a plain failure
  it("names a never-ask policy, and a plan's limit", async () => {
    await mode("conv-never");
    const never = converse();
    await never.ended;
    expect(never.steps).toContainEqual({ kind: "mode", mode: "never" });
    await mode("conv-full");
    const full = converse();
    await full.ended;
    expect(full.steps).toContainEqual({ kind: "mode", mode: "dangerFullAccess" });
    await mode("conv-limit");
    expect(await converse().ended).toEqual({ kind: "failed", reason: "plan-limit" });
  });
});
