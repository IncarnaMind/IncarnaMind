/**
 * The agents IncarnaMind is set up in (#351, ADR-0019): a few get first-class
 * setup, tried before each release, and every other agent connects as "Other
 * agent", with settings to copy. Moving one between the two is a change here.
 * A setup is one of:
 *
 * - "bundle": Claude's desktop app installs an `.mcpb` bundle opened with it
 *   (the shim inside, run on the app's own Node);
 * - "link": Cursor installs a server from a link of its own;
 * - "file": IncarnaMind adds itself to the agent's settings file (Codex's
 *   TOML, or the `mcpServers` JSON), shown first, with Undo;
 * - "command": Claude Code takes one line pasted into a terminal;
 * - "manual": the settings to copy, for the agent's own screen.
 *
 * Whether an agent is on this computer is a guess from its app or the folder
 * it keeps its settings in, used only to list it first. The settings files
 * are the agents' own documented ones, cited beside each.
 */
import { join } from "node:path";
import { HIDDEN_KEY } from "../../shared/agentSocket";
import type { AgentClientId, AgentLaunch, AgentSetupKind } from "../api";
import { SKILL_NAME } from "./skill";

/** The name IncarnaMind has in every agent's settings. */
export const SERVER_KEY = "incarnamind";

export type SettingsFormat = "mcp-servers-json" | "codex-toml";

export interface SettingsFile {
  /** Under the home folder. */
  path: readonly string[];
  format: SettingsFormat;
}

export interface ClientDefinition {
  id: AgentClientId;
  /** Its own name, which no language translates; "other" is named by the interface. */
  name: string;
  setup: AgentSetupKind;
  /** Files or folders under the home folder whose presence says it is installed. */
  home?: readonly (readonly string[])[];
  /** Its app, on macOS. */
  apps?: readonly string[];
  /**
   * The settings files a "file" setup writes. A list so that a setup can
   * write a second file (an Agent Skill, #378) beside the server's entry.
   */
  files?: readonly SettingsFile[];
  /**
   * The folder under the home folder whose subfolders are the agent's own
   * Agent Skills (#378), cited beside each agent below. Left out where the
   * agent's docs give no such folder: it gets the workflow from the server's
   * instructions, and "Copy settings" carries the Skill for the User to add.
   */
  skills?: readonly string[];
}

export const AGENT_CLIENT_DEFINITIONS: readonly ClientDefinition[] = [
  {
    id: "claude-desktop",
    name: "Claude",
    setup: "bundle",
    apps: ["Claude.app"],
    home: [
      ["Library", "Application Support", "Claude"],
      ["AppData", "Roaming", "Claude"],
      [".config", "Claude"],
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    setup: "command",
    home: [[".claude.json"], [".claude"]],
    // https://code.claude.com/docs/en/skills (personal skills).
    skills: [".claude", "skills"],
  },
  {
    // One entry for both: the ChatGPT desktop app's Work and Codex modes read Codex's file.
    id: "codex",
    name: "ChatGPT app and Codex",
    setup: "file",
    apps: ["Codex.app", "ChatGPT.app"],
    home: [[".codex"]],
    files: [{ path: [".codex", "config.toml"], format: "codex-toml" }],
    // https://learn.chatgpt.com/docs/build-skills (user skills). The page doesn't name the
    // ChatGPT app's Codex mode, which reads Codex's settings, so it is assumed to read these too.
    skills: [".agents", "skills"],
  },
  {
    id: "cursor",
    name: "Cursor",
    setup: "link",
    apps: ["Cursor.app"],
    home: [[".cursor"]],
    // https://cursor.com/docs/context/skills (user-level skills).
    skills: [".cursor", "skills"],
  },
  {
    // https://www.antigravity.google/docs/mcp/ gives ~/.gemini/config/mcp_config.json.
    id: "antigravity",
    name: "Antigravity",
    setup: "file",
    apps: ["Antigravity.app"],
    home: [
      [".gemini", "config"],
      [".gemini", "antigravity"],
    ],
    files: [{ path: [".gemini", "config", "mcp_config.json"], format: "mcp-servers-json" }],
    // https://www.antigravity.google/docs/skills (global skills, Antigravity 2.0 and the IDE).
    skills: [".gemini", "config", "skills"],
  },
  {
    // https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide
    // gives ~/.workbuddy/mcp.json for every project.
    id: "workbuddy",
    name: "WorkBuddy",
    setup: "file",
    apps: ["WorkBuddy.app"],
    home: [[".workbuddy"]],
    files: [{ path: [".workbuddy", "mcp.json"], format: "mcp-servers-json" }],
  },
  { id: "other", name: "", setup: "manual" },
];

/**
 * Agents IncarnaMind used to write settings into and no longer lists. A
 * pairing made then keeps working, and Disconnect still takes out the entry
 * IncarnaMind wrote, from the file it wrote it to.
 */
const RETIRED_SETTINGS_FILES: Readonly<Record<string, readonly SettingsFile[]>> = {
  "gemini-cli": [{ path: [".gemini", "settings.json"], format: "mcp-servers-json" }],
  "kimi-code": [{ path: [".kimi-code", "mcp.json"], format: "mcp-servers-json" }],
  "qwen-code": [{ path: [".qwen", "settings.json"], format: "mcp-servers-json" }],
  codebuddy: [{ path: [".codebuddy", ".mcp.json"], format: "mcp-servers-json" }],
  "minimax-code": [{ path: [".minimax", "mcp.json"], format: "mcp-servers-json" }],
};

/** The settings files IncarnaMind may have written for a pairing's agent, listed or retired. */
export function settingsFilesFor(client: string | null): readonly SettingsFile[] {
  if (client === null) return [];
  return (
    clientDefinition(client)?.files ??
    (Object.hasOwn(RETIRED_SETTINGS_FILES, client) ? RETIRED_SETTINGS_FILES[client] : undefined) ??
    []
  );
}

/** The Agent Skill's file in an agent's skills folder, or null if the agent has none. */
export function skillPathFor(home: string, client: string | null): string | null {
  const folder = clientDefinition(client)?.skills;
  return folder ? join(home, ...folder, SKILL_NAME, "SKILL.md") : null;
}

export function clientDefinition(id: unknown): ClientDefinition | null {
  return AGENT_CLIENT_DEFINITIONS.find((each) => each.id === id) ?? null;
}

/** Whether the agent looks installed: its app, or the folder it keeps its settings in. */
export function isInstalled(
  client: ClientDefinition,
  where: { home: string; applications: readonly string[] },
  exists: (path: string) => boolean,
): boolean {
  if (client.home?.some((segments) => exists(join(where.home, ...segments)))) return true;
  return (
    client.apps?.some((app) => where.applications.some((dir) => exists(join(dir, app)))) ?? false
  );
}

/** The server's entry, as most agents' `mcpServers` settings take it. */
export const serverEntry = (launch: AgentLaunch) => ({
  command: launch.command,
  args: launch.args,
  env: launch.env,
});

/** Settings to paste: `{ "mcpServers": { "incarnamind": … } }`. */
export const mcpServersSnippet = (launch: AgentLaunch) =>
  `${JSON.stringify({ mcpServers: { [SERVER_KEY]: serverEntry(launch) } }, null, 2)}\n`;

/** A word quoted for the User's shell: Windows' (PowerShell) or a POSIX one. */
function quote(word: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${word.replaceAll('"', '`"')}"`;
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The line that adds IncarnaMind to Claude Code, for every project. */
export function claudeCodeCommand(launch: AgentLaunch, platform: NodeJS.Platform): string {
  const env = Object.entries(launch.env).flatMap(([name, value]) => [
    "--env",
    quote(`${name}=${value}`, platform),
  ]);
  return [
    "claude mcp add --scope user",
    // Claude Code's variadic --env consumes a server name placed after it (#1998).
    SERVER_KEY,
    ...env,
    "--",
    quote(launch.command, platform),
    ...launch.args.map((arg) => quote(arg, platform)),
  ].join(" ");
}

/** Cursor's install link: it shows the server and asks the User to install it. */
export function cursorLink(launch: AgentLaunch): string {
  const config = Buffer.from(JSON.stringify(serverEntry(launch))).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_KEY}&config=${encodeURIComponent(config)}`;
}

/** A TOML basic string: JSON's escapes are TOML's. */
const tomlString = (value: string) => JSON.stringify(value);

/**
 * Codex's table for IncarnaMind. `ask` writes a whole Answer (47 s at the
 * 95th percentile under load in the agent evaluation), close to Codex's
 * default Tool timeout of 60 s, so IncarnaMind's Tools get 2 minutes.
 */
export function codexTable(launch: AgentLaunch): string {
  const env = Object.entries(launch.env)
    .map(([name, value]) => `${name} = ${tomlString(value)}`)
    .join(", ");
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
    "tool_timeout_sec = 120",
    "",
  ].join("\n");
}

/** Codex's settings with IncarnaMind's table in place of any it had, or added at the end. */
export function withCodexTable(before: string | null, table: string): string {
  const text = before ?? "";
  const without = withoutCodexTable(text);
  const base = without.trimEnd();
  return base === "" ? table : `${base}\n\n${table}`;
}

/** Codex's settings without IncarnaMind's table; unchanged if it has none. */
export function withoutCodexTable(text: string): string {
  const lines = text.split("\n");
  const header = `[mcp_servers.${SERVER_KEY}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return text;
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Whether a settings file holds nothing but the empty frame IncarnaMind's entry left. */
export function isEmptySettings(format: SettingsFormat, text: string): boolean {
  if (text.trim() === "") return true;
  if (format === "codex-toml") return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const entries = Object.entries(parsed);
    const [only] = entries;
    return (
      entries.length === 1 &&
      only?.[0] === "mcpServers" &&
      typeof only[1] === "object" &&
      only[1] !== null &&
      Object.keys(only[1]).length === 0
    );
  } catch {
    return false;
  }
}

/**
 * An `mcpServers` settings file with IncarnaMind's entry set (`entry`) or
 * taken out (null). Throws when the file isn't a JSON object, so nothing of
 * the User's is lost: they are given the settings to paste instead.
 */
export function withMcpServersEntry(before: string | null, entry: object | null): string {
  let settings: Record<string, unknown> = {};
  if (before !== null && before.trim() !== "") {
    const parsed: unknown = JSON.parse(before);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("The settings file isn't a JSON object.");
    }
    settings = parsed as Record<string, unknown>;
  }
  const servers = settings.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null)) {
    throw new Error("The settings file's mcpServers isn't an object.");
  }
  const next: Record<string, unknown> = { ...(servers as Record<string, unknown> | undefined) };
  if (entry) next[SERVER_KEY] = entry;
  else delete next[SERVER_KEY];
  return `${JSON.stringify({ ...settings, mcpServers: next }, null, 2)}\n`;
}

/** A settings text with the pairing's key hidden. */
export const hideToken = (text: string, token: string) =>
  token === "" ? text : text.replaceAll(token, HIDDEN_KEY);
