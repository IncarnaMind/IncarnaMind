/**
 * One run of the User's own Codex command line for a check they pressed (ADR-0032, ADR-0035,
 * #3639): `codex exec` in the User's own Codex folder, signed in as they set it up, held to
 * IncarnaMind's server and the check's Tools. What holds it, in order: a model catalog built from
 * the installed binary with the fields that give Codex its own tools turned off, so the request
 * lists only IncarnaMind's Tools and Codex refuses any other call before it runs; a free preflight
 * (`codex debug prompt-input`) that must print exactly that list for the model Codex will use, or
 * the check goes by its link; the grant on IncarnaMind's side; and a watch on the event stream that
 * stops the run at anything but its words, its reasoning and calls to the allowed Tools.
 *
 * Everything the run writes (Codex's state and log databases, which hold the Note's text, the
 * catalog, the preflight's own Codex folder) is in a private folder of the run's, removed when it
 * ends and swept at the next start if the app didn't live to remove it.
 */
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnAiFailure, OwnAiProgress, OwnAiStatus } from "../core/adapters";
import type { AgentLaunch } from "../core/api";
import {
  findOnPath,
  object,
  older,
  processes,
  readJsonLines,
  realPathOf,
  StalledError,
  short,
  UnreadableLineError,
} from "./agentCommand";

/**
 * The only Codex the run was proven on: its catalog fields, the refusals before dispatch, nothing
 * written in the User's Codex folder and the preflight (ADR-0035). A later one runs only once its
 * preflight prints the expected list.
 */
export const LOWEST_CODEX = "0.170.0";

const SERVER = "incarnamind";
const RUN_FOLDER_PREFIX = "incarnamind-codex-";
/** The file `runFolder` writes first, so the sweep removes only folders it made. */
const RUN_MARK = ".incarnamind-codex-run";
const CATALOG = "catalog.json";
/** As long as a Tool of IncarnaMind's may take; Codex's own default is a minute. */
const TOOL_TIMEOUT_SEC = 120;

/** What Codex itself offers the model besides a server's Tools: its resource operations, which reach only IncarnaMind's server. */
const RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Each model's metadata, as the catalog gives it to Codex: no code mode, patch, sub-agents or search tool. */
const TOOL_FIELDS = {
  tool_mode: "direct",
  apply_patch_tool_type: null,
  multi_agent_version: null,
  experimental_supported_tools: [],
  supports_search_tool: false,
};

/**
 * Codex 0.170.0's features that would give the model a tool, an app or a hook, or leave something
 * behind: a shell snapshot, written into the User's Codex folder, holds Codex's environment and so
 * the grant; a daemon would outlive the run; the rest write there too once on. A name this Codex
 * doesn't know fails the preflight, so a renamed one leaves the check to the link.
 */
const FEATURES_OFF = [
  "shell_snapshot",
  "daemon_auto_start",
  "local_thread_store_compression",
  "background_paginated_rollout_migration",
  "use_agent_identity",
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "hooks",
  "view_image",
  "memories",
  "goals",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "tool_suggest",
  "skill_search",
  "sleep_tool",
  "multi_agent",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
  "remote_plugin",
  "plugin_sharing",
  "in_app_chat",
  "in_app_local_automation",
];

/**
 * A value of Codex's `-c key=value`, which it reads as TOML: a JSON string or array is one. What
 * Windows' cmd.exe acts on is written as a TOML escape, so a path holding `&` or `%` reaches Codex
 * whole through npm's `codex.cmd`, whose `%*` reads the command line a second time.
 */
const toml = (value: string | readonly string[]) =>
  JSON.stringify(value).replace(
    /[&|<>^%!()]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** A path names Codex's copy inside an app (ChatGPT.app's, or a Windows app's), which IncarnaMind never starts. */
const inApp = (path: string) =>
  path.split(/[\\/]/).some((part) => /\.app$/i.test(part) || part.toLowerCase() === "windowsapps");

/** Where Codex is on the login shell's PATH, as a terminal finds it, unless it is a copy inside an app. */
export async function findCodex(command: string): Promise<string | null> {
  const found = await findOnPath(command);
  if (!found || inApp(await realPathOf(found))) return null;
  return found;
}

/**
 * Whether Codex can run a check here: `--version` at least LOWEST_CODEX and `codex login status`
 * exiting 0, nothing else of what they print read. Anything else is "unsupported", for the link.
 */
export async function codexStatus(path: string): Promise<OwnAiStatus> {
  const version = await short(path, ["--version"]);
  if (version.kind === "absent") return { kind: "missing" };
  const found = version.kind === "exited" ? version.out.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
  if (version.kind !== "exited" || version.code !== 0 || !found || older(found, LOWEST_CODEX)) {
    console.info(
      `Codex ${found ?? "(no version)"} runs no check here; the check goes by its link.`,
    );
    return { kind: "unsupported" };
  }
  const login = await short(path, ["login", "status"]);
  if (login.kind === "exited" && login.code === 0) return { kind: "ready" };
  console.info("Codex isn't signed in here, or didn't say; the check goes by its link.");
  return { kind: "unsupported" };
}

/** Removes the folders of runs whose app is gone: Codex's log database in one holds Note text. */
export async function sweepCodexRuns(folder = tmpdir()): Promise<void> {
  const names = await readdir(folder).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(name.slice(RUN_FOLDER_PREFIX.length).split("-")[0]);
      if (!name.startsWith(RUN_FOLDER_PREFIX) || !Number.isInteger(pid) || alive(pid)) return;
      const ours = await access(join(folder, name, RUN_MARK)).then(
        () => true,
        () => false,
      );
      if (!ours) return;
      await rm(join(folder, name), { recursive: true, force: true, maxRetries: 3 }).catch(
        (error: unknown) =>
          console.warn("Could not remove a Codex run's folder left behind:", errorCode(error)),
      );
    }),
  );
}

const alive = (pid: number) => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another account's process with that id: not ours to judge.
    return errorCode(error) === "EPERM";
  }
};

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "unknown";

interface Folder {
  root: string;
  work: string;
  /** The preflight's and the catalog's own Codex folder, never the User's. */
  codexHome: string;
}

async function runFolder(): Promise<Folder> {
  const root = await mkdtemp(join(tmpdir(), `${RUN_FOLDER_PREFIX}${process.pid}-`));
  const folder = { root, work: join(root, "work"), codexHome: join(root, "codex-home") };
  try {
    await writeFile(join(root, RUN_MARK), "", { mode: 0o600 });
    for (const each of [folder.work, folder.codexHome, join(root, "sqlite"), join(root, "logs")]) {
      await mkdir(each, { mode: 0o700 });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    throw error;
  }
  return folder;
}

/** The catalog's model entries, as `codex debug models --bundled` prints them. */
const modelsOf = (catalog: unknown): Record<string, unknown>[] | null => {
  const models = object(catalog).models;
  return Array.isArray(models) &&
    models.length > 0 &&
    models.every((each) => typeof object(each).slug === "string")
    ? models.map(object)
    : null;
};

/**
 * The model Codex uses with no model set, from the catalog as Codex 0.170.0 chooses it: by
 * priority, the first its picker lists, among those a sign-in to ChatGPT may use (all), or an API
 * key (those `supported_in_api`).
 */
const defaultModel = (models: Record<string, unknown>[], apiKey: boolean) =>
  [...models]
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .find((each) => each.visibility === "list" && (!apiKey || each.supported_in_api === true))
    ?.slug;

/** The model Codex would use with none set, signed in to ChatGPT and with an API key. */
interface Defaults {
  signedIn: string;
  apiKey: unknown;
}

/**
 * Writes the catalog built from the installed binary into the run's folder, and gives the models
 * Codex could use there with none set: null when the binary gives none IncarnaMind can read.
 */
async function writeCatalog(
  path: string,
  folder: Folder,
  signal: AbortSignal,
): Promise<Defaults | null> {
  const printed = await short(path, ["debug", "models", "--bundled"], {
    env: { CODEX_HOME: folder.codexHome },
    cwd: folder.work,
    signal,
  });
  if (printed.kind !== "exited" || printed.code !== 0) return null;
  let models: Record<string, unknown>[] | null;
  try {
    models = modelsOf(JSON.parse(printed.stdout));
  } catch {
    models = null;
  }
  if (!models) return null;
  try {
    await writeFile(
      join(folder.root, CATALOG),
      JSON.stringify({ models: models.map((model) => ({ ...model, ...TOOL_FIELDS })) }),
      { mode: 0o600 },
    );
  } catch (error) {
    console.info("Could not write the run's model catalog:", errorCode(error));
    return null;
  }
  const signedIn = defaultModel(models, false);
  const apiKey = defaultModel(models, true);
  return typeof signedIn === "string" ? { signedIn, apiKey } : null;
}

/** What a run and its preflight are both given: everything but the subcommand and the prompt. */
function overrides(
  folder: Folder,
  server: AgentLaunch,
  tools: readonly string[],
  instructions: string,
): string[] {
  const set = (key: string, value: string) => ["-c", `${key}=${value}`];
  const mcp = `mcp_servers.${SERVER}`;
  return [
    ...set("sandbox_mode", toml("read-only")),
    ...set("approval_policy", toml("never")),
    ...set(`${mcp}.command`, toml(server.command)),
    ...set(`${mcp}.args`, toml(server.args)),
    // The grant reaches the server from Codex's environment, by name: never on the command line.
    ...set(`${mcp}.env_vars`, toml(Object.keys(server.env))),
    ...set(`${mcp}.enabled_tools`, toml(tools)),
    ...set(`${mcp}.default_tools_approval_mode`, toml("approve")),
    ...set(`${mcp}.required`, "true"),
    ...set(`${mcp}.tool_timeout_sec`, String(TOOL_TIMEOUT_SEC)),
    ...FEATURES_OFF.flatMap((feature) => ["--disable", feature]),
    ...set("features.multi_agent_v2", "{disable_native_tools=true}"),
    ...set("tools.experimental_request_user_input", "{enabled=false}"),
    ...set("web_search", toml("disabled")),
    ...set("project_doc_max_bytes", "0"),
    ...set("history.persistence", toml("none")),
    ...set("analytics.enabled", "false"),
    ...set("skills.bundled.enabled", "false"),
    ...set("skills.include_instructions", "false"),
    ...set("include_apps_instructions", "false"),
    ...set("notify", "[]"),
    ...set("otel.exporter", toml("none")),
    ...set("otel.trace_exporter", toml("none")),
    ...set("sqlite_home", toml(join(folder.root, "sqlite"))),
    ...set("log_dir", toml(join(folder.root, "logs"))),
    ...set("model_catalog_json", toml(join(folder.root, CATALOG))),
    // As TOML, a line break is written `\n`: none reaches the command line, which on Windows
    // cmd.exe would cut at it.
    ...set("developer_instructions", toml(instructions)),
  ];
}

/**
 * The Tools a preflight's input list offers the model, by namespace; null where it can't be read,
 * or where an item of another kind carries tools, which this reading wouldn't count.
 */
function toolsOffered(printed: string): string[] | null {
  let items: unknown;
  try {
    items = JSON.parse(printed);
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const names: string[] = [];
  for (const item of items.map(object)) {
    if (item.type !== "additional_tools") {
      if ("tools" in item) return null;
      continue;
    }
    if (!Array.isArray(item.tools)) return null;
    for (const space of item.tools.map(object)) {
      if (!Array.isArray(space.tools)) {
        names.push(String(space.name ?? space.type));
        continue;
      }
      for (const tool of space.tools.map(object)) names.push(`${space.name}.${tool.name}`);
    }
  }
  return names;
}

/**
 * Whether Codex, given the run's settings in a Codex folder of the run's own, offers the model
 * exactly IncarnaMind's allowed Tools and Codex's resource operations, for each model it could use:
 * with none set, as there, where no sign-in is and the API key's default applies, and the default
 * of a sign-in to ChatGPT where that is another model.
 */
async function preflight(
  path: string,
  folder: Folder,
  server: AgentLaunch,
  tools: readonly string[],
  instructions: string,
  defaults: Defaults,
  signal: AbortSignal,
): Promise<boolean> {
  const expected = [
    ...RESOURCE_TOOLS.map((tool) => `functions.${tool}`),
    ...tools.map((tool) => `mcp__${SERVER}.${tool}`),
  ].sort();
  const pins = [null, ...(defaults.apiKey === defaults.signedIn ? [] : [defaults.signedIn])];
  const offered = await Promise.all(
    pins.map(async (model) => {
      const printed = await short(
        path,
        [
          "debug",
          "prompt-input",
          ...overrides(folder, server, tools, instructions),
          ...(model ? ["-c", `model=${toml(model)}`] : []),
        ],
        { env: { ...server.env, CODEX_HOME: folder.codexHome }, cwd: folder.work, signal },
      );
      return printed.kind === "exited" && printed.code === 0 ? toolsOffered(printed.stdout) : null;
    }),
  );
  const unexpected = offered.find(
    (names) => names === null || JSON.stringify([...names].sort()) !== JSON.stringify(expected),
  );
  if (unexpected === undefined) return true;
  if (signal.aborted) return false;
  console.info(
    "Codex's preflight didn't list the check's Tools alone; the check goes by its link. It listed:",
    unexpected === null ? "(nothing it could read)" : [...unexpected].sort().join(" "),
  );
  return false;
}

export interface CodexRun {
  /** Where Codex is, as `findCodex` found it. */
  path: string;
  server: AgentLaunch;
  tools: readonly string[];
  instructions: string;
  prompt: string;
  signal: AbortSignal;
  maxBytes: number;
  stallMs: number;
  progress?(step: OwnAiProgress): void;
  /** As the request is about to reach the model: Codex started its turn. */
  started?(): void;
}

export type CodexEnd =
  | { kind: "finished"; reply: string }
  | { kind: "failed"; reason: OwnAiFailure; cause?: string };

/** The run showed something no check run should, and was stopped. */
class OutsideError extends Error {
  constructor(
    readonly reason: "outside" | "unreadable",
    what: string,
  ) {
    super(`A check run on Codex showed ${what}, so it was stopped.`);
    this.name = "OutsideError";
  }
}

/** Runs the check, from the catalog and the preflight to the end of Codex's turn. */
export async function runCodex(run: CodexRun): Promise<CodexEnd> {
  const folder = await runFolder().catch((error: unknown) => {
    console.info(
      "Could not make a Codex run's folder; the check goes by its link.",
      errorCode(error),
    );
    return null;
  });
  if (folder === null) return { kind: "failed", reason: "unsupported" };
  try {
    run.signal.throwIfAborted();
    const defaults = await writeCatalog(run.path, folder, run.signal);
    run.signal.throwIfAborted();
    if (!defaults) {
      console.info("Codex gave no model catalog IncarnaMind can read; the check goes by its link.");
      return { kind: "failed", reason: "unsupported" };
    }
    const offered = await preflight(
      run.path,
      folder,
      run.server,
      run.tools,
      run.instructions,
      defaults,
      run.signal,
    );
    run.signal.throwIfAborted();
    if (!offered) return { kind: "failed", reason: "unsupported" };
    return await execute(run, folder);
  } finally {
    await rm(folder.root, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) =>
      console.warn("Could not remove the folder of a Codex run:", errorCode(error)),
    );
  }
}

async function execute(run: CodexRun, folder: Folder): Promise<CodexEnd> {
  const child = await processes
    .spawn(
      run.path,
      [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...overrides(folder, run.server, run.tools, run.instructions),
        "-",
      ],
      { cwd: folder.work, env: { ...run.server.env }, processGroup: true },
    )
    .catch((error: unknown) => {
      // Gone or unrunnable since its preflight: nothing reached a model.
      console.info("Codex didn't start its turn; the check goes by its link.", errorCode(error));
      return null;
    });
  if (child === null) return { kind: "failed", reason: "unsupported" };
  let begun = false;
  let reply = "";
  let notice = "";
  let toldHeard = 0;
  // Its error stream until its turn starts, whole, so the grant can be taken out before anything is
  // cut. Only its last line, Codex's own error, reaches the log: with RUST_LOG set in the User's
  // shell, the rest is Codex's debug output.
  let errors: string | undefined = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (begun || errors === undefined) return;
    errors += chunk;
    if (errors.length > STDERR_KEPT) errors = undefined;
  });
  // The calls of IncarnaMind's Tools under way: the run waits on them silently.
  const calls = new Set<string>();
  const allowed = (item: Record<string, unknown>) =>
    item.type === "mcp_tool_call" &&
    typeof item.tool === "string" &&
    ((item.server === SERVER && run.tools.includes(item.tool)) || resourceCall(item));
  try {
    return await readJsonLines<CodexEnd>(child, {
      agent: "Codex",
      signal: run.signal,
      maxBytes: run.maxBytes,
      rawMaxBytes: run.maxBytes,
      stallMs: run.stallMs,
      busy: () => calls.size > 0,
      begin(stdin) {
        stdin.end(run.prompt);
      },
      onMessage(message) {
        if (performance.now() - toldHeard >= 1_000) {
          toldHeard = performance.now();
          run.progress?.({ kind: "heard" });
        }
        switch (message.type) {
          case "thread.started":
            return undefined;
          case "turn.started":
            if (!begun) run.started?.();
            begun = true;
            return undefined;
          // A notice from Codex's service: a retry, or the reason a turn is about to fail.
          case "error":
            notice = String(message.message ?? "").slice(0, 300);
            return undefined;
          case "turn.completed":
            return begun ? { kind: "finished", reply } : undefined;
          case "turn.failed": {
            const cause = String(object(message.error).message ?? notice).slice(0, 300);
            return begun
              ? { kind: "failed", reason: "service", cause }
              : { kind: "failed", reason: "unsupported", cause };
          }
          case "item.started":
          case "item.updated":
          case "item.completed":
            break;
          default:
            throw new OutsideError(
              "unreadable",
              `an event it doesn't know (${String(message.type)})`,
            );
        }
        const item = object(message.item);
        if (!begun) throw new OutsideError("unreadable", "an item before its turn started");
        if (item.type === "agent_message") {
          if (message.type === "item.completed" && typeof item.text === "string") {
            reply = item.text;
            run.progress?.({ kind: "said", text: item.text });
          }
          return undefined;
        }
        if (item.type === "reasoning") {
          run.progress?.({ kind: "thinking" });
          return undefined;
        }
        // Codex's own notice in the stream, not an action.
        if (item.type === "error") {
          notice = String(item.message ?? "").slice(0, 300);
          return undefined;
        }
        if (!allowed(item)) {
          throw new OutsideError("outside", `an item of its own (${String(item.type)})`);
        }
        const id = String(item.id);
        if (message.type === "item.started") {
          calls.add(id);
          run.progress?.({ kind: "tool", name: String(item.tool) });
        } else if (message.type === "item.completed") {
          calls.delete(id);
        }
        return undefined;
      },
    });
  } catch (error) {
    // Ended before its turn started (settings this Codex didn't take, a server that didn't start,
    // something it printed that no turn of a check shows): nothing reached the model, so the check
    // goes by its link.
    if (!begun && !run.signal.aborted && !(error instanceof StalledError)) {
      console.info(
        "Codex ended before its turn started; the check goes by its link.",
        error instanceof Error ? error.message : "",
        lastLine(redacted(errors ?? "", run.server.env)).slice(0, MAX_LOGGED_STDERR),
      );
      return { kind: "failed", reason: "unsupported" };
    }
    if (error instanceof OutsideError) {
      console.warn(error.message);
      return { kind: "failed", reason: error.reason };
    }
    if (error instanceof UnreadableLineError) return { kind: "failed", reason: "unreadable" };
    throw error;
  }
}

/** As much of Codex's last error line as the log keeps. */
const MAX_LOGGED_STDERR = 300;
/** Past this much before its turn, nothing of Codex's error stream is logged. */
const STDERR_KEPT = 1_000_000;

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/**
 * A resource operation that asks IncarnaMind's server alone, which serves none. Codex 0.170.0 shows
 * one naming no server under its own name, and it asks every server configured, one a managed
 * configuration adds among them, so it stops the run; one naming a server Codex doesn't have comes
 * as no item and asks none.
 */
function resourceCall(item: Record<string, unknown>): boolean {
  return (
    typeof item.tool === "string" &&
    RESOURCE_TOOLS.includes(item.tool) &&
    item.server === SERVER &&
    object(item.arguments).server === SERVER
  );
}

/** `text` with every value of the server's variables, the grant among them, taken out. */
const redacted = (text: string, env: Record<string, string>) =>
  Object.values(env)
    .filter((value) => value.length >= 8)
    .reduce((kept, value) => kept.split(value).join("[hidden]"), text);
