/**
 * A table's total is footed against its cells as the Note's marks and numbers are now, wherever its
 * verdict shows, whatever order and whichever run its cells' checks ended in (#2560, #2998): a
 * total reads Checking while a cell it counts is still being checked, and a cell checked later, a
 * number typed over or an Undo foots it again with no model asked. The model is scripted; a cell's
 * check waits, at its first request, until the others' have ended.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { readNoteState } from "../../src/renderer/src/noteState";
import type { NoteFooting } from "../../src/shared/claimChecks";
import { footingOfRows } from "../../src/shared/figureSchedule";
import { INLINE_NODE } from "../../src/shared/sentences";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { createTempDataFolder, nextTurn, startCore } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { textOf, unzip } from "../helpers/docx";
import { checkClock } from "../helpers/heldClock";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
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

/** How a mark shows on its own, before the Note's footing is read. */
const NO_CONTEXT = {
  footing: "not-yet-known" as const,
  versions: null,
  folderId: null,
  scope: null,
};

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
  folderId: string;
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
    // A request that fails gets no reply, so its claim's end shows only on its mark.
    const failedEnded = async () => {
      if (run.fails === undefined) return true;
      await at.client.settled();
      return claimsOf(readMind(at.client), NO_CONTEXT).claims.some(
        (claim) => claim.sentence.text === run.fails && claim.check.state !== "checking",
      );
    };
    const replied = claims - 1 - (run.fails === undefined ? 0 : 1);
    for (;;) {
      const uses = await at.core.listAiUse(at.mindId);
      const checked = uses.filter((use) => use.kind === "sentence-checked").length;
      if (checked >= replied && (await failedEnded())) break;
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
      world.current = { core, client, mindId, folderId: folder.id, requestId, release };
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

/** What the Note's marks show, as the editor shows them: each read with the Note's footing now. */
async function shownIn(
  { core, client, mindId, folderId }: Pick<World, "core" | "client" | "mindId" | "folderId">,
  footing?: NoteFooting,
) {
  const versions = new Map(
    (await core.listDocuments()).map((document) => [document.id, document.contentHash]),
  );
  const live = footing ?? footingOfRows((await core.getFigureSchedule(mindId)).rows);
  return claimsOf(readMind(client), { footing: live, versions, folderId, scope: null }).claims.map(
    (claim) => [claim.sentence.text.replaceAll(INLINE_NODE, "").trim(), claim.shown.state],
  );
}

/** The Figures tab's row for the figure written `chars`. */
async function rowOf(core: Core, mindId: string, chars: string) {
  const row = (await core.getFigureSchedule(mindId)).rows.find(
    (each) => each.reading.chars === chars,
  );
  if (!row) throw new Error(`The Figures tab has no row for ${chars}.`);
  return row;
}

const checkedUses = async (core: Core, mindId: string) =>
  (await core.listAiUse(mindId)).filter((use) => use.kind === "sentence-checked").length;

describe.each([EN, ZH])("$language: Check this Note foots a table in its order", (example) => {
  // protects=a total whose check ends before a cell's is footed against that cell's checked reading, so cells that don't add up to it make it Unsupported, its footing says by how much, and the sheet's row the table leaves out is named; meanwhile the total reads Checking, never Supported first, while the cells and the sentence outside the table show their own verdicts as their checks end (#2560, #2998); fails_when=a total is footed while "(120)" is still unread and shows Supported, or turns from Supported to Unsupported inside one run; no_claim=how a real model reads "(120)".
  test("a total whose check ends before a cell's is footed against it: the cells don't add up", async () => {
    let meanwhile: (string | null)[][] = [];
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
      last: RETURNS,
      async meanwhile(world) {
        meanwhile = await shownIn(world);
        world.release();
      },
    });

    expect(await run.result).toMatchObject({ kind: "checked", sentences: 4, checked: 4 });
    await run.client.settled();

    expect(await shownIn(run)).toEqual([
      ["500", "supported"],
      [RETURNS, "supported"],
      ["400", "unsupported"],
      [example.prose, "supported"],
    ]);
    const total = await rowOf(run.core, run.mindId, "400");
    expect(total.reason).toBe("doesnt-add-up");
    expect(total.footing).toMatchObject([{ axis: "row", sum: 380, agrees: false }]);
    expect(total.sourceFooting).toMatchObject([
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

  // protects=a total whose own request failed reads Checking while a cell it counts is still out, never a footing's Unsupported first, and once that cell lands the cells that don't add up show (#2998); fails_when=the total reads Unsupported from the cells as they are while one of them is still being checked; no_claim=how a real provider fails.
  test("a total whose own check couldn't be made reads Checking while a cell it counts is out", async () => {
    let meanwhile: (string | null)[][] = [];
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
      last: "500",
      fails: "400",
      async meanwhile(world) {
        meanwhile = await shownIn(world);
        world.release();
      },
    });

    await run.result;
    await run.client.settled();

    expect(meanwhile).toEqual([
      ["500", "checking"],
      [RETURNS, "supported"],
      ["400", "checking"],
      [example.prose, "supported"],
    ]);
    expect((await shownIn(run))[2]).toEqual(["400", "unsupported"]);
  });

  // protects=a total its cells add up to stays Supported when its check ends first: its footing agrees once "(120)" is read as a minus (#2560); fails_when=the total's footing is left unworked out, or misfoots it; no_claim=a real model's reading.
  test("a total its cells add up to stays Supported when its check ends first", async () => {
    const run = await checkThisNote(example, sheetOf(example, 380), "380", {
      last: RETURNS,
      async meanwhile({ release }) {
        release();
      },
    });

    expect(await run.result).toMatchObject({ kind: "checked", checked: 4 });
    await run.client.settled();

    expect(await shownIn(run)).toEqual([
      ["500", "supported"],
      [RETURNS, "supported"],
      ["380", "supported"],
      [example.prose, "supported"],
    ]);
    expect((await rowOf(run.core, run.mindId, "380")).footing).toMatchObject([
      { axis: "row", sum: 380, agrees: true },
    ]);
  });

  // protects=checks that end in the table's order foot it as before: the total is footed against its cells and the sheet's left-out row is named (#2560); fails_when=the live footing differs from the one a landing in order gave; no_claim=timing.
  test("checks that end in the table's order foot it as before", async () => {
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", { last: null });

    expect(await run.result).toMatchObject({ kind: "checked", checked: 4 });
    await run.client.settled();

    expect((await shownIn(run))[2]).toEqual(["400", "unsupported"]);
    const total = await rowOf(run.core, run.mindId, "400");
    expect(total.footing).toMatchObject([{ axis: "row", sum: 380, agrees: false }]);
    expect(total.sourceFooting).toMatchObject([{ axis: "row", sum: 400, agrees: true }]);
  });

  // protects=a Note moved outside the walled Folder that keeps the total's source reads nothing behind the wall: the Figures tab shows the total's verdict and its sum from the Note's own numbers, and no row of the sheet the Note never cited (#2998); fails_when=the left-out row is read from the walled Document for a Note outside the wall; no_claim=the wall's own Citation re-check.
  test("a Note moved outside the wall that keeps the sheet shows no row it never cited", async () => {
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", { last: null });
    await run.result;
    await run.client.settled();
    expect((await rowOf(run.core, run.mindId, "400")).sourceFooting).toHaveLength(1);

    await run.core.updateLibraryGroup(run.folderId, {
      name: "Accounts",
      description: "",
      keepInside: true,
    });
    const general = await run.core.createLibraryGroup({ name: "General", description: "" });
    await run.core.moveToFolder({ mindIds: [run.mindId], folderId: general.id });

    const total = await rowOf(run.core, run.mindId, "400");
    expect([total.shown.state, total.reason]).toEqual(["unsupported", "doesnt-add-up"]);
    expect(total.footing).toMatchObject([{ axis: "row", sum: 380, agrees: false }]);
    expect(total.sourceFooting).toEqual([]);
  });

  // protects=Stop with a cell's check still out writes no footing: the total shows its own verdict, footed against the cells as they are, and once the cell is checked later the total follows it (#2560, #2998); fails_when=the total keeps a footing made without the cell; no_claim=what a real provider does on a stop.
  test("Stop with a cell's check still out, then a check of the cell: the total follows it", async () => {
    const run = await checkThisNote(example, sheetOf(example, 400, 20), "400", {
      last: RETURNS,
      async meanwhile({ core, requestId }) {
        await core.cancelCheck(requestId);
      },
    });

    expect(await run.result).toEqual({ kind: "cancelled" });
    await run.client.settled();
    expect(await shownIn(run)).toEqual([
      ["500", "supported"],
      [RETURNS, "not-checked"],
      ["400", "supported"],
      [example.prose, "supported"],
    ]);

    await run.core.checkSentences({
      requestId: randomUUID(),
      mindId: run.mindId,
      action: "check-against-documents",
      from: { blockId: RETURNS_CELL, offset: 0 },
      to: { blockId: RETURNS_CELL, offset: RETURNS.length },
    });
    await run.client.settled();
    expect((await shownIn(run))[2]).toEqual(["400", "unsupported"]);
  });

  // protects=quitting with a cell's check still out writes nothing after the close and raises no error: opened again, the cell reads Not checked, stopped, and the total its own verdict (#2560); fails_when=a mark is written after the Note closed, or the run rejects after the close; no_claim=a crash.
  test("quitting with a cell's check still out writes nothing after the close, and no error", async () => {
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
    onTestFinished(() => again.close());
    const client = await connectToMind(again, run.mindId);
    expect(
      await shownIn({ core: again, client, mindId: run.mindId, folderId: run.folderId }),
    ).toEqual([
      ["500", "supported"],
      [RETURNS, "not-checked"],
      ["400", "supported"],
      [example.prose, "supported"],
    ]);
  });
});

describe("Verify foots a table in its order", () => {
  // protects=Verify foots a checked document's table as Check this Note does: the total row, whose check ends before the returns row's, is Unsupported, its footing against the rows above it read with "(120)" as a minus (#2560); fails_when=the total row reads Supported because its check ended first; no_claim=how a real model finds a row's claim.
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

    const note = { core: made.core, client, mindId: verified.mind.id, folderId: made.folderId };
    expect(await shownIn(note)).toEqual([
      [labels.sales, "supported"],
      [labels.returns, "supported"],
      [labels.total, "unsupported"],
      [example.prose, "supported"],
    ]);
    expect((await rowOf(made.core, verified.mind.id, "400")).footing).toMatchObject([
      { axis: "row", sum: 380, agrees: false },
    ]);
  });
});

type Again = "Check this Note again" | "a check of the cell";

/**
 * Check this Note, its "(120)" ending Not checked by `ended`; then that cell checked again by
 * `again`, which sends only it. The total, Supported after the first run, counts it.
 */
async function laterRun(
  example: Example,
  ended: "a failed request" | "the monthly cap",
  again: Again = "Check this Note again",
) {
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
  const first = {
    shown: await shownIn(run),
    uses: await checkedUses(run.core, run.mindId),
    note: readMind(run.client).toJSON(),
  };
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
  return { ...run, first };
}

describe.each([EN, ZH])(
  "$language: a total is footed again when a cell is checked in a later run",
  (example) => {
    // protects=a cell whose check couldn't be made in one run, then checked in a later one, has the totals that count it footed against its new mark: cells that don't add up make the total Unsupported with its footing and the sheet's left-out row, the total isn't sent to a model again, and the AI use record gets the cell's check alone (#2998); fails_when=the total keeps the footing it got without the cell, "(120)" unread, and stays Supported; no_claim=how a real provider fails or how a real model reads "(120)".
    test.each<{ ended: "a failed request" | "the monthly cap"; again: Again }>([
      { ended: "a failed request", again: "Check this Note again" },
      { ended: "a failed request", again: "a check of the cell" },
      { ended: "the monthly cap", again: "Check this Note again" },
      { ended: "the monthly cap", again: "a check of the cell" },
    ])("its cell ended Not checked by $ended, then $again", async ({ ended, again }) => {
      const run = await laterRun(example, ended, again);

      expect(run.first.shown).toEqual([
        ["500", "supported"],
        [RETURNS, "not-checked"],
        ["400", "supported"],
        [example.prose, "supported"],
      ]);
      expect(run.sent.at(-1)).toEqual([RETURNS]);
      expect(await checkedUses(run.core, run.mindId)).toBe(run.first.uses + 1);
      expect(await shownIn(run)).toEqual([
        ["500", "supported"],
        [RETURNS, "supported"],
        ["400", "unsupported"],
        [example.prose, "supported"],
      ]);
      const total = await rowOf(run.core, run.mindId, "400");
      expect(total.footing).toMatchObject([{ axis: "row", sum: 380, agrees: false }]);
      expect(total.sourceFooting).toMatchObject([
        { sum: 400, agrees: true, inputs: [{ label: example.labels.other }] },
      ]);
    });

    // protects=a number typed over in a cell foots the total against it at once, in the mark and the Figures tab alike, with no model asked and nothing added to the AI use record (#2998); fails_when=the total keeps the footing from before the edit, or the two places disagree; no_claim=what the edited cell's own re-check finds.
    test("a number typed over in a cell foots the total against it, the mark and the Figures tab alike", async () => {
      const run = await laterRun(example, "a failed request");
      const uses = await checkedUses(run.core, run.mindId);
      const calls = run.sent.flat().length;

      const typed = (node: JSONContent): JSONContent =>
        node.type === "text" && node.text === "500"
          ? { ...node, text: "520" }
          : { ...node, ...(node.content && { content: node.content.map(typed) }) };
      editMind(run.client, (blocks) => blocks.map(typed));
      await run.client.settled();

      // 520 - 120 is 400: the total adds up again.
      expect((await shownIn(run)).slice(0, 3)).toEqual([
        ["520", "needs-recheck"],
        [RETURNS, "supported"],
        ["400", "supported"],
      ]);
      const total = await rowOf(run.core, run.mindId, "400");
      expect(total.shown.state).toBe("supported");
      expect(total.footing).toMatchObject([{ axis: "row", sum: 400, agrees: true }]);
      expect(await checkedUses(run.core, run.mindId)).toBe(uses);
      expect(run.sent.flat()).toHaveLength(calls);
    });

    // protects=Undo of a cell's landing foots the total against the cell as it was, in the mark and the Figures tab alike (#2998); fails_when=the total keeps the footing the undone mark gave it; no_claim=the editor's own Undo stack.
    test("Undo of a cell's landing foots the total as before, the mark and the Figures tab alike", async () => {
      const run = await laterRun(example, "a failed request");

      editMind(run.client, () => run.first.note.content ?? []);
      await run.client.settled();

      expect((await shownIn(run)).slice(0, 3)).toEqual([
        ["500", "supported"],
        [RETURNS, "not-checked"],
        ["400", "supported"],
      ]);
      expect((await rowOf(run.core, run.mindId, "400")).shown.state).toBe("supported");
    });

    // protects=a Document's new version marks the table's checks for a re-check in the mark and the Figures tab alike (#2998); fails_when=the total's mark reads a footing the Figures tab no longer does; no_claim=what checking against the new version finds.
    test("a Document's new version: the total's mark and the Figures tab agree", async () => {
      const run = await laterRun(example, "a failed request");

      await writeSourceFile(
        run.sources,
        "Accounts.xlsx",
        xlsxOf([{ name: "Accounts", rows: sheetOf(example, 410, 30) }]),
      );
      await run.core.reconcileDocuments();
      await waitForProcessing(
        run.core,
        (await run.core.listDocuments()).map((document) => document.id),
      );

      expect((await shownIn(run))[2]).toEqual(["400", "needs-recheck"]);
      expect((await rowOf(run.core, run.mindId, "400")).shown.state).toBe("needs-recheck");
    });

    // protects=before the Note's figures are first read the mark shows the footing stored with its check, then the live one, with nothing thrown between (#2998); fails_when=the reader throws or shows nothing without the live footing; no_claim=how long the read takes.
    test("before its figures are read the total shows its stored footing, then the live one", async () => {
      const run = await laterRun(example, "a failed request");

      expect((await shownIn(run, "not-yet-known"))[2]).toEqual(["400", "supported"]);
      expect((await shownIn(run))[2]).toEqual(["400", "unsupported"]);
    });
  },
);

describe("every place that shows the total's verdict shows the same one", () => {
  // protects=after its cell is checked in a later run, the total reads Unsupported everywhere a verdict shows (#2998); fails_when=a place reads the footing stored when the total's own check landed and shows Supported; no_claim=the wording of each place.
  test("the mark in the Note", async () => {
    const run = await laterRun(EN, "a failed request");
    expect((await shownIn(run))[2]).toEqual(["400", "unsupported"]);
  });

  test("Home's row for the Note", async () => {
    const run = await laterRun(EN, "a failed request");
    const [snapshot] = await run.core.readMindContents([run.mindId]);
    if (!snapshot) throw new Error("Home read no Note.");
    const doc = new Y.Doc();
    onTestFinished(() => doc.destroy());
    Y.applyUpdate(doc, snapshot.state);
    const { health } = readNoteState({
      doc,
      cellFigures: snapshot.cellFigures,
      footing: snapshot.footing,
      documents: null,
      keptCitationTexts: [],
      folderId: run.folderId,
    });
    expect(health.unsupported).toHaveLength(1);
  });

  test("the Figures tab", async () => {
    const run = await laterRun(EN, "a failed request");
    const total = await rowOf(run.core, run.mindId, "400");
    expect([total.shown.state, total.reason]).toEqual(["unsupported", "doesnt-add-up"]);
  });

  test("the AI use statement", async () => {
    const run = await laterRun(EN, "a failed request");
    const made = await run.core.createAiUseStatement(run.mindId);
    const client = await connectToMind(run.core, made.id);
    const rows: string[][] = [];
    readMind(client).forEach((node) => {
      if (node.type.name !== "table") return;
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => void cells.push(cell.textContent));
        rows.push(cells);
      });
    });
    expect(rows.find((cells) => cells[0] === "400")?.[1]).toBe("Unsupported");
  });

  test("Check this Note's list of what changed", async () => {
    const run = await laterRun(EN, "a failed request");
    expect(await run.core.planMindCheck(run.mindId, "changed")).toMatchObject({
      kind: "unchanged",
    });
  });

  test("the check record", async () => {
    const run = await laterRun(EN, "a failed request");
    const out = await createTempDataFolder();
    await run.core.setOutputLocation(out);
    const saved = await run.core.saveCheckRecord(run.mindId);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = await readFile(join(out, `${saved.file.name.replace(/\.(pdf|csv)$/, "")}.csv`));
    const rows = recordRows(csv.toString("utf8"));
    expect(rows.find((row) => row.Kind === "Sentence" && row.Sentence === "400")?.Result).toBe(
      "Unsupported",
    );
  });

  test("the Word export's comments", async () => {
    const run = await laterRun(EN, "a failed request");
    const exported = await run.core.exportMind(run.mindId, {
      format: "docx",
      commentFailedChecks: true,
    });
    const comments = unzip(exported.data).get("word/comments.xml")?.toString("utf8") ?? "";
    expect(textOf(comments)).toMatch(/^Unsupported/);
  });
});
