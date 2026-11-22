/**
 * Where each way into Settings › AI lands (#3645). Your AI leads the page, so a way that sets up or
 * fixes a model asks for the model ("model": the quiet row with none set up, What each job uses with
 * one), a way to the User's own AI opens the page at its top, and a link to the Agents page, which
 * is gone, lands on AI.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatReadiness, ProviderErrorKind } from "../../src/core/api";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
const view = page.defaultView;
const methods = new Proxy(
  { on: () => () => undefined },
  {
    get: (each, name) =>
      name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
  },
);
Object.assign(view, { incarnamind: methods, incarnamindFiles: methods });
for (const [name, value] of Object.entries({
  document: page,
  window: view,
  HTMLElement: view.HTMLElement,
  requestAnimationFrame: () => 0,
})) {
  vi.stubGlobal(name, value);
}
vi.stubGlobal("navigator", { userAgent: "node" });

const { useAppStore } = await import("../../src/renderer/src/store");
const { fixAction } = await import("../../src/renderer/src/fixAction");
const { ANSWER_PROBLEMS } = await import("../../src/renderer/src/problems");
const { wayBackRun } = await import("../../src/renderer/src/routeSignIn");
const { yoursWordsOf } = await import("../../src/shared/commands");
// Loaded by path, as the other component tests are: the node typecheck reads no JSX.
const readinessPath = "../../src/renderer/src/components/providers/ChatReadinessNotice.tsx";
const {
  readinessAction,
}: {
  readinessAction(
    readiness: Extract<ChatReadiness, { ready: false }>,
    t: (key: string) => string,
    openSettings: (page: string, at?: string) => void,
    label: string,
  ): { onClick(): void };
} = await import(readinessPath);

const t = (key: string) => key;

beforeEach(() => {
  useAppStore.setState({ settingsOpen: false, settingsPage: "general", settingsAt: null });
});

describe("a link to the Agents page", () => {
  test("opens AI at its top, where Your AI is", () => {
    useAppStore.getState().openSettings("agents" as never);
    expect(useAppStore.getState().settingsPage).toBe("ai");
    expect(useAppStore.getState().settingsAt).toBeNull();
    useAppStore.getState().showSettingsPage("agents" as never);
    expect(useAppStore.getState().settingsPage).toBe("ai");
  });
});

describe("a way that sets up or fixes a model", () => {
  test("every Answer problem whose fix is choosing a model opens the model", () => {
    const opened: unknown[][] = [];
    for (const [kind, problem] of Object.entries(ANSWER_PROBLEMS)) {
      // A refused key opens its own provider's page instead (`useKeyRefusals`).
      if (kind === "auth" || problem.fix.kind !== "settings") continue;
      const action = fixAction(
        problem.fix,
        {
          kind: kind as ProviderErrorKind,
          providerId: "anthropic",
          modelId: "claude-haiku-5-5",
          failedAt: null,
          onOpenSettings: (...args) => opened.push([kind, ...args]),
        },
        t as never,
      );
      action?.onClick();
    }
    expect(opened).toEqual([
      ["api-key-unreadable", "ai", "model"],
      ["model", "ai", "model"],
      ["consent-declined", "privacy", undefined],
      ["data-retention", "ai", "model"],
      ["refused", "ai", "model"],
      ["out-of-credit", "ai", "model"],
      ["region", "ai", "model"],
      ["window-too-small", "ai", "model"],
      ["cut-short-small-window", "ai", "model"],
      ["cost-cap", "ai", "spending-cap"],
      ["blocked", "ai", "model"],
    ]);
  });

  test("a plan's way back by a key, the assistant's “your keys” and a readiness to fix open it too", () => {
    const opened: unknown[][] = [];
    wayBackRun("claude-account", "paste-api-key", {
      onOpenSettings: (...args) => opened.push(args),
    })?.();
    expect(opened).toEqual([["ai", "model"]]);
    expect(yoursWordsOf("keys").opens).toEqual({ settings: "ai", at: "model" });
    expect(yoursWordsOf("spending").opens).toEqual({ settings: "ai", at: "spending-cap" });

    const readiness = (reason: string) =>
      ({ ready: false, reason }) as Extract<ChatReadiness, { ready: false }>;
    for (const [reason, landing] of [
      ["no-provider", ["ai", "model"]],
      ["missing-api-key", ["ai", "model"]],
      ["consent-declined", ["privacy", undefined]],
    ] as const) {
      const seen: unknown[][] = [];
      readinessAction(readiness(reason), t, (...args) => seen.push(args), "Set up").onClick();
      expect(seen, reason).toEqual([landing]);
    }
  });
});

describe("every place that opens Settings › AI with no spot named", () => {
  const source = join(__dirname, "../../src/renderer/src");
  const files = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(folder, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [join(folder, entry.name)]
          : [],
    );
  const naming = (pattern: RegExp) =>
    files(source)
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(source, file).split(sep).join("/"))
      .sort();

  test("is a way to the User's own AI, which leads the page, so a new one has to say where it goes", () => {
    expect(naming(/(openSettings|showSettingsPage|showPage)\(\s*["']ai["']\s*\)/)).toEqual([
      // The Get started card's agent step, and its foot naming what was set.
      "components/FirstOpenSteps.tsx",
      "components/firstRun/CardTail.tsx",
      // Organize, a meeting's notes and its summary, when the agent can't read what they need.
      "components/library/OrganizeAsk.tsx",
      "components/meetings/MeetingAgentNotes.tsx",
      "components/meetings/MeetingSummaryProblem.tsx",
      // The Claude app shortcut, when the Note isn't in a Folder it can read.
      "components/providers/ModelSetupCard.tsx",
      // A refused key: the page then opens that provider's own page.
      "keyRefusals.ts",
    ]);
  });

  test("and nothing names the Agents page", () => {
    expect(naming(/(openSettings|showSettingsPage|showPage)\(\s*["']agents["']/)).toEqual([]);
  });
});
