/**
 * What the tests of files an outside agent hands over share (#3412): a Library with a harbour
 * survey in the Coast Folder, "Claude Code" that may write there and "Codex" that may only read,
 * the scripted check's plans, a deck, and the agent's calls.
 */
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { expect } from "vitest";
import type { AnalysisRuntime, NamedFile } from "../../src/core/adapters";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { agentsAdapter, type connectLegacyAgent, startAgentsCore } from "./agents";
import { checkingModel, type Plan } from "./checks";
import { createMemoryKeychain, createTempDataFolder, startCore } from "./core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "./documents";
import type { ModelCall } from "./models";
import { plainDeck } from "./pptx";

export type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

export interface Handed {
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

export function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

export function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

export const SURVEY = [
  "# Harbour survey",
  "",
  "The north quay holds 42 boats and the south quay holds 19 boats.",
  "",
  "The harbour office is open every day of the year.",
].join("\n");

export const NORTH = "The north quay holds 42 boats.";
export const SOUTH = "The south quay holds 17 boats.";
export const OFFICE = "The harbour office is open every day of the year.";
export const NEVER_CLOSES = "The harbour office never closes, night or day.";

export const PLANS: Record<string, Plan> = {
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
export const DECK = plainDeck([
  { title: "Harbour review" },
  { lines: [NORTH, SOUTH] },
  { lines: [OFFICE, NEVER_CLOSES] },
]);

/** "Claude Code" may write in Coast; the Coast has the harbour survey. */
export async function started(
  calls: ModelCall[] = [],
  {
    plans = PLANS,
    model = checkingModel(plans, calls),
    reading,
    folders = [],
    analysisRuntime,
  }: {
    plans?: Record<string, Plan>;
    /** The checking model, in place of one that checks as `plans` say. */
    model?: MockLanguageModelV4;
    /** Heard as the Tool reads the agent's file, before the read: what a test does meanwhile. */
    reading?: () => Promise<void>;
    /** More Folders "Claude Code" may write in, by name, made empty. */
    folders?: readonly string[];
    /** Python for `run_analysis`; none by default. */
    analysisRuntime?: AnalysisRuntime;
  } = {},
) {
  const kept = await createTempDataFolder();
  const files = createCanvasFiles(join(kept, "Canvases"));
  const canvasFiles = reading
    ? {
        ...files,
        readNamed: async (path: string, maxBytes: number): Promise<NamedFile> => {
          await reading();
          return files.readNamed(path, maxBytes);
        },
      }
    : files;
  // Kept across a restart: the pairings' tokens are in it.
  const keychain = createMemoryKeychain();
  const started = await startAgentsCore(model, {
    canvasFiles,
    keychain,
    ...(analysisRuntime && { analysisRuntime }),
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
  const more = [];
  for (const name of folders) more.push(await core.createLibraryGroup({ name, description: "" }));
  await core.setAgentsEnabled(true);
  const writer = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id, ...more.map((each) => each.id)],
    propose: true,
  });
  const reader = await core.connectAgent({ name: "Codex", folderIds: [coast.id] });
  const agentFiles = await createSourceFolder();
  /** The same data folder opened again, as after a quit. */
  const restart = async () => {
    await core.close();
    return startCore(started.dataDir, {
      createChatModel: started.models.createChatModel,
      log: started.log,
      agents: await agentsAdapter(started.dataDir),
      canvasFiles,
      keychain,
    });
  };
  return { core, coast, writer, reader, files: agentFiles, added, more, restart };
}

export const handOver = (agent: Agent, args: Record<string, unknown>) =>
  agent.callTool({ name: "hand_over_file", arguments: args });
