import { beforeAll, describe, expect, test, vi } from "vitest";
import type { WindowCommandRequest } from "../../src/core/api";

/*
 * The window's half of a command the assistant runs (#1421): it tells the core the command
 * started as soon as it runs, before it ends, then how it ended. A command that goes on, as a
 * Check of a long Note does, is then never called not done while it runs.
 */

const heard = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  answers: [] as { requestId: string; result: unknown }[],
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {
      on: (name: string, handler: (payload: unknown) => void) => {
        heard.handlers.set(name, handler);
        return () => undefined;
      },
      answerWindowCommand: async (requestId: string, result: unknown) => {
        heard.answers.push({ requestId, result });
        return true;
      },
    },
    { get: (target, name) => Reflect.get(target, name) ?? (async () => undefined) },
  ),
  files: new Proxy({}, { get: () => async () => undefined }),
}));

type Registry = typeof import("../../src/renderer/src/commands/registry");
let registry: Registry;
let clientId: string;

beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  registry = await import("../../src/renderer/src/commands/registry");
  await import("../../src/renderer/src/assistantCommands");
  ({ clientId } = await import("../../src/renderer/src/clientId"));
});

const request = (command: WindowCommandRequest["command"]): WindowCommandRequest => ({
  requestId: "request",
  answerId: "answer",
  toolCallId: "call",
  run: "run",
  command,
  targets: [],
  mindId: null,
  clientId,
});

describe("The window says a command started, then how it ended (#1421)", () => {
  // protects=a command slower than the core's limit is answered as started at once, and its end is answered when it comes; fails_when=the window answers only at the end, so a long Check reads as not done; no_claim=the core's side, which tests/core holds.
  test("a long command is answered as started at once, then with its end", async () => {
    let finish: () => void = () => undefined;
    const remove = registry.commands.register({
      id: "test.long",
      label: "mind.open",
      group: "main",
      reversible: true,
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    try {
      heard.handlers.get("command.windowRun")?.(request("test.long"));
      await vi.waitFor(() =>
        expect(heard.answers).toEqual([{ requestId: "request", result: { started: true } }]),
      );
      finish();
      await vi.waitFor(() =>
        expect(heard.answers.at(-1)).toEqual({
          requestId: "request",
          result: { ran: true, changed: false },
        }),
      );
      expect(heard.answers).toHaveLength(2);
    } finally {
      remove();
      heard.answers.length = 0;
    }
  });

  // protects=a request for another window is left to it; fails_when=this window runs it too; no_claim=which window is in front.
  test("a request for another window is not run here", async () => {
    const run = vi.fn();
    const remove = registry.commands.register({
      id: "test.elsewhere",
      label: "mind.open",
      group: "main",
      reversible: true,
      run,
    });
    try {
      heard.handlers.get("command.windowRun")?.({
        ...request("test.elsewhere"),
        clientId: "another window",
      });
      await Promise.resolve();
      expect(run).not.toHaveBeenCalled();
      expect(heard.answers).toEqual([]);
    } finally {
      remove();
    }
  });
});
