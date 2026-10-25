/**
 * What the two outside harnesses share (README.md): how one is started and
 * read, one turn at a time, and what a turn gives back. Each run gets a
 * temporary home and config folder of its own, signed in only by the key in
 * its environment, and no environment of this process but PATH.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { TokenUsage } from "../../src/core/runs/engine";

/** How a harness starts IncarnaMind's MCP server: the bake-off's shim. */
export interface McpServer {
  command: string;
  args: string[];
  /** Set for the shim; the pairing's token is not among them (`secretEnv`). */
  env: Record<string, string>;
  /** The pairing's token, for the shim: only ever in an environment, never on a command line or in a file. */
  secretEnv: Record<string, string>;
}

export interface OutsideRunOptions {
  /** The User's turns, asked one after another in one session. */
  turns: readonly string[];
  model: string;
  /** "low", "medium" or "high", as each harness names it. */
  effort: string;
  /** The Agent Skill's text, given as instructions of the harness's own. */
  instructions: string;
  server: McpServer;
  /** IncarnaMind's Tools the harness may call, by their names on the server. */
  tools: readonly string[];
  /** The run's own folders: a temporary home, config folder and working folder. */
  home: string;
  configDir: string;
  workDir: string;
  /** Each event the harness printed, as it printed it. */
  eventsFile: string;
  timeoutMs: number;
}

export interface OutsideTurn {
  reply: string;
  status: "done" | "failed" | "timed-out";
  error: string | null;
  /** The model's usage over the turn, as the harness reported it. */
  usage: Required<TokenUsage>;
  /** What the harness said the turn cost, when it says (Claude Code). */
  reportedCostUsd: number | null;
  /** The Tools the harness offered the model, as it listed them (Claude Code's `init`). */
  toolsOffered: string[] | null;
  /** The Tool calls the harness made itself, by name: none should be a built-in one. */
  calls: string[];
  /** From starting the harness to its session being ready. */
  startupMs: number;
  /** From starting the harness to its final reply. */
  totalMs: number;
}

export const NO_TOKENS: Required<TokenUsage> = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
};

export interface Spawned {
  code: number | null;
  timedOut: boolean;
  stderr: string;
  totalMs: number;
}

/**
 * Starts a harness and hands each line it prints to `onLine`, with the time
 * since it started, keeping every line in `eventsFile`. Stopped after `timeoutMs`.
 */
export function runLines(options: {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string | null;
  eventsFile: string;
  timeoutMs: number;
  onLine(line: string, atMs: number): void;
}): Promise<Spawned> {
  return new Promise((resolve) => {
    const started = performance.now();
    const at = () => Math.round(performance.now() - started);
    const child = spawn(options.bin, options.args, {
      env: options.env,
      cwd: options.cwd,
      stdio: [options.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.stdin !== null) child.stdin?.end(options.stdin);
    const { stdout, stderr: errors } = child;
    if (!stdout || !errors) throw new Error("The harness started without its output streams.");
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      appendFileSync(options.eventsFile, chunk);
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) options.onLine(line, at());
      }
    });
    errors.setEncoding("utf8");
    errors.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const rest = buffer.trim();
      if (rest) options.onLine(rest, at());
      resolve({ code, timedOut, stderr, totalMs: at() });
    });
  });
}

/** A JSON line as an object; null for anything else. */
export function jsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The last lines of a harness's error output, as the reason a turn failed. */
export const lastLines = (stderr: string) => stderr.trim().split("\n").slice(-3).join(" ");

/** A child's environment: PATH and its own settings, nothing else of this process's. */
export function childEnv(
  options: OutsideRunOptions,
  own: Record<string, string>,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: options.home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    ...options.server.secretEnv,
    ...own,
  };
}
