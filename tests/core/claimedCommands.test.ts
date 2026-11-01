import { describe, expect, test } from "vitest";
import type {
  ApprovalRequest,
  ConversationAnswer,
  Core,
  WindowCommandRequest,
  WindowCommandResult,
} from "../../src/core";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import type { OfferedCommand } from "../../src/shared/commands";
import { translate } from "../../src/shared/i18n";
import { answerRequests, askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

/**
 * A reply that says it did something in the app that no call did (#2407): the check of what a
 * reply claims reads it against the record of what each call did (ran, refused, failed, not
 * allowed, or never made), asks the model once with that record, and a reply that still says it
 * keeps a line under it. What only the User changes is named on that line, so "I've turned on
 * Local mode" never reads as done. The assistant's calls and replies are scripted, and so is the
 * judge, which here flags a claim only by its sentence; what a real judge makes of a reply is for
 * the live probes (tests/live/claimedCommands.live.test.ts).
 */

const DOCUMENTS = [
  { name: "Lease Harbour Street.md", contents: "# Harbour Street\n\nThe rent is 900 euros.\n" },
  { name: "Lease Mill Lane.md", contents: "# Mill Lane\n\nThe rent is due quarterly.\n" },
  { name: "Q3 commentary.md", contents: "# Q3\n\nRevenue grew 4%.\n" },
];

const entry = (id: OfferedCommand["id"], label: string, more: Partial<OfferedCommand> = {}) => ({
  id,
  label,
  purpose: null,
  on: null,
  deletes: false,
  final: false,
  recording: null,
  yours: null,
  ...more,
});

const WINDOW = "test-window";
const FROM_WINDOW = {
  clientId: WINDOW,
  commands: [
    entry("document.openBeside", "Open in a split on the right", { on: ["document"] }),
    entry("settings.open", "Open Settings"),
  ],
};

type Step = (results: ModelCall["results"]) => { tool: string; input: unknown };

const idsFound = (results: ModelCall["results"]): string[] => {
  const listed = results.filter((each) => each.tool === "list_commands").at(-1)?.text ?? "";
  return [...listed.matchAll(/^- (\S+): /gm)].map((match) => match[1] ?? "");
};

const find =
  (name: string): Step =>
  () => ({ tool: "list_commands", input: { kind: "document", name } });

const run =
  (command: string, input: Record<string, unknown> = {}, found = true): Step =>
  (results) => ({
    tool: "run_command",
    input: { command, ...(found && { ids: idsFound(results) }), ...input },
  });

/** The judge's verdict, from the reply it was given: each of `claims` it holds is unbacked. */
const judging =
  (claims: { sentence: string; about: string }[], seen: GenerateCall[]) => (call: GenerateCall) => {
    if (call.system.includes(CLAIM_CHECK_INSTRUCTIONS)) seen.push(call);
    const reply = /<reply>\n([\s\S]*)\n<\/reply>/.exec(call.prompt)?.[1] ?? "";
    return {
      text: JSON.stringify({
        claims: claims
          .filter((claim) => reply.includes(claim.sentence))
          .map((claim) => ({ ...claim, kind: "changed", backed: false })),
      }),
    };
  };

/** Makes these calls, one a step, then replies `reply`, also when asked once more. */
function assistant(
  reply: string,
  steps: Step[],
  claims: { sentence: string; about: string }[] = [],
) {
  const judged: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      const made = call.results.filter((each) => /^(?:list_commands|run_command)$/.test(each.tool));
      const step = steps[made.length];
      return step ? { calls: [step(call.results)] } : { text: reply };
    },
    { generate: judging(claims, judged) },
  );
  return { model, judged };
}

function windowOf(core: Core, answer: (request: WindowCommandRequest) => WindowCommandResult) {
  core.on("command.windowRun", (request) => {
    if (request.clientId !== WINDOW) return;
    void core.answerWindowCommand(request.requestId, answer(request));
  });
}

const denying = (core: Core) => {
  const asked: ApprovalRequest[] = [];
  core.on("approval.requested", (request) => {
    asked.push(request);
    void core.respondToApproval(request.requestId, "deny");
  });
  return asked;
};

const askedAgain = (model: ReturnType<typeof assistant>["model"]) =>
  answerRequests(model)
    .map((call) => JSON.stringify(call.prompt))
    .filter((prompt) => prompt.includes("but no Tool did that"));

const judgedReply = (call: GenerateCall | undefined) =>
  /<reply>\n([\s\S]*)\n<\/reply>/.exec(call?.prompt ?? "")?.[1] ?? null;

const lines = (answer: ConversationAnswer) => ({
  commands: answer.steps?.unbackedCommands ?? [],
  claims: answer.steps?.unbackedClaims ?? [],
});

describe("A reply that says it changed what only the User changes (#2407)", {
  timeout: 60_000,
}, () => {
  // protects=after Local mode is refused and the split opens, a reply that says Local mode is on is asked about once with the record, which says the refusal changed nothing; still saying so, it keeps its words, the refusal's line follows them, and the line under it names Local mode as unchanged, in English and Chinese; fails_when=the reply goes unchallenged, the ask lacks the record, the line is "Nothing was written", or Local mode changes; no_claim=what a real model writes when asked again.
  test.each([
    {
      text: "Turn on Local mode, then open Mill Lane beside this note",
      language: "en" as const,
      reply: "Local mode is on now, and Mill Lane is open beside your note.",
      claim: "Local mode is on now",
    },
    {
      text: "先打开本地模式，再在旁边打开 Mill Lane",
      language: "zh-CN" as const,
      reply: "已经为你开启本地模式，Mill Lane 也在右边打开了。",
      claim: "已经为你开启本地模式",
    },
  ])("“$text”: asked once, then a line says Local mode wasn't changed", async (each) => {
    const { model, judged } = assistant(
      each.reply,
      [
        run("settings.change", { setting: "localMode", value: "on" }, false),
        find("Mill Lane"),
        run("document.openBeside"),
      ],
      [{ sentence: each.claim, about: "local_mode" }],
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    windowOf(core, () => ({ ran: true, changed: false }));
    const before = (await core.getEmbeddingSettings()).localOnly;

    const answer = await askAssistant(core, {
      text: each.text,
      mindId: mind.id,
      ...FROM_WINDOW,
    });

    const [ask] = askedAgain(model);
    expect(askedAgain(model)).toHaveLength(1);
    expect(ask).toContain(
      "- run_command settings.change: refused, since only the User changes it, so nothing changed",
    );
    expect(ask).toContain("changed Local mode or what goes to cloud services");
    expect(ask).toContain("Don't run again a command that was refused");
    expect(judged).toHaveLength(2);
    expect(lines(answer)).toEqual({ commands: ["privacy"], claims: [] });
    expect(answer.text).toBe(
      `${each.reply}\n\n${translate(each.language, "commands.yours.privacy")}`,
    );
    expect((await core.getEmbeddingSettings()).localOnly).toBe(before);
    core.close();
  });

  // protects=the same turn answered honestly is judged once, never asked about, and has no line; fails_when=an honest reply is asked again or flagged; no_claim=none beyond protects.
  test.each([
    { language: "en" as const, reply: "Mill Lane is open beside your note." },
    { language: "zh-CN" as const, reply: "Mill Lane 已在右边打开。" },
  ])("an honest reply to it is left alone: $reply", async ({ reply }) => {
    const { model, judged } = assistant(
      reply,
      [
        run("settings.change", { setting: "localMode", value: "on" }, false),
        find("Mill Lane"),
        run("document.openBeside"),
      ],
      [{ sentence: "Local mode is on", about: "local_mode" }],
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    windowOf(core, () => ({ ran: true, changed: false }));

    const answer = await askAssistant(core, {
      text: "Turn on Local mode, then open Mill Lane beside this note",
      mindId: mind.id,
      ...FROM_WINDOW,
    });

    expect(judged).toHaveLength(1);
    expect(askedAgain(model)).toEqual([]);
    expect(lines(answer)).toEqual({ commands: [], claims: [] });
    core.close();
  });

  // protects=a claim of the app that stands names every one of what the turn refused as the User's alone, whatever the judge took it to be about, besides the command it claims; fails_when=the spending cap isn't named under a reply that misreports the turn; no_claim=none beyond protects.
  test("a claim in the app that stands names what the turn refused, too", async () => {
    const reply = "Harbour Street now reads Harbour 2026.";
    const { model } = assistant(
      reply,
      [
        run("settings.change", { setting: "monthlyCap", value: "50" }, false),
        find("Harbour Street"),
        run("document.rename", { ids: ["no-such-id"], name: "Harbour 2026" }, false),
      ],
      [{ sentence: "now reads Harbour 2026", about: "app" }],
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await askAssistant(core, {
      text: "Raise my cap to 50 dollars and rename Harbour Street to Harbour 2026",
      mindId: mind.id,
      ...FROM_WINDOW,
    });

    expect(lines(answer)).toEqual({ commands: ["spending", "command"], claims: [] });
    expect((await core.listDocuments()).map((each) => each.name)).not.toContain("Harbour 2026");
    core.close();
  });
});

describe("A reply that says a command ran that didn't (#2407)", { timeout: 60_000 }, () => {
  // protects=a claim of a command the window couldn't run, one the User didn't allow, and one no call made is each asked about once and, still claimed, keeps the line that not everything in the app was done, in English and Chinese, with nothing of the User's alone named; fails_when=any goes unflagged, is flagged as a Note's change, or names a refusal the turn didn't have; no_claim=the line's words, which tests/shared/unbackedCommands.test.ts holds.
  test.each([
    {
      how: "failed",
      reply: "I've opened Settings for you.",
      steps: [run("settings.open", {}, false)],
      window: { ran: false, why: "It didn't run.", wording: null } as WindowCommandResult,
    },
    {
      how: "not allowed",
      reply: "已经删除了 Q3 commentary。",
      steps: [find("Q3 commentary"), run("document.delete")],
      window: { ran: true, changed: false } as WindowCommandResult,
    },
    {
      how: "never made",
      reply: "Done: Harbour Street is in a split on the right now.",
      steps: [],
      window: { ran: true, changed: false } as WindowCommandResult,
    },
  ])("$how: “$reply” keeps a line", async ({ reply, steps, window }) => {
    const { model, judged } = assistant(reply, steps, [{ sentence: reply, about: "app" }]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    windowOf(core, () => window);
    denying(core);

    const answer = await askAssistant(core, {
      text: "Do it for me",
      mindId: mind.id,
      ...FROM_WINDOW,
    });

    expect(askedAgain(model)).toHaveLength(1);
    expect(judged).toHaveLength(2);
    expect(lines(answer)).toEqual({ commands: ["command"], claims: [] });
    expect(answer.text).toBe(reply);
    core.close();
  });

  // protects=the judge reads, for each call, what it did: done, refused as the User's alone, failed, or not allowed by the User; fails_when=a refused call reads as done (its status is done), or a denied one has no outcome; no_claim=how a real judge reads them.
  test("the judge reads each call's outcome", async () => {
    const { model, judged } = assistant("Here is where things stand.", [
      run("settings.change", { setting: "monthlyCap", value: "5" }, false),
      run("settings.open", {}, false),
      find("Q3 commentary"),
      run("document.delete"),
      find("Mill Lane"),
      run("document.openBeside"),
    ]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    let opened = 0;
    windowOf(core, () =>
      opened++ === 0
        ? { ran: false, why: "It didn't run.", wording: null }
        : { ran: true, changed: false },
    );
    denying(core);

    await askAssistant(core, { text: "Do these", mindId: mind.id, ...FROM_WINDOW });

    const outcomes = [
      ...(judged[0]?.prompt ?? "").matchAll(
        /"tool": "(\w+)",\s+"status": "\w+",\s+"outcome": "([^"]+)"/g,
      ),
    ].map((match) => `${match[1]}: ${match[2]}`);
    expect(outcomes).toEqual([
      "run_command: refused: the User's alone",
      "run_command: failed",
      "list_commands: done",
      "run_command: not allowed by the User",
      "list_commands: done",
      "run_command: done",
    ]);
    core.close();
  });
});

describe("The refusal's own line is never read as a claim (#2407)", { timeout: 60_000 }, () => {
  // protects=a reply that copies the refusal's line is judged without it, and one that is only the line isn't judged at all, in English and Chinese; fails_when=the judge reads the app's own sentence as the reply's; no_claim=none beyond protects.
  test.each([
    { language: "en" as const, rest: "Harbour Street is open beside your note." },
    { language: "zh-CN" as const, rest: "Harbour Street 已在右边打开。" },
  ])("$language: the judge gets the reply without it", async ({ language, rest }) => {
    const said = translate(language, "commands.yours.privacy");
    for (const reply of [`${said} ${rest}`, said]) {
      const { model, judged } = assistant(reply, [
        run("settings.change", { setting: "localMode", value: "on" }, false),
        find("Harbour Street"),
        run("document.openBeside"),
      ]);
      const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
      windowOf(core, () => ({ ran: true, changed: false }));

      await askAssistant(core, {
        text: "Turn on Local mode, then open Harbour Street beside my note",
        mindId: mind.id,
        ...FROM_WINDOW,
      });

      if (reply === said) {
        expect(judged).toEqual([]);
      } else {
        expect(judgedReply(judged[0])?.trim()).toBe(rest);
      }
      core.close();
    }
  });
});
