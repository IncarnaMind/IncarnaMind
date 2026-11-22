import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client as ModernClient } from "@modelcontextprotocol/client";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { MockLanguageModelV4 } from "ai/test";
import { build } from "vite";
import { onTestFinished } from "vitest";
import type { AgentLaunch, CoreAdapters, Logger } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { legacyAgentClient, modernAgentClient } from "./agentClients";
import { createTempDataFolder, manualClock, startCore, type TestAdapters } from "./core";
import { scriptedModels } from "./models";
import {
  inProcessTranscriber,
  NO_TRANSCRIPTION_FILES,
  stoppedMeeting,
  until,
} from "./transcription";

const root = fileURLToPath(new URL("../..", import.meta.url));
let built: Promise<string> | null = null;

/**
 * The shim an agent starts (src/main/agentShim.ts), built once per test run
 * as the app builds it, to run with this Node as the app's binary runs it.
 */
export function buildAgentShim(): Promise<string> {
  built ??= (async () => {
    const outDir = join(root, `node_modules/.cache/incarnamind-test-agent-shim-${process.pid}`);
    await build({
      configFile: false,
      root,
      logLevel: "warn",
      build: {
        ssr: join(root, "src/main/agentShim.ts"),
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { output: { format: "cjs", entryFileNames: "agentShim.cjs" } },
      },
    });
    return join(outDir, "agentShim.cjs");
  })();
  return built;
}

/** Everything the core wrote to its log, one line per entry, to look for what mustn't be there. */
export interface LogCapture extends Logger {
  readonly lines: string[];
}

function captureLog(): LogCapture {
  const lines: string[] = [];
  const keep =
    (level: string) =>
    (event: string, fields?: object): void => {
      lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
    };
  return { lines, info: keep("info"), warn: keep("warn"), error: keep("error") };
}

/** Outside agents for a core on `dataDir`: they start the shim with this Node. */
export async function agentsAdapter(dataDir: string): Promise<CoreAdapters["agents"]> {
  return {
    socketPath: agentSocketPath(dataDir),
    launcher: { command: process.execPath, args: [await buildAgentShim()] },
    version: "0.0.0-test",
  };
}

/**
 * A core whose outside agents start the shim with this Node, on a temporary
 * data folder, with a local chat model (no consent needed) answering from
 * `model`, unless `modelSetUp` is false: a User with no AI model of their own set up.
 */
export async function startAgentsCore(
  model: MockLanguageModelV4,
  overrides: TestAdapters = {},
  { modelSetUp = true } = {},
) {
  const dataDir = await createTempDataFolder();
  const log = captureLog();
  const models = scriptedModels(model);
  const core = startCore(dataDir, {
    createChatModel: models.createChatModel,
    log,
    agents: await agentsAdapter(dataDir),
    ...overrides,
  });
  if (modelSetUp) await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, dataDir, log, models };
}

/** A Meeting recorded from text, as `startMeetingAgentsCore` records it. */
export interface RecordedMeeting {
  mindId: string;
  transcriptId: string;
  startedAt: string;
}

/**
 * A core with outside agents whose Meetings are recorded from text, with no microphone and no
 * transcription model: each Meeting says the next of `mine` on the microphone, then the next of
 * `theirs` on the computer's sound (the fake capture and engine), and is stopped.
 */
export async function startMeetingAgentsCore(
  script: { mine: readonly string[]; theirs: readonly string[] },
  overrides: TestAdapters = {},
) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const engine = inProcessTranscriber({ lines: script.mine, theirLines: script.theirs });
  const core = startCore(dataDir, {
    agents: await agentsAdapter(dataDir),
    audioCapture: capture,
    transcriber: engine.transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    now: clock.now,
    ...overrides,
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  /** Speech on one side for `ms`, the other quiet, the clock moving with it. */
  const hear = (ms: number, speaking: "microphone" | "system" | null) => {
    for (let at = 0; at < ms; at += 500) {
      clock.advance(500);
      capture.push("microphone", 500, speaking !== "microphone");
      capture.push("system", 500, speaking !== "system");
    }
  };
  /** Records the next Meeting in this Folder, or in none, under `title`. */
  const recordMeeting = async (
    folderId: string | null,
    title: string,
  ): Promise<RecordedMeeting> => {
    const meeting = await core.createMeeting({ folderId });
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    hear(2000, "microphone");
    hear(1000, null);
    hear(2000, "system");
    hear(1000, null);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    const stopped = await stoppedMeeting(core, dataDir, meeting.id);
    await core.renameMind(meeting.mindId, title);
    return {
      mindId: meeting.mindId,
      transcriptId: stopped.document.id,
      startedAt: stopped.meeting.startedAt ?? "",
    };
  };
  return { core, dataDir, hear, recordMeeting };
}

/** An agent on the protocol before 2026-07-28 (with `initialize`), as most clients still are. */
export async function connectLegacyAgent(
  launch: AgentLaunch,
  toolsChanged?: (names: string[]) => void,
): Promise<Client> {
  const client = await legacyAgentClient(launch, toolsChanged);
  onTestFinished(() => client.close());
  return client;
}

/** An agent on the current protocol, 2026-07-28 (stateless, `server/discover`), and nothing else. */
export async function connectModernAgent(
  launch: AgentLaunch,
  toolsChanged?: (names: string[]) => void,
): Promise<ModernClient> {
  const client = await modernAgentClient(launch, toolsChanged);
  onTestFinished(() => client.close());
  return client;
}

/** A Tool call's result text, which is its JSON, or the refusal it gave. */
export function resultText(result: unknown): string {
  const given = (result as { content?: unknown }).content;
  const content = Array.isArray(given) ? given : [];
  return content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
    .join("");
}
