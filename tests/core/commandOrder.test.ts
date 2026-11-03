import { describe, expect, test } from "vitest";
import type { Findable } from "../../src/core/tools/commands/find";
import type { CommandsHost } from "../../src/core/tools/commands/run";
import { createCommandSteps } from "../../src/core/tools/commands/steps";
import { commandTools } from "../../src/core/tools/commands/tools";
import type { OfferedCommand } from "../../src/shared/commands";

/*
 * The calls of one step are checked as they arrive, and each check waits for the calls checked
 * before it to run, so it sees what they changed (#2252). A call that is never run, because the
 * User stopped the Answer while it waited, must not leave a later check waiting.
 */

const NOTHING: Findable = {
  documents: [],
  minds: [],
  library: { groups: [], assignments: [] },
  tags: [],
  deleted: [],
};

const check: OfferedCommand = {
  id: "mind.check",
  label: "Check",
  purpose: null,
  on: null,
  deletes: false,
  final: false,
  recording: null,
  yours: null,
};

/** Commands with no window to run in: a refusal runs, a window command's run fails. */
function commandsFor(signal: AbortSignal) {
  const ran: string[] = [];
  const commands = commandTools({
    host: {} as CommandsHost,
    findable: async () => NOTHING,
    filing: () => null,
    focusedMindId: null,
    titledPages: [],
    renames: [],
    answerId: "answer",
    runId: "run",
    steps: createCommandSteps(),
    offered: [check],
    clientId: null,
    language: "en",
    found: () => undefined,
    ran: (toolCallId) => ran.push(toolCallId),
    failed: () => undefined,
    ended: () => undefined,
    signal,
  });
  const [, runTool] = commands.tools;
  if (!runTool) throw new Error("No run_command.");
  const run = (toolCallId: string) => runTool.call({}, { toolCallId, signal });
  return { commands, run, ran };
}

const localMode = { command: "settings.change", setting: "localMode", value: "on" };
const spending = { command: "settings.change", setting: "monthlyCap", value: "10" };

/** Whether a promise has settled by the time everything queued so far has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  return done;
}

describe("A call's check waits for the calls before it, and never for one that won't run (#2252)", () => {
  // protects=a check waits while the call before it is checked and not yet run, then goes on once it ran; fails_when=the second check goes on before the first ran; no_claim=what each command does.
  test("the second check waits until the first has run", async () => {
    const { commands, run } = commandsFor(new AbortController().signal);
    await commands.check("first", localMode, false);
    const second = commands.check("second", spending, false);
    expect(await settled(second)).toBe(false);
    await run("first");
    await expect(second).resolves.toMatchObject({ checked: { yours: "spending" } });
  });

  // protects=Stop while the first call waits for the User leaves no check waiting and runs nothing: the waiting check is refused, and so is any check after the Stop; fails_when=the second check never settles, or a command runs; no_claim=the Answer's own stopped state, which the core test holds.
  test("stopped while the first waits, the second check is refused and nothing runs", async () => {
    const stop = new AbortController();
    const { commands, ran } = commandsFor(stop.signal);
    await commands.check("first", localMode, false);
    const second = commands.check("second", spending, false);
    stop.abort();
    await expect(second).rejects.toThrow();
    await expect(commands.check("third", spending, false)).rejects.toThrow();
    expect(ran).toEqual([]);
  });

  // protects=a first call the User didn't allow lets the next check go on; fails_when=the next check waits for a call that will never run; no_claim=the approval card.
  test("the first not allowed, the second goes on", async () => {
    const { commands } = commandsFor(new AbortController().signal);
    await commands.check("first", localMode, false);
    const second = commands.check("second", spending, false);
    commands.drop("first");
    await expect(second).resolves.toMatchObject({ checked: { yours: "spending" } });
  });

  // protects=a first call whose run fails lets the next check go on; fails_when=the next check waits forever after a failed run; no_claim=the failure's words.
  test("the first fails as it runs, the second goes on", async () => {
    const { commands, run } = commandsFor(new AbortController().signal);
    await commands.check("first", { command: "mind.check" }, false);
    const second = commands.check("second", spending, false);
    await expect(run("first")).rejects.toThrow();
    await expect(second).resolves.toMatchObject({ checked: { yours: "spending" } });
  });

  // protects=three calls in a chain, stopped after the first ran and while the second waits to run: the third check is refused, and the second never runs; fails_when=the third check never settles, or the second runs; no_claim=the order the model gives them.
  test("three in a chain, stopped in the middle", async () => {
    const stop = new AbortController();
    const { commands, run, ran } = commandsFor(stop.signal);
    await commands.check("first", localMode, false);
    await run("first");
    await commands.check("second", spending, false);
    const third = commands.check("third", localMode, false);
    expect(await settled(third)).toBe(false);
    stop.abort();
    await expect(third).rejects.toThrow();
    expect(ran).toEqual(["first"]);
  });
});
