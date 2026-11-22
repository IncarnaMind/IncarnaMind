/**
 * A Check pressed with no model set up, run on the User's own Claude Code in the background
 * (ADR-0032, #3606). The runner here stands in for the command line: it connects through the shim
 * with the launch IncarnaMind gave it, as `claude` would, and calls the Tools. The grant reaches
 * only the check's Tools, for that Note; its marks land as they do from the link route; the windows
 * hear how it ended; and a User the background can't serve keeps the link.
 */

import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { OwnAiClient, OwnAiRunner, OwnAiStatus } from "../../src/core/adapters";
import type { AgentLaunch, OwnAiCheckEnd } from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon.",
  "",
  "The range of a spring tide is the largest of the month.",
].join("\n");
const SPRING = "Spring tides come twice in every month.";
const NEAP = "Neap tides have the largest range of the month.";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;
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

/** The agent the command line would be: the Note's id from the prompt, then the check's Tools. */
async function checks(agent: Agent, request: RunRequest): Promise<RunEnd> {
  const mindId = request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";
  const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
    await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
  );
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: "spring tides range" } }),
  );
  const cite = async (quote: string) => {
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
      }),
    );
    return citations.find((each) => each.cite !== null)?.cite ?? "";
  };
  const n = (text: string) => given.sentences.find((each) => each.text === text)?.n;
  structured(
    await agent.callTool({
      name: "report_check",
      arguments: {
        mindId,
        task: given.task,
        results: [
          {
            n: n(SPRING),
            verdict: "supported",
            cites: [await cite("Spring tides happen twice a month")],
          },
          {
            n: n(NEAP),
            verdict: "contradicted",
            cites: [await cite("The range of a spring tide is the largest of the month.")],
          },
        ],
      },
    }),
  );
  return { kind: "finished" };
}

/** A command line that works until it is stopped, as a long check does. */
const untilStopped = (_agent: Agent, request: RunRequest) =>
  new Promise<RunEnd>((resolve) => {
    if (request.signal.aborted) resolve({ kind: "finished" });
    request.signal.addEventListener("abort", () => resolve({ kind: "finished" }), { once: true });
  });

/** A runner whose command line is `act`, or `status` without one; `installed`: whether `claude` is found at all. */
function runner(
  act: (agent: Agent, request: RunRequest) => Promise<RunEnd> = checks,
  status: OwnAiStatus = { kind: "ready" },
  installed = true,
) {
  const runs: RunRequest[] = [];
  const launches: AgentLaunch[] = [];
  const statuses: OwnAiClient[] = [];
  const adapter: OwnAiRunner = {
    installed: async () => installed,
    async status(client) {
      statuses.push(client);
      return status;
    },
    async run(request) {
      runs.push(request);
      launches.push(request.server);
      return act(await connectLegacyAgent(request.server), request);
    },
  };
  return { adapter, runs, launches, statuses };
}

/** A connection made before the background existed: no decision on it at all. */
function madeBefore(dataDir: string) {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("DELETE FROM data_flow_consents WHERE flow = 'hosted-agents'");
  } finally {
    db.close();
  }
}

/** The Note's sentences the agent is given, by a Tool call on `agent`. */
async function sentencesOf(agent: Agent, mindId: string) {
  return structured<{ task: string; sentences: { n: number; text: string }[] }>(
    await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
  );
}

/**
 * A User with no model set up, Tides in "Coast", a Note they wrote there, Claude Code and VS Code,
 * on a desktop app that reads a file an agent names by its path.
 */
async function written(ownAi?: OwnAiRunner) {
  const canvasFiles = createCanvasFiles(join(await createTempDataFolder(), "Canvases"));
  const started = await startAgentsCore(
    checkingModel({}, []),
    { canvasFiles, ...(ownAi && { ownAi }) },
    { modelSetUp: false },
  );
  const { core } = started;
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const claude = await core.connectAgent({
    name: "Claude Code",
    client: "claude-code",
    folderIds: [coast.id],
    propose: false,
  });
  const vscode = await core.connectAgent({
    name: "VS Code",
    client: "vscode",
    folderIds: [coast.id],
  });
  const mind = await core.createMind({ title: "Tide notes", folderId: coast.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(SPRING), note(NEAP)]);
  await client.settled();
  const ends: OwnAiCheckEnd[] = [];
  core.on("agents.ownCheck", (end) => ends.push(end));
  const ended = () =>
    expect
      .poll(() => ends.length)
      .toBeGreaterThan(0)
      .then(() => ends[0]);
  const marks = async () => {
    await client.settled();
    const versions = new Map(
      (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
    );
    return claimSpans(readMind(client)).map((span) => [
      span.sentence.text,
      claimCheckShown(span.check, {
        footing: "not-yet-known",
        text: span.sentence.text,
        versions,
        folderId: coast.id,
        scope: null,
      }).state,
    ]);
  };
  return { ...started, core, mindId: mind.id, coast, claude, vscode, ends, ended, marks };
}

describe("a Check run on the User's own Claude Code in the background (#3606)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=one press with no model set up checks a Note the User wrote on their Claude Code, with no app opened, its marks landing and the windows told; the run is given only the check's Tools and IncarnaMind's own instructions, the Note's text never in its prompt; fails_when=the press falls back to the link, the marks don't land, or the run is given more than the check needs
  it("checks the Note in the background, its marks landing, on a connection that may only read", async () => {
    const run = runner();
    const { core, mindId, claude, ended, marks } = await written(run.adapter);

    const started = await core.checkWithOwnAi(mindId);
    expect(started).toEqual({
      kind: "started",
      pairing: expect.objectContaining({ id: claude.pairing.id }),
    });
    expect(await ended()).toEqual({
      mindId,
      pairingId: claude.pairing.id,
      outcome: "landed",
      problem: null,
    });
    expect(await marks()).toEqual([
      [SPRING, "supported"],
      [NEAP, "contradicted"],
    ]);
    const [request] = run.runs;
    expect(request?.tools).toEqual([
      "check_mind_yourself",
      "search",
      "read_passages",
      "cite",
      "run_analysis",
      "report_check",
    ]);
    expect(request?.prompt).toBe(
      `The User pressed Check on their note “Tide notes” (mindId: ${mindId}). Check it.`,
    );
    expect(request?.prompt).not.toContain(SPRING);
  });

  // protects=the run's grant reaches only the check's Tools, for that Note, and dies with the run; fails_when=the background run can read or write other Notes, call other Tools, or its launch still works afterwards
  it("refuses the run every other Tool and Note, and its launch once it ended", async () => {
    let tried: string[] = [];
    const run = runner(async (agent, request) => {
      const other = await agent.callTool({ name: "list_minds", arguments: {} });
      const write = await agent.callTool({
        name: "create_mind",
        arguments: { title: "Planted", markdown: "Planted." },
      });
      const elsewhere = await agent.callTool({
        name: "check_mind_yourself",
        arguments: { mindId: "another-note" },
      });
      // It would open the Note in the User's window: never one of a run's Tools.
      const mindId = request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";
      const shown = await agent.callTool({ name: "show_citation", arguments: { note: mindId } });
      tried = [refusal(other), refusal(write), refusal(elsewhere), refusal(shown)];
      return checks(agent, request);
    });
    const { core, mindId, ended } = await written(run.adapter);
    await core.checkWithOwnAi(mindId);
    expect((await ended())?.outcome).toBe("landed");
    expect(tried).toEqual(
      Array(4).fill(
        "This check can only check its own note, with check_mind_yourself, search, read_passages, cite, run_analysis and report_check.",
      ),
    );
    expect((await core.listMinds()).map((mind) => mind.title)).not.toContain("Planted");

    const [launch] = run.launches;
    if (!launch) throw new Error("No run was started.");
    const after = await connectLegacyAgent(launch);
    expect(
      refusal(await after.callTool({ name: "search", arguments: { query: "tides" } })),
    ).toMatch(/no longer connected|isn't connected|Connect it again/i);
  });

  // protects=a User the background can't serve keeps today's link: no runner on this host, only an agent that runs in its own app, or Claude Code not installed, which on a connection made before asks no consent for a run that can't happen; fails_when=the press does nothing, starts a run that can't work, or asks the User to allow an agent that isn't there
  it("keeps the link where no agent can run it in the background", async () => {
    const none = await written();
    expect(await none.core.checkWithOwnAi(none.mindId)).toEqual({ kind: "link" });

    const missing = await written(runner(checks, { kind: "missing" }).adapter);
    expect(await missing.core.checkWithOwnAi(missing.mindId)).toEqual({ kind: "link" });

    const absent = runner(checks, { kind: "missing" }, false);
    const older = await written(absent.adapter);
    madeBefore(older.dataDir);
    const asked: string[] = [];
    older.core.on("consent.requested", (request) => asked.push(request.flow.id));
    expect(await older.core.checkWithOwnAi(older.mindId)).toEqual({ kind: "link" });
    expect(asked).toEqual([]);
    expect(absent.statuses).toEqual([]);

    const run = runner();
    const vscodeOnly = await written(run.adapter);
    expect(
      await vscodeOnly.core.checkWithOwnAi(vscodeOnly.mindId, vscodeOnly.vscode.pairing.id),
    ).toEqual({ kind: "link" });
    expect(run.runs).toEqual([]);
  });

  // protects=Claude Code installed but not signed in, or too old, is said in a line, with nothing run; fails_when=a run starts that can only fail, or nothing says why
  it("says when Claude Code isn't signed in or is too old, and runs nothing", async () => {
    const signedOut = runner(checks, { kind: "signed-out" });
    const out = await written(signedOut.adapter);
    expect(await out.core.checkWithOwnAi(out.mindId)).toMatchObject({
      kind: "problem",
      problem: "signed-out",
    });
    const old = runner(checks, { kind: "too-old", found: "2.1.100", lowest: "2.1.248" });
    const aged = await written(old.adapter);
    expect(await aged.core.checkWithOwnAi(aged.mindId)).toMatchObject({
      kind: "problem",
      problem: "too-old",
      versions: { found: "2.1.100", lowest: "2.1.248" },
    });
    expect([...signedOut.runs, ...old.runs]).toEqual([]);
  });

  // protects=a connection made before the background existed asks once, in the consent dialog, before anything of the User's agent starts, its --version included; no keeps the link and isn't asked again; yes runs it; fails_when=IncarnaMind starts the User's agent before the consent, or asks at every press
  it("asks once for a connection without the consent, before anything starts, and keeps the link on no", async () => {
    const run = runner();
    const refused = await written(run.adapter);
    madeBefore(refused.dataDir);
    const asked: string[] = [];
    const off = refused.core.on("consent.requested", (request) => {
      asked.push(request.flow.id);
      void refused.core.respondToConsent(request.requestId, false);
    });
    expect(await refused.core.checkWithOwnAi(refused.mindId)).toEqual({ kind: "link" });
    expect(await refused.core.checkWithOwnAi(refused.mindId)).toEqual({ kind: "link" });
    off();
    expect(asked).toEqual(["hosted-agents"]);
    expect(run.statuses).toEqual([]);
    expect(run.runs).toEqual([]);

    const allowed = await written(runner().adapter);
    madeBefore(allowed.dataDir);
    allowed.core.on(
      "consent.requested",
      (request) => void allowed.core.respondToConsent(request.requestId, true),
    );
    expect((await allowed.core.checkWithOwnAi(allowed.mindId)).kind).toBe("started");
    expect((await allowed.ended())?.outcome).toBe("landed");
  });

  // protects=a run stopped by Local mode or by the consent taken back in Settings › Privacy says so, not that the agent can't read the Note; after the take-back Check goes by the link with no dialog, as the record says; fails_when=the line gives the wrong reason, or the next press asks again
  it("says why a run stopped when Local mode or a take-back ended it, and keeps the link after a take-back", async () => {
    const local = await written(runner(untilStopped).adapter);
    await local.core.checkWithOwnAi(local.mindId);
    await local.core.setLocalOnly(true);
    expect(await local.ended()).toMatchObject({ outcome: "failed", problem: "local-mode" });

    const run = runner(untilStopped);
    const back = await written(run.adapter);
    await back.core.checkWithOwnAi(back.mindId);
    await back.core.revokeConsent("hosted-agents", `agent:${back.claude.pairing.id}`);
    expect(await back.ended()).toMatchObject({ outcome: "failed", problem: "taken-back" });
    const asked: string[] = [];
    back.core.on("consent.requested", (request) => asked.push(request.flow.id));
    expect(await back.core.checkWithOwnAi(back.mindId)).toEqual({ kind: "link" });
    expect(asked).toEqual([]);
    expect(run.runs).toHaveLength(1);
  });

  // protects=Stop ends the run and lands nothing; a run that ends with no report says so; one whose Note left the agent's reach stops; fails_when=a stopped or broken run leaves the line checking for ever, or lands marks after Stop
  it("stops on Stop, says when nothing landed, and stops when the Note leaves the agent's reach", async () => {
    const stopped = await written(runner(untilStopped).adapter);
    await stopped.core.checkWithOwnAi(stopped.mindId);
    await stopped.core.stopOwnAiCheck(stopped.mindId);
    expect((await stopped.ended())?.outcome).toBe("stopped");
    expect(await stopped.marks()).toEqual([]);

    const silent = await written(runner(async () => ({ kind: "finished" })).adapter);
    await silent.core.checkWithOwnAi(silent.mindId);
    expect(await silent.ended()).toMatchObject({ outcome: "failed", problem: "no-marks" });

    const limited = await written(
      runner(async () => ({ kind: "failed", reason: "plan-limit" })).adapter,
    );
    await limited.core.checkWithOwnAi(limited.mindId);
    expect(await limited.ended()).toMatchObject({ outcome: "failed", problem: "plan-limit" });

    const away = await written(runner(untilStopped).adapter);
    await away.core.checkWithOwnAi(away.mindId);
    await away.core.disconnectAgent(away.claude.pairing.id);
    expect(await away.ended()).toMatchObject({ outcome: "failed", problem: "access" });
  });

  // protects=a check run reads only the pairing's Folders: it cites no file by its path, so nothing on the computer is opened or added, and a Citation the agent got for a file by its path on its own connection marks nothing in the run; fails_when=a check run opens any file the User's account can read, or rests a mark on one outside the Folders
  it("cites no file by its path, and rests no mark on a file cited elsewhere", async () => {
    const elsewhere = await createSourceFolder();
    const path = await writeSourceFile(
      elsewhere,
      "Diary.md",
      "# Diary\n\nSpring tides happen twice a month, my diary says.",
    );
    const unread = await writeSourceFile(
      elsewhere,
      "Letters.md",
      "# Letters\n\nSpring tides happen twice a month, a letter says.",
    );
    const quote = "Spring tides happen twice a month";
    let refused = "";
    let unconfirmed: number[] = [];
    let token = "";
    const run = runner(async (agent, request) => {
      const mindId = request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";
      refused = refusal(
        await agent.callTool({ name: "cite", arguments: { citations: [{ path: unread, quote }] } }),
      );
      const given = await sentencesOf(agent, mindId);
      const n = given.sentences.find((each) => each.text === SPRING)?.n;
      ({ unconfirmed } = structured<{ unconfirmed: number[] }>(
        await agent.callTool({
          name: "report_check",
          arguments: {
            mindId,
            task: given.task,
            results: [{ n, verdict: "supported", cites: [token] }],
          },
        }),
      ));
      return { kind: "finished" };
    });
    const { core, mindId, claude, ended, marks } = await written(run.adapter);
    const own = await connectLegacyAgent(claude.launch);
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await own.callTool({ name: "cite", arguments: { citations: [{ path, quote }] } }),
    );
    token = citations[0]?.cite ?? "";
    expect(token).not.toBe("");
    const documents = (await core.listDocuments()).length;

    await core.checkWithOwnAi(mindId);
    await ended();
    expect(refused).toBe(translate("en", "agents.problem.checkRunPath"));
    expect(unconfirmed).toHaveLength(1);
    expect(await marks()).not.toContainEqual([SPRING, "supported"]);
    expect((await core.listDocuments()).length).toBe(documents);
  });

  // protects=the grant's connections close when the run ends: one the agent keeps open can't call a Tool afterwards; fails_when=a connection opened with the grant goes on working after the run ended
  it("closes the run's connections when it ends", async () => {
    const kept: Agent[] = [];
    const { core, mindId, ended } = await written(
      runner(async (agent) => {
        kept.push(agent);
        return { kind: "finished" };
      }).adapter,
    );
    await core.checkWithOwnAi(mindId);
    expect((await ended())?.problem).toBe("no-marks");
    await expect(
      kept[0]?.callTool({ name: "search", arguments: { query: "tides" } }),
    ).rejects.toThrow();
  });

  // protects=a run IncarnaMind starts leaves the agent's own connections nothing: they can't take a Note the User wrote while it runs, after Stop or after it fails, and the press takes back another agent's earlier ask, as asking another agent does; fails_when=the agent's own token reads the Note or lands marks for half an hour after a background press
  it("gives the agent's own connections nothing, while it runs and after it ends", async () => {
    // Both may only read: a Note the User wrote is theirs to check only while an ask stands.
    const readOnly = translate("en", "agents.problem.read-only");
    const take = async (agent: Agent, mindId: string) =>
      refusal(await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }));

    const stopped = await written(runner(untilStopped).adapter);
    const { core, mindId, claude, vscode } = stopped;
    await core.askAgent({ pairingId: vscode.pairing.id, mindId, ask: { kind: "check" } });
    const editor = await connectLegacyAgent(vscode.launch);
    await sentencesOf(editor, mindId);
    const own = await connectLegacyAgent(claude.launch);
    await core.checkWithOwnAi(mindId);
    expect(await take(own, mindId)).toBe(readOnly);
    expect(await take(editor, mindId)).toBe(readOnly);
    await core.stopOwnAiCheck(mindId);
    expect((await stopped.ended())?.outcome).toBe("stopped");
    expect(await take(own, mindId)).toBe(readOnly);

    const failed = await written(runner(async () => ({ kind: "failed", reason: "other" })).adapter);
    await failed.core.checkWithOwnAi(failed.mindId);
    expect((await failed.ended())?.problem).toBe("failed");
    const theirs = await connectLegacyAgent(failed.claude.launch);
    expect(await take(theirs, failed.mindId)).toBe(readOnly);
  });

  // protects=two presses at once on one Note, each naming another Claude Code connection, start one run, and both are told the agent that runs it, so the line that hears its end is the one showing Stop; fails_when=a press is told it started a run of an agent that isn't running, and its line shows Stop for ever
  it("tells a second press the agent already running", async () => {
    const run = runner(untilStopped);
    const { core, mindId, claude, coast, ended } = await written(run.adapter);
    const other = await core.connectAgent({
      name: "Claude Code, work",
      client: "claude-code",
      folderIds: [coast.id],
      propose: false,
    });
    const [first, second] = await Promise.all([
      core.checkWithOwnAi(mindId, claude.pairing.id),
      core.checkWithOwnAi(mindId, other.pairing.id),
    ]);
    const runs = (start: typeof first) =>
      start.kind === "started" ? start.pairing.id : start.kind;
    expect(runs(second)).toBe(runs(first));
    expect(run.runs).toHaveLength(1);
    await core.stopOwnAiCheck(mindId);
    expect((await ended())?.pairingId).toBe(runs(first));
  });

  // protects=what the press found is checked again once the consent is answered, which may take as long as the User does: the Note gone from the agent's reach meanwhile starts nothing and keeps the link (Local mode turned on meanwhile already ends the dialog with its own line); fails_when=Claude Code starts with the Note's title for an agent that may no longer read it
  it("starts nothing when the Note left the agent's reach while the consent waited", async () => {
    const run = runner(untilStopped);
    const { core, mindId, claude, dataDir } = await written(run.adapter);
    madeBefore(dataDir);
    const inland = await core.createLibraryGroup({ name: "Inland", description: "Rivers." });
    core.on("consent.requested", (request) => {
      void (async () => {
        await core.updateAgent(claude.pairing.id, { folderIds: [inland.id] });
        await core.respondToConsent(request.requestId, true);
      })();
    });
    expect(await core.checkWithOwnAi(mindId)).toEqual({ kind: "link" });
    expect(run.runs).toEqual([]);
  });
});
