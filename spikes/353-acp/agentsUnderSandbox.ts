/**
 * Runs each listed agent in the sandbox ADR-0026 sets out (#353) and prints what it did:
 * whether it starts and takes our session, which modes it offers, which hosts it reached
 * through the sandbox's network proxy, and how its turn ended. Each runs with a new
 * temporary home and a made-up API key, so it is signed in to nothing, and is told to keep
 * its credentials in files there, never the keychain; its only MCP server is the test
 * fixture's. macOS only, as the hosted agent is for now. Run it from the repository's root.
 *
 *   npx esbuild spikes/353-acp/agentsUnderSandbox.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=node_modules/.cache/agentsUnderSandbox.mjs
 *   node node_modules/.cache/agentsUnderSandbox.mjs <agents folder>
 *
 * <agents folder> holds `npm/` (`@agentclientprotocol/codex-acp`, `@google/gemini-cli` and
 * `@qwen-code/qwen-code`, installed there with `--prefix`) and `goose/goose`; OpenCode is
 * the one on PATH.
 */
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { AgentProgram } from "../../src/core";
import { type HostedEvent, runHostedTurn } from "../../src/core/agents/hosted";
import { createAgentProcesses } from "../../src/main/agentProcesses";
import { createProcessLauncher } from "../../src/main/processes";

const folder = process.argv[2];
if (!folder) throw new Error("Name the folder the agents were installed in.");
const npmBin = (path: string) => join(folder, "npm/node_modules", path);
const FAKE_KEY = "sk-test-not-a-real-key";
const TIDE_SERVER = join(process.cwd(), "tests/fixtures/mcp-server.mjs");
const TURN_MS = 60_000;

interface Agent {
  name: string;
  command: string;
  args: string[];
  /** Its documented restrictive start, and a made-up key. */
  env: Record<string, string>;
  modes: string[];
  /** Its vendor's hosts, the only ones the proxy lets through. */
  hosts: string[];
}

const AGENTS: Agent[] = [
  {
    name: "Codex",
    command: process.execPath,
    args: [npmBin("@agentclientprotocol/codex-acp/dist/index.js")],
    env: { INITIAL_AGENT_MODE: "read-only", OPENAI_API_KEY: FAKE_KEY, CODEX_API_KEY: FAKE_KEY },
    modes: ["read-only"],
    hosts: ["api.openai.com", "chatgpt.com"],
  },
  {
    name: "Goose",
    command: join(folder, "goose/goose"),
    args: ["acp"],
    env: {
      GOOSE_MODE: "approve",
      GOOSE_PROVIDER: "openai",
      GOOSE_MODEL: "gpt-4.1-mini",
      GOOSE_DISABLE_KEYRING: "1",
      OPENAI_API_KEY: FAKE_KEY,
    },
    modes: ["approve"],
    hosts: ["api.openai.com"],
  },
  {
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    env: {
      OPENCODE_PERMISSION: JSON.stringify({ edit: "ask", bash: "ask", webfetch: "ask" }),
      OPENAI_API_KEY: FAKE_KEY,
    },
    modes: ["plan"],
    hosts: ["api.openai.com", "models.dev", "opencode.ai"],
  },
  {
    name: "Gemini CLI",
    command: process.execPath,
    args: [npmBin("@google/gemini-cli/bundle/gemini.js"), "--acp"],
    env: { GEMINI_API_KEY: FAKE_KEY },
    modes: ["plan"],
    hosts: ["generativelanguage.googleapis.com"],
  },
  {
    name: "Qwen Code",
    command: process.execPath,
    args: [npmBin("@qwen-code/qwen-code/cli-entry.js"), "--acp"],
    env: {
      OPENAI_API_KEY: FAKE_KEY,
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODEL: "gpt-4.1-mini",
    },
    modes: ["plan"],
    hosts: ["api.openai.com"],
  },
];

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The hosts the agent now running asked the proxy for, and which of them it allowed. */
let asked: { host: string; allowed: boolean }[] = [];
let allowedHosts: string[] = [];

await SandboxManager.initialize(
  { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
  async ({ host }) => {
    const allowed = allowedHosts.some((each) => host === each || host.endsWith(`.${each}`));
    asked.push({ host, allowed });
    return allowed;
  },
);

const processes = createProcessLauncher(async () =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
);

async function newFolder(prefix: string) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Codex keeps its sign-in in a file in this home, never in the keychain. */
async function codexKeepsFiles(home: string) {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex/config.toml"),
    'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n',
  );
}

async function run(agent: Agent) {
  const home = await newFolder("acp-home-");
  const data = await newFolder("acp-data-");
  const working = await newFolder("acp-work-");
  await writeFile(join(data, "canary.txt"), "DATA CANARY");
  await mkdir(join(home, ".config"), { recursive: true });
  await codexKeepsFiles(home);
  asked = [];
  allowedHosts = agent.hosts;
  const confine = async (program: AgentProgram): Promise<AgentProgram> => {
    const exports = Object.entries({ ...program.env, HOME: home, TMPDIR: working })
      .map(([name, value]) => `export ${name}=${quote(value)};`)
      .join(" ");
    const script = `${exports} exec ${[program.command, ...program.args].map(quote).join(" ")}`;
    const { argv } = await SandboxManager.wrapWithSandboxArgv(script, undefined, {
      filesystem: { denyRead: [data], allowRead: [], allowWrite: [working, home], denyWrite: [] },
    });
    const [command, ...args] = argv;
    if (!command) throw new Error("sandbox-runtime gave no command.");
    return { ...program, command, args, env: {} };
  };
  const started = Date.now();
  const report: Record<string, unknown> = { agent: agent.name };
  try {
    const agentProcess = await createAgentProcesses(processes, confine).start({
      command: agent.command,
      args: agent.args,
      cwd: working,
      env: agent.env,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_MS);
    const events: HostedEvent[] = [];
    try {
      for await (const event of runHostedTurn({
        process: agentProcess,
        cwd: working,
        mcpServer: { name: "tides", command: process.execPath, args: [TIDE_SERVER], env: [] },
        modes: agent.modes,
        prompt: "Reply with the single word: hi",
        version: "0.0.0-spike",
        ask: async (permission) => {
          report.asked = [...((report.asked as unknown[]) ?? []), permission];
          return "deny";
        },
        actions: {
          writeTextFile: () => Promise.reject(new Error("denied in this spike")),
          startCommand: () => Promise.reject(new Error("denied in this spike")),
        },
        reportError: (error) => {
          report.cancelError = String(error);
        },
        signal: controller.signal,
      })) {
        events.push(event);
      }
    } finally {
      clearTimeout(timer);
      await agentProcess.stop();
    }
    report.events = events.filter((event) => event.type !== "text-delta" && event.type !== "reasoning");
    report.text = events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("");
    report.stderr = agentProcess.stderrTail().slice(-600);
  } catch (error) {
    report.failedToStart = String(error);
  }
  report.hosts = asked;
  report.seconds = Math.round((Date.now() - started) / 1000);
  return report;
}

/** Codex's own sandbox, started inside ours: macOS may refuse one Seatbelt inside another. */
async function codexOwnSandbox() {
  const home = await newFolder("acp-home-");
  const working = await newFolder("acp-work-");
  await codexKeepsFiles(home);
  const script = `export HOME=${quote(home)}; exec ${quote(process.execPath)} ${quote(npmBin("@openai/codex/bin/codex.js"))} sandbox /bin/echo inner`;
  const { argv } = await SandboxManager.wrapWithSandboxArgv(script, undefined, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [working, home], denyWrite: [] },
  });
  const [command, ...args] = argv;
  if (!command) throw new Error("sandbox-runtime gave no command.");
  const child = await processes.spawn(command, args, { cwd: working });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { agent: "Codex's own sandbox inside ours", code, output: output.slice(-600) };
}

const only = process.argv[3];
for (const agent of AGENTS.filter((each) => !only || each.name === only)) {
  console.log(JSON.stringify(await run(agent), null, 1));
}
if (!only || only === "Codex") console.log(JSON.stringify(await codexOwnSandbox(), null, 1));
await SandboxManager.reset();
process.exit(0);
