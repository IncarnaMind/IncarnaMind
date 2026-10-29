import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Command } from "../../src/renderer/src/commands/registry";
import {
  COMMAND_TARGETS,
  type CommandTarget,
  isCommandId,
  type OfferedCommand,
  YOURS,
} from "../../src/shared/commands";

/*
 * The assistant's commands are the window's one command list, the one ⌘K shows (#1421): this walks
 * every registered command, so a command added to the list is checked with no edit here, and none
 * needs an assistant-side change to be the assistant's. What it acts on, whether it deletes or
 * can't be taken back, and whether it is the User's alone come from the entry itself.
 */

type Registry = typeof import("../../src/renderer/src/commands/registry");
type Window = typeof import("../../src/renderer/src/assistantWindow");
type Catalogue = typeof import("../../src/core/tools/commands/catalogue");

let registry: Registry;
let window: Window;
let catalogue: Catalogue;

beforeAll(async () => {
  // The commands reach the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  registry = await import("../../src/renderer/src/commands/registry");
  window = await import("../../src/renderer/src/assistantWindow");
  catalogue = await import("../../src/core/tools/commands/catalogue");
});

/** What each command's own conditions were, put back after a test stubs them. */
const stubbed: {
  command: Command;
  when: Command["when"];
  enabled: Command["enabled"];
  run: Command["run"];
}[] = [];

afterEach(() => {
  for (const { command, when, enabled, run } of stubbed.splice(0)) {
    command.when = when;
    command.enabled = enabled;
    command.run = run;
  }
});

/** Every command offered and enabled, as if the window were in each state its `when` asks for. */
function offerEverything(): Map<string, ReturnType<typeof vi.fn>> {
  const runs = new Map<string, ReturnType<typeof vi.fn>>();
  for (const command of registry.commands.all()) {
    stubbed.push({ command, when: command.when, enabled: command.enabled, run: command.run });
    const run = vi.fn();
    command.when = () => true;
    command.enabled = () => true;
    command.run = run;
    runs.set(command.id, run);
  }
  return runs;
}

const neverOf = (command: Command) => (command.assistant ? command.assistant.never : undefined);

const isTarget = (kind: string): kind is CommandTarget =>
  COMMAND_TARGETS.some((each) => each === kind);

/** The assistant's: in ⌘K, not marked as never its own, and acting on the window or on what it finds. */
const isTheAssistants = (command: Command) =>
  command.palette !== false &&
  command.assistant !== false &&
  !neverOf(command) &&
  (!command.appliesTo || command.appliesTo.some(isTarget));

const request = (command: Command) => {
  const kind = command.appliesTo?.find(isTarget);
  return {
    requestId: "request",
    answerId: "answer",
    toolCallId: "call",
    run: "run",
    command: command.id,
    targets: kind && isTarget(kind) ? [{ kind, id: "one" }] : [],
  };
};

describe("The assistant's commands are the window's one list (#1421)", () => {
  // protects=every command of ⌘K the assistant may run is offered to it, with what the entry says it acts on and does, and none it may not; fails_when=a new command needs an assistant-side change, or an excluded one is offered as runnable; no_claim=what each command does.
  test("every command the assistant may run is offered, as its entry says", () => {
    offerEverything();
    const offered = new Map(window.offeredCommands().map((entry) => [entry.id, entry]));
    for (const command of registry.commands.all()) {
      const entry = offered.get(command.id);
      if (!isTheAssistants(command)) {
        const never = neverOf(command);
        if (never) {
          expect(entry?.yours, command.id).toBe(never);
        } else {
          expect(entry, command.id).toBeUndefined();
        }
        continue;
      }
      expect(entry, command.id).toEqual<OfferedCommand>({
        id: command.id,
        label: expect.any(String),
        purpose: command.purpose ? expect.any(String) : null,
        on: command.appliesTo ? command.appliesTo.filter(isTarget) : null,
        deletes: command.destructive === true && command.reversible === true,
        final: command.reversible !== true,
        yours: null,
      } as OfferedCommand);
      expect(entry?.label.trim(), command.id).not.toBe("");
    }
  });

  // protects=every command the assistant may run runs through its path in the window, as ⌘K runs it, on what it found or on the window in front; fails_when=one doesn't reach its own run, or acts on something else; no_claim=the commands the core runs itself, which tests/core holds.
  test("each runs through the assistant's path, as ⌘K runs it, on what was found", async () => {
    const runs = offerEverything();
    const walked: string[] = [];
    for (const command of registry.commands.all().filter(isTheAssistants)) {
      const asked = request(command);
      const { result } = await window.runForAssistant(asked);
      expect(result, command.id).toEqual({ ran: true, changed: false });
      const run = runs.get(command.id);
      expect(run, command.id).toHaveBeenCalledTimes(1);
      const [target] = asked.targets;
      if (target) expect(run?.mock.calls[0]?.[0]?.focus, command.id).toEqual(target);
      walked.push(command.id);
    }
    expect(walked.length).toBeGreaterThan(100);
  });

  // protects=a command added to the list is the assistant's at once, with no assistant-side change; fails_when=it isn't offered or doesn't run; no_claim=any real command.
  test("a command added to the list is the assistant's at once", async () => {
    const ran = vi.fn();
    const remove = registry.commands.register({
      id: "test.addedLater",
      label: "mind.open",
      group: "main",
      appliesTo: ["document"],
      reversible: true,
      run: ran,
    });
    try {
      expect(window.offeredCommands().find((each) => each.id === "test.addedLater")).toMatchObject({
        on: ["document"],
        yours: null,
      });
      const { result } = await window.runForAssistant({
        requestId: "request",
        answerId: "answer",
        toolCallId: "call",
        run: "run",
        command: "test.addedLater",
        targets: [{ kind: "document", id: "one" }],
      });
      expect(result).toEqual({ ran: true, changed: false });
      expect(ran).toHaveBeenCalledWith(
        expect.objectContaining({ focus: { kind: "document", id: "one" } }),
      );
    } finally {
      remove();
    }
  });

  // protects=what only the User changes is never the assistant's: keys and sign-ins, Local mode and what leaves the computer, and deleting for good; fails_when=one is offered as runnable, or runs from the assistant's path; no_claim=Settings' own switches, which the core's settings command names.
  test("keys, sign-ins, Local mode, consent and deleting for good are the User's alone", async () => {
    offerEverything();
    const yours = (id: string) => (isCommandId(id) ? registry.commands.get(id)?.assistant : null);
    for (const id of [
      "settings.addProvider",
      "chatgpt.continue",
      "claude.signIn",
      "answer.useAnotherKey",
    ])
      expect(yours(id), id).toEqual({ never: "keys" });
    for (const id of ["settings.localMode", "suggestions.toggle"])
      expect(yours(id), id).toEqual({ never: "privacy" });
    // Whatever deletes and can't be taken back deletes for good (ADR-0013).
    for (const command of registry.commands.all()) {
      if (command.destructive && command.reversible !== true) {
        expect(command.assistant, command.id).toEqual({ never: "permanent" });
      }
      const never = neverOf(command);
      if (never) {
        expect(YOURS, command.id).toContain(never);
        const { result } = await window.runForAssistant(request(command));
        expect(result.ran, command.id).toBe(false);
      }
    }
  });

  // protects=the commands the core runs itself, with arguments the window would ask the User for, are entries of the same list where ⌘K has one; fails_when=the core's and the window's names drift apart; no_claim=what the core's commands do.
  test("the commands the core runs are the list's own entries, where ⌘K has one", () => {
    offerEverything();
    const offered = new Set(window.offeredCommands().map((each) => each.id));
    const listed = Object.keys(catalogue.CORE_COMMANDS)
      .filter(isCommandId)
      .filter((id) => registry.commands.get(id));
    expect(listed.sort()).toEqual(
      [
        "document.delete",
        "document.moveTo",
        "document.rename",
        "document.tags",
        "folder.delete",
        "folder.new",
        "folder.rename",
        "mind.citationStyle",
        "mind.delete",
        "mind.export",
        "mind.moveTo",
        "mind.rename",
        "mind.style",
        "tag.delete",
        "tag.rename",
        "deleted.restore",
      ].sort(),
    );
    for (const id of listed) expect(offered.has(id), id).toBe(true);
  });
});
