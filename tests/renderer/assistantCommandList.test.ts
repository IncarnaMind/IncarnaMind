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
    mindId: null,
    clientId: "window",
    command: command.id,
    targets: kind && isTarget(kind) ? [{ kind, id: "one" }] : [],
  };
};

describe("The assistant's commands are the window's one list (#1421)", () => {
  // protects=every command of ⌘K the assistant may run is offered to it, with what the entry says it acts on and does, and none it may not; fails_when=a new command needs an assistant-side change, or an excluded one is offered as runnable; no_claim=what each command does.
  test("every command the assistant may run is offered, as its entry says", () => {
    offerEverything();
    const offered = new Map(window.offeredCommands(null).map((entry) => [entry.id, entry]));
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
        listens: command.listens === true,
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
      const { started, ended } = window.startForAssistant(asked);
      expect(started, command.id).toBe(true);
      const { result } = await ended;
      expect(result, command.id).toEqual({ ran: true, changed: false });
      const run = runs.get(command.id);
      expect(run, command.id).toHaveBeenCalledTimes(1);
      const [target] = asked.targets;
      if (target) expect(run?.mock.calls[0]?.[0]?.focus, command.id).toEqual(target);
      walked.push(command.id);
    }
    expect(walked.length).toBeGreaterThan(100);
  });

  // protects=with nothing found, a command acts on the Note the Question was asked from, even while a Document opened beside it is in front ("Check this Note" after "open … beside this one"); fails_when=it isn't offered, or acts on the Document; no_claim=what the check finds.
  test("with nothing found, a command acts on the Note asked from, even with a Document in front", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    const check = registry.commands.get("mind.check");
    if (!check) throw new Error("No Check command.");
    const run = vi.fn();
    stubbed.push({ command: check, when: check.when, enabled: check.enabled, run: check.run });
    check.run = run;
    useAppStore.setState({
      layout: {
        groups: [
          {
            id: "left",
            tabs: [{ id: "t1", item: { kind: "mind", mindId: "note" } }],
            activeTabId: "t1",
            width: 1,
          },
          {
            id: "right",
            tabs: [{ id: "t2", item: { kind: "document", documentId: "one" } }],
            activeTabId: "t2",
            width: 1,
          },
        ],
        focusedGroupId: "right",
        reopenable: 0,
      } as never,
    });
    try {
      expect(window.offeredCommands(null).map((each) => each.id)).not.toContain("mind.check");
      expect(window.offeredCommands("note").map((each) => each.id)).toContain("mind.check");
      const { result } = await window.startForAssistant({
        requestId: "request",
        answerId: "answer",
        toolCallId: "call",
        run: "run",
        mindId: "note",
        clientId: "window",
        command: "mind.check",
        targets: [],
      }).ended;
      expect(result).toEqual({ ran: true, changed: false });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ focus: { kind: "mind", id: "note" } }),
      );
    } finally {
      useAppStore.setState({ layout: null });
    }
  });

  // protects=a command that goes on, as a Check does, has started as soon as it runs, and hands back its change only when it ends; fails_when=the window waits for its end to say it started, or its change is lost; no_claim=any real command.
  test("one that goes on has started at once, and hands back its change when it ends", async () => {
    let finish: (change: { said: () => string; undo: () => Promise<void> }) => void = () => {};
    const remove = registry.commands.register({
      id: "test.goesOn",
      label: "mind.open",
      group: "main",
      reversible: true,
      run: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    try {
      const { started, ended } = window.startForAssistant({
        requestId: "request",
        answerId: "answer",
        toolCallId: "call",
        run: "run",
        mindId: null,
        clientId: "window",
        command: "test.goesOn",
        targets: [],
      });
      expect(started).toBe(true);
      let settled = false;
      void ended.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      const change = { said: () => "Done", undo: async () => undefined };
      finish(change);
      await expect(ended).resolves.toEqual({ result: { ran: true, changed: true }, change });
    } finally {
      remove();
    }
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
      expect(
        window.offeredCommands(null).find((each) => each.id === "test.addedLater"),
      ).toMatchObject({
        on: ["document"],
        yours: null,
      });
      const { result } = await window.startForAssistant({
        requestId: "request",
        answerId: "answer",
        toolCallId: "call",
        run: "run",
        mindId: null,
        clientId: "window",
        command: "test.addedLater",
        targets: [{ kind: "document", id: "one" }],
      }).ended;
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
        const { result } = await window.startForAssistant(request(command)).ended;
        expect(result.ran, command.id).toBe(false);
      }
    }
  });

  // protects=what is the User's own word ("Checked by me", "Mark as mine") is the User's alone by name; tabs, how the User arranges the window, and the file pickers, which wait for the User's choice, are not the assistant's; starting a recording or turning the microphone on asks first; fails_when=one of them is offered as runnable, or a recording command runs unasked; no_claim=what each command does.
  test("sign-offs and Mark as mine are the User's; tabs and pickers are left out; recording asks", () => {
    offerEverything();
    const offered = new Map(window.offeredCommands(null).map((entry) => [entry.id, entry]));
    for (const id of [
      "citation.signOff",
      "citation.signOffRemove",
      "figure.signOff",
      "figure.signOffRemove",
      "figures.signOffChosen",
      "comparison.column.reviewed",
      "comparison.cell.reviewed",
    ])
      expect(offered.get(id as OfferedCommand["id"])?.yours, id).toBe("signOff");
    expect(offered.get("edit.markAsMine")?.yours).toBe("authorship");
    const tabs = registry.commands
      .all()
      .filter((command) => /^(?:tab|group)\./.test(command.id))
      .map((command) => command.id);
    expect(tabs.length).toBeGreaterThan(10);
    for (const id of [
      ...tabs,
      "documents.add",
      "documents.addFilesOrFolder",
      "linkedFolder.add",
      "word.import",
      "verify.document",
      "references.import",
    ])
      expect(offered.has(id as OfferedCommand["id"]), id).toBe(false);
    for (const id of ["meeting.record", "memo.record", "meeting.pauseResume", "meeting.microphone"])
      expect(offered.get(id as OfferedCommand["id"])?.listens, id).toBe(true);
    expect(offered.get("meeting.stop")?.listens).toBe(false);
    expect(offered.get("mind.openBeside")?.yours).toBeNull();
  });

  // protects=what the core asks before running a window command comes from the real list's marks: every one that can turn recording on, can't be taken back or deletes asks, and the rest of what acts on the window runs at once; fails_when=a mark is lost between the list and the core's policy; no_claim=the card's words.
  test("the core asks first from the real list's own marks", async () => {
    offerEverything();
    const { parseOfferedCommands } = await import("../../src/core/tools/commands/offered");
    const { windowChecked } = await import("../../src/core/tools/commands/window");
    const { askOf } = await import("../../src/core/tools/commands/policy");
    const findable = {
      documents: [],
      minds: [],
      library: { groups: [], assignments: [] },
      tags: [],
      deleted: [],
    };
    const context = {
      answerId: "a",
      runId: "r",
      toolCallId: "c",
      mindId: null,
      clientId: "w",
      ended: () => undefined,
    };
    const asks = new Map<string, string | null>();
    for (const entry of parseOfferedCommands(window.offeredCommands(null))) {
      if (entry.on !== null) continue;
      const checked = windowChecked(entry, [], findable, context, undefined);
      asks.set(entry.id, askOf(checked, { changed: 0, renames: [] })?.kind ?? null);
    }
    expect(asks.get("meeting.record")).toBe("listen");
    expect(asks.get("memo.record")).toBe("listen");
    expect(asks.get("meeting.stop")).toBe("final");
    expect(asks.get("mind.check")).toBeNull();
    for (const command of registry.commands.all()) {
      const ask = asks.get(command.id);
      if (ask === undefined || command.assistant) continue;
      const expected = command.listens
        ? "listen"
        : command.reversible !== true
          ? "final"
          : command.destructive
            ? "change"
            : null;
      expect(ask, command.id).toBe(expected);
    }
  });

  // protects=the commands the core runs itself, with arguments the window would ask the User for, are entries of the same list where ⌘K has one; fails_when=the core's and the window's names drift apart; no_claim=what the core's commands do.
  test("the commands the core runs are the list's own entries, where ⌘K has one", () => {
    offerEverything();
    const offered = new Set(window.offeredCommands(null).map((each) => each.id));
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
