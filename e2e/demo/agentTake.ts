/**
 * What a take of the agent film is recorded with (#1812): the app's page as Chromium paints it,
 * Claude Code's turns as `claude -p` streams them, both on this computer's clock, and the
 * pointer's arrow, which a page's frames don't carry.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";

/** The app's page, in CSS pixels: half of a 1920 × 1080 frame wide, all of it high. */
export const SURFACE = { width: 960, height: 1080, scale: 2 };
/** Where the pointer waits: off the window's right edge. */
export const AWAY = SURFACE.width + 30;

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface StreamEvent {
  at: number;
  kind: "text" | "tool";
  text: string;
}

export interface Turn {
  prompt: string;
  /** When the turn started, on the computer's clock; `at` and `seconds` count from it. */
  started: number;
  events: StreamEvent[];
  /** What each check Tool answered the agent, in order. */
  checks: { tool: string; answer: string }[];
  cost: number | null;
  turns: number | null;
  seconds: number;
  refused: string[];
  stderr: string;
}

interface StreamPart {
  type: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  name?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const answerText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";

/** The app's page at the surface's size and density, whatever this computer's screen is. */
export async function atSurface(app: ElectronApplication, window: Page): Promise<void> {
  const metrics = await window.context().newCDPSession(window);
  await metrics.send("Emulation.setDeviceMetricsOverride", {
    width: SURFACE.width,
    height: SURFACE.height,
    deviceScaleFactor: SURFACE.scale,
    mobile: false,
  });
  await window.emulateMedia({ colorScheme: "light" });
  await app.evaluate(({ session }) => session.defaultSession.setSpellCheckerEnabled(false));
}

/** A page's frames as Chromium paints them, each with the time it arrived on this clock. */
export async function film(page: Page, folder: string) {
  await mkdir(folder, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames: { file: string; at: number }[] = [];
  const writes: Promise<void>[] = [];
  session.on("Page.screencastFrame", ({ data, sessionId }) => {
    const file = `${String(frames.length).padStart(6, "0")}.jpg`;
    frames.push({ file, at: Date.now() });
    writes.push(writeFile(join(folder, file), Buffer.from(data, "base64")));
    void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: SURFACE.width * SURFACE.scale,
    maxHeight: SURFACE.height * SURFACE.scale,
    everyNthFrame: 1,
  });
  return async () => {
    await session.send("Page.stopScreencast").catch(() => undefined);
    await Promise.all(writes);
    await writeFile(join(folder, "frames.json"), JSON.stringify(frames));
  };
}

/** A turn's stream as the cut reads it: each line, and beside it the second it came. */
export const keepStream = (out: string, label: string, lines: string[], times: number[]) =>
  Promise.all([
    writeFile(join(out, `${label}.stream.jsonl`), lines.map((line) => `${line}\n`).join("")),
    writeFile(join(out, `${label}.times.json`), JSON.stringify(times)),
  ]);

/**
 * Claude Code as the User has it connected, run one turn at a time: `home` is its temporary home,
 * `mcpFile` holds the one server it may use, IncarnaMind's.
 */
export function claudeCode({
  home,
  mcpFile,
  key,
  model,
  out,
}: {
  home: string;
  mcpFile: string;
  key: string;
  model: string;
  out: string;
}): (prompt: string, label: string) => Promise<Turn> {
  const work = join(home, "work");
  const env = {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    ANTHROPIC_API_KEY: key,
  };
  // Never spawnSync: Playwright must keep serving the app while the agent works.
  return async (prompt, label) => {
    await mkdir(work, { recursive: true });
    return new Promise((done) => {
      const began = Date.now();
      const child = spawn(
        "claude",
        [
          "--bare",
          "-p",
          prompt,
          "--model",
          model,
          "--mcp-config",
          mcpFile,
          "--strict-mcp-config",
          // No file or shell tool of its own: its Write is outside its sandbox and a relative
          // path climbs out of the work folder, whatever HOME says.
          "--tools",
          "",
          "--allowedTools",
          "mcp__incarnamind",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] },
      );
      const result: Turn = {
        prompt,
        started: began,
        events: [],
        checks: [],
        cost: null,
        turns: null,
        seconds: 0,
        refused: [],
        stderr: "",
      };
      const toolNames = new Map<string, string>();
      const kept: string[] = [];
      const times: number[] = [];
      let pending = "";
      child.stdout.on("data", (chunk: Buffer) => {
        const at = (Date.now() - began) / 1000;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          kept.push(line);
          times.push(at);
          let event: {
            type?: string;
            message?: { content?: StreamPart[] };
            total_cost_usd?: number;
            num_turns?: number;
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "assistant") {
            for (const part of event.message?.content ?? []) {
              if (part.type === "text" && part.text?.trim())
                result.events.push({ at, kind: "text", text: part.text.trim() });
              if (part.type === "tool_use" && part.name) {
                const name = part.name.replace("mcp__incarnamind__", "");
                if (part.id) toolNames.set(part.id, name);
                result.events.push({ at, kind: "tool", text: name });
              }
            }
          }
          if (event.type === "user") {
            for (const part of event.message?.content ?? []) {
              if (part.type !== "tool_result") continue;
              const name = toolNames.get(part.tool_use_id ?? "") ?? "";
              if (part.is_error)
                result.refused.push(`${name}: ${answerText(part.content).slice(0, 300)}`);
              if (/check/.test(name))
                result.checks.push({
                  tool: name,
                  answer: answerText(part.content).slice(0, 4000),
                });
            }
          }
          if (event.type === "result") {
            result.cost = event.total_cost_usd ?? null;
            result.turns = event.num_turns ?? null;
            result.seconds = at;
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        result.stderr += chunk;
      });
      const timer = setTimeout(() => child.kill(), 600_000);
      child.on("close", () => {
        clearTimeout(timer);
        result.seconds ||= (Date.now() - began) / 1000;
        void keepStream(out, label, kept, times).then(() => done(result));
      });
    });
  };
}

export interface Pointer {
  glide(x: number, y: number): Promise<void>;
  /** Where `target` is on the page, kept under `name` for the cut. */
  boxOf(target: Locator, name: string): Promise<Box>;
  /** The pointer comes in, clicks the middle of `target`, and stays where it clicked. */
  click(target: Locator, name: string): Promise<void>;
  leave(): Promise<void>;
  y(): number;
}

/** The pointer of a take, with an arrow drawn where it is; `rects` gets every box it is asked for. */
export async function pointer(window: Page, rects: Record<string, Box>): Promise<Pointer> {
  await window.evaluate(() => {
    const arrow = document.createElement("div");
    arrow.id = "film-pointer";
    arrow.style.cssText =
      "position:fixed;left:0;top:0;width:18px;height:26px;z-index:2147483647;pointer-events:none;will-change:transform;transform:translate(-100px,-100px)";
    arrow.innerHTML =
      '<svg width="18" height="26" viewBox="0 0 18 26"><path d="M1.5 1.5v20l4.9-4.6 3.2 7.4 2.9-1.3-3.2-7.3h6.7z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.append(arrow);
    addEventListener(
      "mousemove",
      (event) => {
        arrow.style.transform = `translate(${event.clientX - 1}px, ${event.clientY - 1}px)`;
      },
      true,
    );
  });
  let at = { x: AWAY, y: 620 };
  await window.mouse.move(at.x, at.y);
  const glide = async (x: number, y: number) => {
    const distance = Math.hypot(x - at.x, y - at.y);
    const duration = Math.min(1400, Math.max(400, distance * 2));
    const steps = Math.max(2, Math.round(duration / 16));
    const from = { ...at };
    const began = Date.now();
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const bow = Math.sin(Math.PI * eased) * Math.min(distance * 0.04, 20);
      await window.mouse.move(
        from.x + (x - from.x) * eased - ((y - from.y) / (distance || 1)) * bow,
        from.y + (y - from.y) * eased + ((x - from.x) / (distance || 1)) * bow,
      );
      await sleep(Math.max(0, began + (duration * step) / steps - Date.now()));
    }
    at = { x, y };
  };
  const boxOf = async (target: Locator, name: string): Promise<Box> => {
    const box = await target.boundingBox();
    if (!box) throw new Error(`Nothing is shown for ${name}.`);
    rects[name] = box;
    return box;
  };
  return {
    glide,
    boxOf,
    async click(target, name) {
      const box = await boxOf(target, name);
      await glide(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(250);
      await window.mouse.down();
      await sleep(70);
      await window.mouse.up();
    },
    async leave() {
      await glide(AWAY, at.y);
      // A move off the page reaches no listener: the arrow is put where the pointer went.
      await window.evaluate((x) => {
        const arrow = document.getElementById("film-pointer");
        if (arrow) arrow.style.transform = `translate(${x}px, 0)`;
      }, AWAY);
    },
    y: () => at.y,
  };
}
