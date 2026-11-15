import { readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange } from "../../src/core";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

/**
 * What the check of what a reply says it changed is sent (#2969), through the core as the assistant
 * runs a turn: the reply, the Question and a record of what its Tools did, and nothing the verdict
 * doesn't need. The check is the one that sees the record, so what is in it is what leaves the
 * computer for it: a Note or a Document by its name, never its internal id; a saved file by its
 * name, never its path; a command that failed by that it failed. The model's calls are scripted, and
 * so is the judge, which only reads what it was sent.
 */

const DOCUMENTS = [
  { name: "Northwind invoice March.md", contents: "# March\n\nNorthwind billed 1,200 euros.\n" },
  { name: "Lease Harbour Street.md", contents: "# Harbour Street\n\nThe rent is 900 euros.\n" },
];

type Step = (results: ModelCall["results"]) => { tool: string; input: unknown };

const idsFound = (results: ModelCall["results"]): string[] => {
  const listed = results.filter((each) => each.tool === "list_commands").at(-1)?.text ?? "";
  return [...listed.matchAll(/^- (\S+): /gm)].map((match) => match[1] ?? "");
};

const find =
  (name: string, kind = "document"): Step =>
  () => ({ tool: "list_commands", input: { kind, name } });

const run =
  (command: string, input: Record<string, unknown> = {}, found = true): Step =>
  (results) => ({
    tool: "run_command",
    input: { command, ...(found && { ids: idsFound(results) }), ...input },
  });

/** An internal id: every id of the app is a random UUID. */
const AN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Makes these calls, one a step, then replies `reply`; the judge reads what it is sent. */
function assistant(reply: string, steps: Step[]) {
  const judged: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      const made = call.results.filter((each) =>
        /^(?:list_commands|run_command|add_to_mind)$/.test(each.tool),
      );
      const step = steps[made.length];
      return step ? { calls: [step(call.results)] } : { text: reply };
    },
    {
      generate: (call) => {
        if (call.question === "request-done")
          return { text: '{"asks_change":"no","request":"none"}' };
        if (call.question === "claimed-changes") judged.push(call);
        return { text: '{"claims":[]}' };
      },
    },
  );
  return { model, judged };
}

/** What the claims check was sent: the whole request, its record and its focused Note included. */
const sentTo = (judged: GenerateCall[]) => {
  const [first] = judged;
  if (!first) throw new Error("The claims check was not asked.");
  return first.prompt;
};

const ADDED = "## Risks\n\nThe supplier is late.";

describe("The check of what a reply says it changed is sent no internal id (#2969)", {
  timeout: 60_000,
}, () => {
  // protects=a Note the turn added to, and the Note the User was in, reach the check by their names; fails_when=the record or the focused Note carries an internal id, so one reaches the model; no_claim=what the judge makes of the names.
  test("an add to a Note: its name, not its id", async () => {
    const { model, judged } = assistant("I added a risks section to “Tides”.", [
      () => ({ tool: "add_to_mind", input: { content: ADDED } }),
    ]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);

    await askAssistant(core, { text: "Add a risks section", mindId: mind.id });

    const sent = sentTo(judged);
    expect(sent).toContain("Tides");
    expect(sent).not.toMatch(AN_ID);
    core.close();
  });

  // protects=a Note named in Chinese, asked about in Chinese, reaches the check by its name, as an English one does; fails_when=the record or the focused Note carries an id when the names aren't English; no_claim=what the judge makes of the names.
  test("an add to a Note named in Chinese: its name, not its id", async () => {
    const { model, judged } = assistant("我已在“周报”里加了一节风险。", [
      () => ({ tool: "add_to_mind", input: { content: ADDED } }),
    ]);
    const { core } = await setUpWithDocuments(model, DOCUMENTS);
    const weekly = await core.createMind({ title: "周报" });

    await askAssistant(core, { text: "加一节风险", mindId: weekly.id });

    const sent = sentTo(judged);
    expect(sent).toContain("周报");
    expect(sent).not.toMatch(AN_ID);
    core.close();
  });

  // protects=a Document the turn renamed reaches the check by its names, and the Run it was part of by nothing; fails_when=the record carries a Document's id, the command's Run id or the ids the call was given; no_claim=what the judge makes of the names.
  test("a command that renamed a Document: its names, not its ids", async () => {
    const { model, judged } = assistant("I renamed it to “Harbour 2026”.", [
      find("Harbour Street"),
      run("document.rename", { name: "Harbour 2026" }),
    ]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);

    await askAssistant(core, { text: "Rename Harbour Street to Harbour 2026", mindId: mind.id });

    const sent = sentTo(judged);
    expect(sent).toContain("Harbour Street");
    expect(sent).toContain("Harbour 2026");
    expect(sent).not.toMatch(AN_ID);
    core.close();
  });

  // protects=a file the turn saved reaches the check by its name, never its path or the folder's; fails_when=the record carries the file's absolute path or the folder it is in, or the folder the call was given; no_claim=where the file went, which the card says.
  test("a saved file: its name, not its path", async () => {
    const output = await createTempDataFolder();
    const { model, judged } = assistant("I saved it as Tides.md.", [
      find("Tides", "mind"),
      run("mind.export", { format: "markdown" }),
    ]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    await core.setOutputLocation(output);

    await askAssistant(core, { text: "Export this note as Markdown", mindId: mind.id });

    expect(await readdir(output)).toEqual(["Tides.md"]);
    const sent = sentTo(judged);
    expect(sent).toContain("Tides.md");
    expect(sent).not.toContain(output);
    expect(sent).not.toMatch(AN_ID);
    core.close();
  });

  // protects=a setting the turn changed reaches the check by its name and its two values, and a folder it was set to by that folder's name alone; fails_when=the record carries the folder's absolute path; no_claim=every setting.
  test("a changed Output location: the folder's name, not its path", async () => {
    const output = await createTempDataFolder();
    const { model, judged } = assistant("The Output location is now set.", [
      run("settings.change", { setting: "outputLocation", value: output }, false),
    ]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    core.on("approval.requested", (request) => {
      void core.respondToApproval(request.requestId, "allow-once");
    });

    await askAssistant(core, { text: `Save new files in ${output}`, mindId: mind.id });

    const sent = sentTo(judged);
    expect(sent).toContain("outputLocation");
    expect(sent).not.toContain(output);
    expect(sent).not.toMatch(AN_ID);
    core.close();
  });

  // protects=a command that failed reaches the check as failed, with its kind, not the message it failed with; fails_when=the record carries the failure's message, which can name an item, an id or a path; no_claim=why it failed.
  test("a command that failed: that it failed, not its message", async () => {
    const { model, judged } = assistant("I renamed the file.", [
      run("document.rename", { ids: ["no-such-id"], name: "Harbour 2026" }, false),
    ]);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await askAssistant(core, { text: "Rename it", mindId: mind.id });

    const message = answer.toolCalls.find((call) => call.commandProblem)?.commandProblem?.message;
    expect(message).toBeTruthy();
    const sent = sentTo(judged);
    expect(sent).toContain("failed");
    expect(sent).not.toContain(message ?? "");
    expect(sent).not.toContain("no-such-id");
    core.close();
  });
});

const MINDS = [
  { id: "q3-a", name: "Q3 review" },
  { id: "q3-b", name: "Q3 review" },
  { id: "weekly", name: "周报" },
];
const names = (id: string) => MINDS.find((mind) => mind.id === id)?.name ?? null;

const mindCall = (
  tool: string,
  mindId: string,
  change: Partial<MindChange> = {},
): AnswerToolCall => ({
  id: `${tool}-${mindId}`,
  tool,
  source: "minds",
  input: {},
  status: "done",
  resultCount: null,
  mindChange: { mindId, created: false, request: "r1", proposals: 2, ...change },
});

const commandCall = (
  command: string,
  input: Record<string, unknown>,
  done: AnswerToolCall["command"],
  more: Partial<AnswerToolCall> = {},
): AnswerToolCall => ({
  id: command,
  tool: "run_command",
  source: "commands",
  input: { command, ...input },
  status: "done",
  resultCount: null,
  ...(done && { command: done }),
  ...more,
});

/** What the claims check is sent for a reply and these calls, as one string. */
async function recordSent(
  calls: AnswerToolCall[],
  focused: string | null = null,
  reply = "Done.",
): Promise<string> {
  const model = scriptedModel(() => ({ text: "" }), {
    generate: (call) => ({
      text:
        call.question === "request-done"
          ? '{"asks_change":"no","request":"none"}'
          : '{"claims":[]}',
    }),
  });
  await unbackedClaims(reply, calls, MINDS, focused, {
    model,
    request: "Do it.",
    names,
    signal: new AbortController().signal,
  });
  const asked = model.doGenerateCalls.find((call) =>
    JSON.stringify(call.prompt).includes("tool-record"),
  );
  return JSON.stringify(asked?.prompt);
}

describe("The record the check is sent, by name (#2969)", () => {
  // protects=two Notes that share a name reach the check by that name alone, as the reply names them, with no id and no number; fails_when=an id goes with them, or a number makes a name the reply doesn't use, which flagged an honest reply 3 times in 3 on Claude Haiku 5.5 (the gate of #2969); no_claim=which of the two the reply names.
  test("two Notes with one name are sent by that name, with no id and no number", async () => {
    const sent = await recordSent(
      [mindCall("edit_mind", "q3-a"), mindCall("edit_mind", "q3-b")],
      "q3-b",
    );

    // Two edits and the Note the User was in, each named as the reply names it.
    expect(sent.match(/\\"name\\": ?\\"Q3 review\\"/g)).toHaveLength(3);
    expect(sent).not.toContain("Q3 review (");
    expect(sent).not.toContain("q3-a");
    expect(sent).not.toContain("q3-b");
  });

  // protects=a Note with no name reaches the check as an unnamed Note; fails_when=its id goes in its place; no_claim=none.
  test("a Note with no name is an unnamed Note, not its id", async () => {
    const sent = await recordSent([mindCall("add_to_mind", "gone-1")]);

    expect(sent).toContain("unnamed Note");
    expect(sent).not.toContain("gone-1");
  });

  // protects=an add's record says what it wrote in an edit's terms, as changed paragraphs, not as a change of nothing (#2969); fails_when=an add that wrote two paragraphs reaches the check as `changed: 0`; no_claim=how an edit is counted.
  test("an add's record says its paragraphs changed, as an edit's says", async () => {
    const sent = await recordSent([mindCall("add_to_mind", "q3-a", { paragraphs: 2 })]);

    expect(sent).toContain('\\"changed\\": 2');
    expect(sent).toContain('\\"paragraphs\\": 2');
  });

  // protects=only an add is said in an edit's terms: an edit that leaves `changed` unset (a revision of the assistant's own text) still reaches the check as changed 0, as the probes measured; fails_when=every call with paragraphs gets them as changed; no_claim=how an edit is counted.
  test("an edit's record is not changed by an add's rule", async () => {
    const sent = await recordSent([
      mindCall("edit_mind", "q3-a", { paragraphs: 4, revised: true }),
    ]);

    expect(sent).toContain('\\"changed\\": 0');
    expect(sent).toContain('\\"paragraphs\\": 4');
  });

  // protects=a format or setting the app has no name for, and a style written as a path, reach the check as nothing or as the style's last part, never a path; fails_when=the model's own value goes whole, with the User's folders in it; no_claim=which formats and settings exist.
  test("a command, format, setting and style are names, not paths the model wrote", async () => {
    const sent = await recordSent([
      commandCall(
        "mind.export",
        {
          command: ["/Users/ana/Documents/Acme.docx"],
          format: "/Users/ana/Documents/Acme.docx",
          setting: "C:\\Users\\Ana\\Acme",
          style: "/Users/ana/Styles/apa.csl",
        },
        undefined,
        { status: "failed" },
      ),
    ]);

    expect(sent).toContain("apa.csl");
    expect(sent).not.toContain("Users");
    expect(sent).not.toContain("Acme");
  });

  // protects=the sentences an edit took out or rewrote reach the check as counts, not as the User's words, in English and Chinese; fails_when=a sentence of the User's, or its words, is in the request; no_claim=what the model is told in the call's result, which still names them to report from.
  test.each([
    { gone: "Each costs 800 a month.", rewritten: "Spaces are allocated by the landlord." },
    { gone: "每个车位每月 800 元。", rewritten: "车位由房东分配。" },
  ])(
    "the User's sentences an edit took out or rewrote are counts only: $gone",
    async ({ gone, rewritten }) => {
      const sent = await recordSent([
        mindCall("edit_mind", "q3-a", {
          sentences: {
            kept: 2,
            takenOut: 1,
            shortened: 0,
            rewritten: 1,
            written: 1,
            named: { takenOut: [gone], rewritten: [rewritten] },
          },
        }),
      ]);

      expect(sent).toContain("1 taken out whole; 1 rewritten as 1; 2 kept word for word");
      expect(sent).not.toContain(gone);
      expect(sent).not.toContain(rewritten);
    },
  );

  // protects=a path in a setting's old or new value, on any system, reaches the check as the folder's last part; fails_when=the path itself is sent, with the User's folders above it; no_claim=every setting.
  test.each([
    { from: "/Users/ana/Documents/IncarnaMind", to: "/Volumes/Work/Reports", last: "Reports" },
    { from: "C:\\Users\\Ana\\Documents", to: "D:\\Reports\\2026", last: "2026" },
  ])("a setting's value that is a path is its last part: $to", async ({ from, to, last }) => {
    const sent = await recordSent([
      commandCall(
        "settings.change",
        { setting: "outputLocation", value: to },
        {
          command: "settings.change",
          run: "run-1",
          items: [],
          setting: { name: "outputLocation", from, to },
        },
      ),
    ]);

    expect(sent).toContain(last);
    expect(sent).not.toContain("Users");
    expect(sent).not.toContain("Volumes");
    expect(sent).not.toContain("Reports\\\\2026");
  });

  // protects=a command's call reaches the check with the command and the setting, format or style it named, and without the ids, folder path or value it was given; fails_when=the call's input goes whole; no_claim=what each command takes.
  test("a command's input is what it named, not the ids or paths it was given", async () => {
    const sent = await recordSent([
      commandCall(
        "mind.export",
        { ids: ["q3-a"], format: "markdown", folder: "/Users/ana/Documents/Clients/Acme" },
        undefined,
        { status: "failed" },
      ),
    ]);

    expect(sent).toContain("mind.export");
    expect(sent).toContain("markdown");
    expect(sent).toContain("failed");
    expect(sent).not.toContain("Acme");
    expect(sent).not.toContain("q3-a");
  });
});
