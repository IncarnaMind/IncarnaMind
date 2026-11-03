import { beforeAll, describe, expect, test, vi } from "vitest";
import type { WindowCommandRequest } from "../../src/core/api";
import { ACCEPT_SUGGESTIONS } from "../../src/shared/commands";

/*
 * The window's half of a command the assistant runs (#1421): it tells the core the command
 * started as soon as it runs, before it ends, then how it ended. A command that goes on, as a
 * Check of a long Note does, is then never called not done while it runs.
 */

const heard = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  answers: [] as { requestId: string; result: unknown }[],
  accepted: [] as unknown[][],
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
      acceptAssignments: async (...args: unknown[]) => {
        heard.accepted.push(args);
        return [];
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
  wall: null,
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

  // protects=a command that names no ids acts only on what the core checked against the Folder wall (#2243); fails_when=it acts on what the window's own lists hold when it runs; no_claim=what the core checks.
  test("a command that names no ids is given what the core checked, and nothing else", async () => {
    const run = vi.fn();
    const remove = registry.commands.register({
      id: "test.noIds",
      label: "mind.open",
      group: "main",
      reversible: true,
      run,
    });
    try {
      const checked = [{ kind: "document" as const, id: "memo", into: "general" }];
      heard.handlers.get("command.windowRun")?.({ ...request("test.noIds"), targets: checked });
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(run.mock.calls[0]?.[0]).toMatchObject({ checked, selection: [] });
    } finally {
      remove();
      heard.answers.length = 0;
    }
  });

  // protects=To review's Accept all, run for the assistant, accepts what the core checked, for the Folder each was checked against (#2243); fails_when=it accepts every suggestion the window's lists hold when it runs; no_claim=the core's own check of those Folders.
  test("Accept all accepts only the suggestions the core checked, for the Folders it checked", async () => {
    const { suggestionCommands } = await import("../../src/renderer/src/commands/suggestions");
    const { useAppStore } = await import("../../src/renderer/src/store");
    const { useLibraryFolds } = await import("../../src/renderer/src/libraryFolds");
    const acceptAll = suggestionCommands.find((each) => each.id === ACCEPT_SUGGESTIONS);
    if (!acceptAll) throw new Error("Accept all isn't a command.");
    const waiting = (documentId: string, groupId: string) => ({
      documentId,
      groupId,
      source: "automatic",
      suggested: true,
      status: "classified",
    });
    useAppStore.setState({
      documents: [
        { id: "memo", name: "Memo", tagging: null },
        { id: "late", name: "Late", tagging: null },
      ],
      library: { groups: [], assignments: [waiting("memo", "general"), waiting("late", "a")] },
    } as never);
    useLibraryFolds.setState({ reviewShown: true });
    const remove = registry.commands.register(acceptAll);
    try {
      heard.handlers.get("command.windowRun")?.({
        ...request(ACCEPT_SUGGESTIONS),
        targets: [{ kind: "document", id: "memo", into: "general" }],
        wall: "a",
      });
      await vi.waitFor(() => expect(heard.accepted).toHaveLength(1));
      expect(heard.accepted[0]).toEqual([["memo"], { memo: "general" }, "a"]);
    } finally {
      remove();
      heard.answers.length = 0;
      heard.accepted.length = 0;
    }
  });

  // protects=the assistant's Accept, run for it on named Documents, accepts for the Folders and wall the core checked (#2250); fails_when=it accepts the window's own waiting list instead; no_claim=the core's own check.
  test("Accept accepts only the Documents the core checked, for the Folders and wall it checked", async () => {
    const { suggestionCommands } = await import("../../src/renderer/src/commands/suggestions");
    const { useAppStore } = await import("../../src/renderer/src/store");
    const accept = suggestionCommands.find((each) => each.id === "document.accept");
    if (!accept) throw new Error("Accept isn't a command.");
    useAppStore.setState({
      documents: [
        { id: "memo", name: "Memo", tagging: null },
        { id: "late", name: "Late", tagging: null },
      ],
      library: {
        groups: [],
        assignments: [
          {
            documentId: "memo",
            groupId: "general",
            source: "automatic",
            suggested: true,
            status: "classified",
          },
          {
            documentId: "late",
            groupId: "a",
            source: "automatic",
            suggested: true,
            status: "classified",
          },
        ],
      },
    } as never);
    const remove = registry.commands.register(accept);
    try {
      heard.handlers.get("command.windowRun")?.({
        ...request("document.accept"),
        targets: [{ kind: "document", id: "memo", into: "general" }],
        wall: "a",
      });
      await vi.waitFor(() => expect(heard.accepted).toHaveLength(1));
      expect(heard.accepted[0]).toEqual([["memo"], { memo: "general" }, "a"]);
    } finally {
      remove();
      heard.answers.length = 0;
      heard.accepted.length = 0;
    }
  });

  // protects=a window command that fails with the core's words passes those words back, for the assistant's card in the interface's language (#2243); fails_when=the card gets only the raw error text; no_claim=which commands fail.
  test("a command that fails with the core's words passes them back", async () => {
    const { NotFoundError } = await import("../../src/core/errors");
    const { errorForWindow } = await import("../../src/shared/errorWording");
    const remove = registry.commands.register({
      id: "test.refused",
      label: "mind.open",
      group: "main",
      reversible: true,
      run: () =>
        Promise.reject(errorForWindow(new NotFoundError({ key: "error.folder.suggestionMoved" }))),
    });
    try {
      heard.handlers.get("command.windowRun")?.(request("test.refused"));
      await vi.waitFor(() =>
        expect(heard.answers.at(-1)?.result).toMatchObject({
          ran: false,
          wording: { key: "error.folder.suggestionMoved" },
        }),
      );
      const said = heard.answers.at(-1)?.result as { why: string };
      expect(said.why).toBe(
        "Not accepted: a suggested Folder changed after the assistant checked it, so nothing was accepted. You can accept them yourself in To review.",
      );
    } finally {
      remove();
      heard.answers.length = 0;
    }
  });
});
