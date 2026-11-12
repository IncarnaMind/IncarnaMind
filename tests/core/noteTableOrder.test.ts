/**
 * Check this Note and Verify foot a table's marks in the table's order, whatever order their checks
 * end in (#2560): a cell lands only after the cells before it in its table, so a total is footed
 * against its cells' checked readings, and a sentence outside any table lands as its check ends.
 * The model is scripted; a cell's check waits, at its first request, until the others' have ended.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { INLINE_NODE } from "../../src/shared/sentences";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { createTempDataFolder, nextTurn, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { checkClock } from "../helpers/heldClock";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { xlsxOf } from "../helpers/office";
import { paragraph, table, wordFile } from "../helpers/word";

interface Example {
  language: "en" | "zh-CN";
  headings: [string, string];
  labels: { sales: string; returns: string; other: string; total: string };
  /** A sentence after the table, outside it, on the sales figure. */
  prose: string;
}

const EN: Example = {
  language: "en",
  headings: ["Item", "Amount"],
  labels: { sales: "Sales", returns: "Returns", other: "Other", total: "Total" },
  prose: "The year closed with sales of 500.",
};

const ZH: Example = {
  language: "zh-CN",
  headings: ["项目", "金额"],
  labels: { sales: "销售", returns: "退货", other: "其他", total: "合计" },
  prose: "全年销售额为500。",
};

/** "(120)" in a cell may be a minus or an aside: its check reads it as the sheet's -120. */
const RETURNS = "(120)";

/**
 * The sheet a Note's table is checked against: sales, returns as a minus and, when `other` is
 * given, a row the Note's table leaves out; then its total.
 */
function sheetOf(example: Example, total: number, other?: number) {
  const { labels, headings } = example;
  return [
    [...headings],
    [labels.sales, 500],
    [labels.returns, -120],
    ...(other === undefined ? [] : [[labels.other, other]]),
    [labels.total, total],
  ];
}

const supported = (quote: string, number: string): Plan => ({
  verdict: "supported",
  quote,
  number,
  says: "It says so.",
});

/** How the scripted model checks each figure of the Note's table, as `say` words its claims. */
function plansOf(example: Example, total: string, say: (label: string, value: string) => string) {
  const { labels } = example;
  return {
    [say(labels.sales, "500")]: supported(`${labels.sales}\t500`, "500"),
    [say(labels.returns, RETURNS)]: supported(`${labels.returns}\t-120`, "-120"),
    [say(labels.total, total)]: supported(`${labels.total}\t${total}`, total),
    [example.prose]: supported(`${labels.sales}\t500`, "500"),
  } satisfies Record<string, Plan>;
}

/** The check's reply, reading "(120)" as a minus: the second of the readings it is offered. */
function asMinus(reply: ScriptedReply): ScriptedReply {
  if (!("text" in reply) || typeof reply.text !== "string") return reply;
  return { ...reply, text: reply.text.replaceAll('"reading":1', '"reading":2') };
}

interface Run {
  /** The claim whose check waits, at its first request, until every other claim's has ended. */
  last: string | null;
  /** What the test does once the others' checks have ended, with the waiting check still out. */
  meanwhile?(world: World): Promise<void>;
  /** The claim whose first check's request fails, as a provider's server error does. */
  fails?: string;
}

interface World {
  core: Core;
  client: MindClient;
  mindId: string;
  requestId: string;
  /** Ends the waiting check's request with its reply. */
  release(): void;
}

/** A cloud model the User allowed to check, scripted by `plans`, and the sheet in a Folder. */
async function coreOf(
  example: Example,
  sheet: (string | number)[][],
  plans: Record<string, Plan>,
  run: Run,
) {
  const world: { current: World | null } = { current: null };
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claims = Object.keys(plans).length;
  /** Each claim sent to be checked, by the run it was sent in, from 0. */
  const sent: string[][] = [[]];
  let waited = false;
  let failed = false;
  const othersEnded = async () => {
    const at = world.current;
    if (!at) throw new Error("The checks began before the Note was made.");
    for (;;) {
      const uses = await at.core.listAiUse(at.mindId);
      if (uses.filter((use) => use.kind === "sentence-checked").length >= claims - 1) break;
      await nextTurn();
    }
    await at.client.settled();
    await run.meanwhile?.(at);
    await released;
  };
  const check = (call: ModelCall): ScriptedReply => {
    const sentence = sentenceOf(call);
    if (call.results.length === 0) sent.at(-1)?.push(sentence);
    if (sentence === run.fails && !failed) {
      failed = true;
      return { error: { status: 500, message: "The provider failed." } };
    }
    const reply = checkReply(call, plans);
    const read = sentence.includes(RETURNS) ? asMinus(reply) : reply;
    if (sentence !== run.last || call.results.length > 0 || waited) return read;
    waited = true;
    return { ...read, pause: { after: 0, until: othersEnded() } };
  };
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call)) throw new Error(`Only checks are asked: ${call.system.slice(0, 40)}`);
      return check(call);
    },
    { generate: checkGenerate(plans) },
  );
  const clock = checkClock();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
    paceTimers: clock.timers,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: "sk-ant-test",
  });
  if (!saved.service) throw new Error("Anthropic is a service.");
  await core.allowDataFlow("checks", saved.service.id);
  await core.updateSettings({ user: { language: example.language } });
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, "Accounts.xlsx", xlsxOf([{ name: "Accounts", rows: sheet }])),
  ]);
  const folder = await core.createLibraryGroup({ name: "Accounts", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  return {
    core,
    dataDir,
    folderId: folder.id,
    sources,
    sent,
    /** Begins the run on the Note the checks read. */
    begin(client: MindClient, mindId: string, requestId: string): World {
      world.current = { core, client, mindId, requestId, release };
      return world.current;
    },
  };
}

const cell = (
  type: "tableHeader" | "tableCell",
  text: string,
  id: string = randomUUID(),
): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }],
});

const row = (type: "tableHeader" | "tableCell", ...cells: string[]): JSONContent => ({
  type: "tableRow",
  content: cells.map((text) => cell(type, text)),
});

/** The paragraph id of the cell that holds "(120)". */
const RETURNS_CELL = "returns-cell";

/** Check this Note on the User's own table, each cell a claim of its own. */
async function checkThisNote(
  example: Example,
  sheet: (string | number)[][],
  total: string,
  run: Run,
) {
  const plans = plansOf(example, total, (_label, value) => value);
  const made = await coreOf(example, sheet, plans, run);
  const mind = await made.core.createMind({ title: "Accounts", folderId: made.folderId });
  const client = await connectToMind(made.core, mind.id);
  const { labels, headings } = example;
  writeMind(client, [
    {
      type: "table",
      attrs: { id: randomUUID() },
      content: [
        row("tableHeader", ...headings),
        row("tableCell", labels.sales, "500"),
        {
          type: "tableRow",
          content: [cell("tableCell", labels.returns), cell("tableCell", RETURNS, RETURNS_CELL)],
        },
        row("tableCell", labels.total, total),
      ],
    },
    {
      type: "paragraph",
      attrs: { id: randomUUID() },
      content: [{ type: "text", text: example.prose }],
    },
  ]);
  await client.settled();
  const requestId = randomUUID();
  made.begin(client, mind.id, requestId);
  const result = made.core.checkMind({ requestId, mindId: mind.id, mode: "all" });
  return { ...made, client, mindId: mind.id, result };
}

/** Each mark in the Note, by its words, with its state and its first figure's footings. */
function marksIn(client: MindClient) {
  return claimSpans(readMind(client)).map((span) => {
    const figure = span.check.figures?.[0];
    return {
      text: span.sentence.text.replaceAll(INLINE_NODE, "").trim(),
      state: span.check.state,
      reason: span.check.reason,
      footing: figure?.footing ?? [],
      sourceFooting: figure?.sourceFooting ?? [],
    };
  });
}

const states = (client: MindClient) => marksIn(client).map(({ text, state }) => [text, state]);

describe.each([EN, ZH])("$language: Check this Note foots a table in its order", (example) => {
  // protects=a total whose check ends before a cell's is footed against that cell's checked reading, so cells that don't add up to it make it Unsupported, its footing says by how much, and the sheet's row the table leaves out is named; meanwhile the cells before the waiting one and the sentence outside the table show their verdicts, and the cells after it keep checking (#2560); fails_when=a mark lands as its check ends, so the total is footed while "(120)" is still unread and stays Supported; no_claim=how a real model reads "(120)".
  test("a total whose check ends before a cell's is footed against it: the cells don't add up", async () => {
    let meanwhile: (string | null)[][] = [];
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
      last: RETURNS,
      async meanwhile({ client, release }) {
        meanwhile = states(client);
        release();
      },
    });

    expect(await run.result).toMatchObject({ kind: "checked", sentences: 4, checked: 4 });
    await run.client.settled();

    const marks = marksIn(run.client);
    expect(marks.map(({ text, state }) => [text, state])).toEqual([
      ["500", "supported"],
      [RETURNS, "supported"],
      ["400", "unsupported"],
      [example.prose, "supported"],
    ]);
    const total = marks.find((mark) => mark.text === "400");
    expect(total?.footing).toMatchObject([{ axis: "row", sum: 380, agrees: false }]);
    expect(total?.sourceFooting).toMatchObject([
      {
        axis: "row",
        sum: 400,
        agrees: true,
        inputs: [{ label: example.labels.other, number: { value: 20 } }],
      },
    ]);
    expect(meanwhile).toEqual([
      ["500", "supported"],
      [RETURNS, "checking"],
      ["400", "checking"],
      [example.prose, "supported"],
    ]);
  });

  // protects=a total its cells add up to stays Supported when its check ends first: its footing agrees once "(120)" is read as a minus (#2560); fails_when=holding the table drops or misfoots the total; no_claim=a real model's reading.
  test("a total its cells add up to stays Supported when its check ends first", async () => {
    const run = await checkThisNote(example, sheetOf(example, 380), "380", {
      last: RETURNS,
      async meanwhile({ release }) {
        release();
      },
    });

    expect(await run.result).toMatchObject({ kind: "checked", checked: 4 });
    await run.client.settled();

    const marks = marksIn(run.client);
    expect(marks.map(({ text, state }) => [text, state])).toEqual([
      ["500", "supported"],
      [RETURNS, "supported"],
      ["380", "supported"],
      [example.prose, "supported"],
    ]);
    expect(marks.find((mark) => mark.text === "380")?.footing).toMatchObject([
      { axis: "row", sum: 380, agrees: true },
    ]);
  });

  // protects=checks that end in the table's order land as before: the total is footed against its cells and the sheet's left-out row is named (#2560); fails_when=the order the hold keeps differs from the table's; no_claim=timing.
  test("checks that end in the table's order foot it as before", async () => {
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", { last: null });

    expect(await run.result).toMatchObject({ kind: "checked", checked: 4 });
    await run.client.settled();

    const total = marksIn(run.client).find((mark) => mark.text === "400");
    expect(total?.state).toBe("unsupported");
    expect(total?.footing).toMatchObject([{ axis: "row", sum: 380, agrees: false }]);
    expect(total?.sourceFooting).toMatchObject([{ axis: "row", sum: 400, agrees: true }]);
  });

  // protects=Stop with a cell's check still out writes no total footed without it: the marks after the waiting cell, the total among them, read Not checked, stopped, and those before it keep their verdicts (#2560); fails_when=the total landed before the stop, footed with "(120)" unread, Supported; no_claim=what a real provider does on a stop.
  test("Stop with a cell's check still out leaves nothing half-footed", async () => {
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
      last: RETURNS,
      async meanwhile({ core, requestId }) {
        await core.cancelCheck(requestId);
      },
    });

    expect(await run.result).toEqual({ kind: "cancelled" });
    await run.client.settled();

    expect(marksIn(run.client).map(({ text, state, reason }) => [text, state, reason])).toEqual([
      ["500", "supported", null],
      [RETURNS, "not-checked", "stopped"],
      ["400", "not-checked", "stopped"],
      [example.prose, "supported", null],
    ]);
  });

  // protects=quitting with a cell's check still out writes nothing after the close and no total footed without it: opened again, the total reads Not checked, stopped (#2560); fails_when=a held mark is written after the Note closed, or the total landed footed with "(120)" unread; no_claim=a crash.
  test("quitting with a cell's check still out leaves nothing half-footed, and no error", async () => {
    const errors = vi.spyOn(console, "error");
    onTestFinished(() => errors.mockRestore());
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
      last: RETURNS,
      async meanwhile({ core, release }) {
        errors.mockClear();
        core.close();
        release();
      },
    });

    await expect(run.result).resolves.toEqual({ kind: "cancelled" });
    await nextTurn();
    expect(errors).not.toHaveBeenCalled();

    const again = startCore(run.dataDir);
    const client = await connectToMind(again, run.mindId);
    expect(marksIn(client).map(({ text, state, reason }) => [text, state, reason])).toEqual([
      ["500", "supported", null],
      [RETURNS, "not-checked", "stopped"],
      ["400", "not-checked", "stopped"],
      [example.prose, "supported", null],
    ]);
    again.close();
  });
});

describe("Verify foots a table in its order", () => {
  // protects=Verify foots a checked document's table as Check this Note does: the total row, whose check ends before the returns row's, is Unsupported, its footing against the rows above it read with "(120)" as a minus (#2560); fails_when=the total row lands before the returns row and stays Supported; no_claim=how a real model finds a row's claim.
  test("a total row whose check ends before another row's is footed against it", async () => {
    // Verify reads a Word table's first row as a row, not its headings, so this one has none, and
    // says each row as "合计 — 400": in English, "Total — 400" is too few words to be a claim.
    const example = ZH;
    const say = (label: string, value: string) => `${label} — ${value}`;
    const plans = plansOf(example, "400", say);
    const made = await coreOf(example, sheetOf(example, 400, 20), plans, {
      last: say(example.labels.returns, RETURNS),
      async meanwhile({ release }) {
        release();
      },
    });
    const { labels } = example;
    const path = join(made.sources, "账目.docx");
    await writeFile(
      path,
      wordFile({
        body:
          table([
            [labels.sales, "500"],
            [labels.returns, RETURNS],
            [labels.total, "400"],
          ]) + paragraph(example.prose),
      }),
    );
    const verified = await made.core.verifyDocument({ path, folderId: made.folderId });
    if (!verified.ok) throw new Error(`The file wasn't verified: ${JSON.stringify(verified)}`);
    await waitForProcessing(made.core, [verified.documentId]);
    const client = await connectToMind(made.core, verified.mind.id);
    await client.settled();
    expect(
      await made.core.findClaims({ requestId: randomUUID(), mindId: verified.mind.id }),
    ).toEqual({ kind: "found", claims: 4 });
    const requestId = randomUUID();
    made.begin(client, verified.mind.id, requestId);

    expect(await made.core.verifyClaims({ requestId, mindId: verified.mind.id })).toMatchObject({
      kind: "checked",
      checked: 4,
    });
    await client.settled();

    const marks = marksIn(client);
    expect(marks.map(({ text, state }) => [text, state])).toEqual([
      [labels.sales, "supported"],
      [labels.returns, "supported"],
      [labels.total, "unsupported"],
      [example.prose, "supported"],
    ]);
    expect(marks.find((mark) => mark.text === labels.total)?.footing).toMatchObject([
      { axis: "row", sum: 380, agrees: false },
    ]);
  });
});

type Again = "Check this Note again" | "a check of the cell";

describe.each([EN, ZH])(
  "$language: a total is footed again when a cell is checked in a later run",
  (example) => {
    // protects=a cell whose check couldn't be made in one run, then checked in a later one, has the totals that count it footed against its new mark: cells that don't add up make the total Unsupported with its footing, and the total isn't sent to a model again (#2998); fails_when=the total keeps the footing it got without the cell, "(120)" unread, and stays Supported; no_claim=how a real provider fails or how a real model reads "(120)".
    test.each<{ ended: "a failed request" | "the monthly cap"; again: Again }>([
      { ended: "a failed request", again: "Check this Note again" },
      { ended: "a failed request", again: "a check of the cell" },
      { ended: "the monthly cap", again: "Check this Note again" },
      { ended: "the monthly cap", again: "a check of the cell" },
    ])("its cell ended Not checked by $ended, then $again", async ({ ended, again }) => {
      const capped = ended === "the monthly cap";
      const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
        last: capped ? RETURNS : null,
        ...(!capped && { fails: RETURNS }),
        async meanwhile({ core, release }) {
          await core.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
          release();
        },
      });
      await run.result;
      await run.client.settled();
      expect(states(run.client)).toEqual([
        ["500", "supported"],
        [RETURNS, "not-checked"],
        ["400", "supported"],
        [example.prose, "supported"],
      ]);

      if (capped) await run.core.updateSettings({ user: { monthlyCap: null } });
      run.sent.push([]);
      const requestId = randomUUID();
      if (again === "Check this Note again")
        await run.core.checkMind({ requestId, mindId: run.mindId, mode: "changed" });
      else
        await run.core.checkSentences({
          requestId,
          mindId: run.mindId,
          action: "check-against-documents",
          from: { blockId: RETURNS_CELL, offset: 0 },
          to: { blockId: RETURNS_CELL, offset: RETURNS.length },
        });
      await run.client.settled();

      expect(run.sent.at(-1)).toEqual([RETURNS]);
      const marks = marksIn(run.client);
      expect(marks.map(({ text, state }) => [text, state])).toEqual([
        ["500", "supported"],
        [RETURNS, "supported"],
        ["400", "unsupported"],
        [example.prose, "supported"],
      ]);
      expect(marks.find((mark) => mark.text === "400")?.footing).toMatchObject([
        { axis: "row", sum: 380, agrees: false },
      ]);
    });
  },
);
