/**
 * Files an outside agent hands over (#3412), through the shim the app ships with the MCP SDK's own
 * client, as Claude Code calls it: the agent names a deck or workbook it made by its path, and
 * IncarnaMind reads that file alone, keeps it with each version and checks it as "Check someone
 * else's file" does, slide by slide or sheet by sheet; the agent reads back what needs a look, where
 * it is in the file, and a request the User sends it names the file, the slide and what to do.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { verificationOf } from "../../src/shared/verification";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { isCheckRun, sentenceOf } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { WorkbookBuilder } from "../helpers/financeWorkbooks";
import {
  DECK,
  type Handed,
  handOver,
  NEVER_CLOSES,
  NORTH,
  OFFICE,
  refusal,
  SOUTH,
  started,
  structured,
} from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";
import { xlsxPackage } from "../helpers/office";
import { plainDeck } from "../helpers/pptx";

describe("files an outside agent hands over", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a deck the agent made is read from the path it named, kept, and checked slide by slide, the agent told what needs a look and on which slide; the same file again tells how the check went, and a changed one is the next version with its own check, which alone has a row in the lists (#3412); fails_when=the file isn't checked, a claim loses its slide, the same bytes make a new version, a new version replaces the old one's check, or every version's check sits in the Notes list
  it("keeps a deck it made with each version, and checks each, saying what needs a look and on which slide", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(first).toMatchObject({
      title: "Harbour review",
      folder: "Coast",
      version: 1,
      status: "checked",
      why: null,
      supported: 2,
      needLook: 2,
      claims: [
        {
          where: "slide 2",
          text: SOUTH,
          result: "contradicted",
          says: "Harbour survey says the south quay holds 19 boats, not 17.",
        },
        {
          where: "slide 3",
          text: NEVER_CLOSES,
          result: "overstated",
          says: "Harbour survey says the office is open every day, not at night.",
        },
      ],
      formulas: null,
    });
    const firstMind = first.mindId;
    if (!firstMind) throw new Error("No Note was made of the deck.");

    // The same bytes again: the same version, and how its check went.
    const again = structured<Handed>(await handOver(agent, { path }));
    expect(again).toMatchObject({ fileId: first.fileId, version: 1, mindId: firstMind });

    // A changed file is the next version, with a check of its own; the first stays.
    await writeFile(
      path,
      plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }, { lines: [OFFICE] }]),
    );
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second).toMatchObject({ fileId: first.fileId, version: 2, needLook: 0 });
    expect(second.mindId).not.toBe(firstMind);
    const handed = await core.handedFileOf(second.mindId ?? "");
    expect(handed).toMatchObject({
      file: { title: "Harbour review", kind: "pptx", agent: "Claude Code", version: 2 },
      version: 2,
    });
    expect(handed?.versions.map((each) => [each.number, each.mindId])).toEqual([
      [1, firstMind],
      [2, second.mindId],
    ]);
    expect((await core.handedFileOf(firstMind))?.version).toBe(1);
    // One Note stands for the file in the lists, the newest version's check, named for the file;
    // the first version's, which its card opens, says its version and has no row of its own.
    const notes = (await core.listMinds()).filter((mind) =>
      [firstMind, second.mindId].includes(mind.id),
    );
    expect(notes.map((mind) => [mind.title, mind.supersededBy])).toEqual(
      expect.arrayContaining([
        ["Checking: Harbour review", undefined],
        ["Checking version 1: Harbour review", second.mindId],
      ]),
    );
    // The agent's list_minds lists the same one Note: the first version's check isn't shown it.
    const listed = JSON.stringify(
      structured<unknown>(await agent.callTool({ name: "list_minds", arguments: {} })),
    );
    expect(listed).toContain(second.mindId ?? "");
    expect(listed).not.toContain(firstMind);
    // One Document holds the item's newest version, filed where the agent handed it over.
    const documents = (await core.listDocuments()).filter((each) => each.name === "Harbour review");
    expect(documents).toHaveLength(1);
    expect(documents[0]?.contentHash).toBe(handed?.versions[1]?.contentHash);
  });

  // protects=a file handed over while no AI model is set up says so and tells the agent to check it itself, as it checks a Note it wrote, which check_mind_yourself then lets it do; it is checked once the User sets a model up and the agent hands the same file over again (#3412); fails_when=the agent is told only that the User can check it, or the same bytes never get their check
  it("tells the agent to check the file itself while no model is set up, and checks it when the same file is handed over again after", async () => {
    const { core, coast, writer, files } = await started();
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const unchecked = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(unchecked).toMatchObject({
      version: 1,
      status: "not-checked",
      why: "Not checked yet: no AI model is set up in IncarnaMind. Check this file yourself now: check_mind_yourself with its mindId gives what to check in it, then report_check.",
      claims: [],
    });
    const task = structured<{ mindId: string; sentences: { text: string }[] }>(
      await agent.callTool({
        name: "check_mind_yourself",
        arguments: { mindId: unchecked.mindId },
      }),
    );
    // As the file's check sorts it: its title too, which the agent finds nothing to check in.
    expect(task.sentences.map((each) => each.text)).toEqual([
      "Harbour review",
      NORTH,
      SOUTH,
      OFFICE,
      NEVER_CLOSES,
    ]);

    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const checked = structured<Handed>(await handOver(agent, { path }));
    expect(checked).toMatchObject({
      version: 1,
      mindId: unchecked.mindId,
      status: "checked",
      why: null,
      needLook: 2,
    });
  });

  // protects=a new version keeps the result of each line the version before had too while it still stands, checks only what changed or what its Documents changed under, says how many it kept, and checks every claim again when the User asks (#3412); fails_when=an unchanged line is sent to the model again, a line whose Document changed keeps a stale result, or the count isn't recorded
  it("keeps the results of unchanged lines in the next version, checks the rest, and checks every claim again when asked", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer, files, added } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const checkedNow = () => calls.filter(isCheckRun).map(sentenceOf);
    const before = checkedNow().length;

    // Its last slide taken out: each line's slide reads as it did.
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH, SOUTH] }]));
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second).toMatchObject({ version: 2, status: "checked", supported: 1, needLook: 1 });
    // Every line stood as it was: none was sent to the model again.
    expect(checkedNow().slice(before)).toEqual([]);
    const client = await connectToMind(core, second.mindId ?? "");
    await client.settled();
    expect(verificationOf(client.doc)?.kept).toBe(2);

    // A line whose Document changed is checked again, though its words didn't.
    const survey = added.find((each) => each.name === "Harbour survey");
    if (!survey) throw new Error("No survey.");
    await core.deleteDocuments([survey.id]);
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const third = structured<Handed>(await handOver(agent, { path }));
    expect(third).toMatchObject({ version: 3, status: "checked" });
    expect(checkedNow()).toContain(NORTH);

    // Check every claim again: nothing kept.
    const atAll = checkedNow().length;
    const again = await core.verifyClaims({
      requestId: crypto.randomUUID(),
      mindId: second.mindId ?? "",
    });
    expect(again).toMatchObject({ kind: "checked", claims: 2 });
    expect(new Set(checkedNow().slice(atAll))).toEqual(new Set([NORTH, SOUTH]));
    await client.settled();
    expect(verificationOf(client.doc)?.kept).toBeUndefined();
  });

  // protects=a workbook an agent made is checked whole in one hand-over: each sheet's typed-in numbers traced and every formula worked out, though the file saved no results (#3412); fails_when=only a sheet is read, or formulas with no saved result are left unchecked
  it("checks a workbook it made whole: each sheet's rows, and every formula worked out", async () => {
    const { coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const book = new WorkbookBuilder();
    book
      .sheet("Inputs")
      .text("A1", "Item")
      .text("B1", "2026")
      .text("A2", "Rent")
      .number("B2", 14000)
      .text("A3", "Moorings")
      .number("B3", 2500);
    book.sheet("Model").text("A1", "Total").formula("B1", "Inputs!B2+Inputs!B3", null);
    const path = join(files, "Harbour budget.xlsx");
    await writeFile(path, book.xlsx({ withoutResults: true }));

    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(handed).toMatchObject({
      version: 1,
      status: "checked",
      supported: 1,
      claims: [
        expect.objectContaining({
          where: "sheet “Inputs”",
          text: "Moorings | 2500",
          result: "contradicted",
        }),
      ],
      formulas: { workedOut: 1, notWorkedOut: 0, differ: [] },
    });
  });

  // protects=a handed-over workbook whose cells are all inline strings with figures written as text ("GBP 500,000", "14 days") gets a check Note and flags a wrong figure against the Documents, while a workbook that truly holds nothing to check still says so (#3575); fails_when=hand_over_file answers "found nothing in it to check" for a text workbook, skips making a check Note, or checks an empty/notes-only workbook
  it("checks a handed-over workbook whose figures are written as text and finds a wrong figure, while a genuinely empty one still says nothing to check (#3575)", async () => {
    const CAP = "Liability cap — Value: GBP 500,000";
    const NOTICE = "Notice period — Value: 14 days";
    const { core, coast, writer, files } = await started([], {
      plans: {
        [CAP]: {
          verdict: "supported",
          quote: "The liability cap is GBP 500,000.",
          says: "Agreement states the liability cap is GBP 500,000.",
        },
        [NOTICE]: {
          verdict: "contradicted",
          quote: "The notice period is 30 days.",
          says: "Agreement states the notice period is 30 days, not 14 days.",
        },
      },
    });
    const sources = await createSourceFolder();
    const [agreement] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Agreement.md",
        "# Agreement\n\nThe liability cap is GBP 500,000.\n\nThe notice period is 30 days.\n",
      ),
    ]);
    if (!agreement) throw new Error("No Agreement Document added.");
    await core.assignDocumentGroup(agreement.id, coast.id);

    const agent = await connectLegacyAgent(writer.launch);
    const inline = (ref: string, words: string) =>
      `<c r="${ref}" t="inlineStr"><is><t>${words}</t></is></c>`;
    const textBook = xlsxPackage({
      sheets: [
        {
          name: "Summary",
          xml: `<sheetData><row r="1">${inline("A1", "Term")}${inline("B1", "Value")}</row><row r="2">${inline("A2", "Liability cap")}${inline("B2", "GBP 500,000")}</row><row r="3">${inline("A3", "Notice period")}${inline("B3", "14 days")}</row></sheetData>`,
        },
      ],
    });
    const textPath = join(files, "Commercial terms.xlsx");
    await writeFile(textPath, textBook);

    const handed = structured<Handed>(
      await handOver(agent, { path: textPath, folderId: coast.id }),
    );
    expect(handed.mindId).not.toBeNull();
    expect(handed).toMatchObject({
      version: 1,
      status: "checked",
      why: null,
      supported: 1,
      needLook: 1,
      claims: [
        expect.objectContaining({
          where: "sheet “Summary”",
          text: "Notice period | 14 days",
          result: "contradicted",
          says: "Agreement states the notice period is 30 days, not 14 days.",
        }),
      ],
    });

    // A workbook with only a one-cell note still tells the agent there is nothing in it to check.
    const emptyBook = xlsxPackage({
      sheets: [
        {
          name: "Notes",
          xml: `<sheetData><row r="1">${inline("A1", "Prepared by the team.")}</row></sheetData>`,
        },
      ],
    });
    const emptyPath = join(files, "Empty notes.xlsx");
    await writeFile(emptyPath, emptyBook);

    const emptyHanded = structured<Handed>(
      await handOver(agent, { path: emptyPath, folderId: coast.id }),
    );
    expect(emptyHanded).toMatchObject({
      mindId: null,
      status: "not-checked",
      why: "IncarnaMind kept the file but found nothing in it to check.",
    });
  });

  // protects=with no model set up, the agent checks a workbook it handed over as IncarnaMind's check reads one: each row whole with its headings, its verdict landing on the row, and the next version's rows with their new figures (#3412); fails_when=the agent is given each cell alone, a verdict on a row leaves its cells to check, or the next version gives a row with the figure it had before
  it("gives the agent a workbook's rows whole to check itself with no model, each verdict landing on its row", async () => {
    const { core, coast, writer, files } = await started();
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    const agent = await connectLegacyAgent(writer.launch);
    const budget = (moorings: number) => {
      const book = new WorkbookBuilder();
      book
        .sheet("Inputs")
        .text("A1", "Item")
        .text("B1", "2026")
        .text("A2", "Rent")
        .number("B2", 14000)
        .text("A3", "Moorings")
        .number("B3", moorings);
      return book.xlsx();
    };
    const path = join(files, "Harbour budget.xlsx");
    await writeFile(path, budget(2500));
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(first.status).toBe("not-checked");
    const ownCheck = async (mindId: string | null) =>
      structured<{ task: string; sentences: { n: number; text: string }[] }>(
        await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
      );
    const given = await ownCheck(first.mindId);
    expect(given.sentences.map((each) => each.text)).toEqual([
      "Inputs",
      "Rent — 2026: 14000",
      "Moorings — 2026: 2500",
    ]);

    const { passages } = structured<{ passages: { passageId: string; document: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "rent moorings 2026" } }),
    );
    const notes = passages.filter((each) => each.document === "Harbour budget notes");
    const cite = async (quote: string) => {
      const { citations } = structured<{ citations: { cite: string | null }[] }>(
        await agent.callTool({
          name: "cite",
          arguments: { citations: notes.map(({ passageId }) => ({ passageId, quote })) },
        }),
      );
      return citations.find((each) => each.cite !== null)?.cite;
    };
    const reported = structured<{ marked: number; unreported: number[] }>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId: first.mindId,
          task: given.task,
          results: [
            { n: 1, verdict: "nothing to check" },
            { n: 2, verdict: "supported", cites: [await cite("Rent for 2026 is 14000.")] },
            {
              n: 3,
              verdict: "contradicted",
              cites: [await cite("Moorings for 2026 cost 2200.")],
              explanation: "The budget notes give moorings for 2026 as 2200.",
            },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 2, unreported: [] });
    expect((await ownCheck(first.mindId)).sentences).toEqual([]);

    await writeFile(path, budget(2200));
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second).toMatchObject({ version: 2, status: "not-checked" });
    expect((await ownCheck(second.mindId)).sentences.map((each) => each.text)).toEqual([
      "Inputs",
      "Rent — 2026: 14000",
      "Moorings — 2026: 2200",
    ]);
  });

  // protects=a row the agent judges on several quotes counts as its verdict in what the file's check is said to have found, as one on a single quote does, and Check again gives it no more (#3587); fails_when=a Supported row kept with two quotes counts as not checked or as needing a look, or a Contradicted one as anything else
  it("counts a row judged on several quotes as its verdict", async () => {
    const { core, coast, writer, files } = await started();
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    const agent = await connectLegacyAgent(writer.launch);
    const book = new WorkbookBuilder();
    book
      .sheet("Inputs")
      .text("A1", "Item")
      .text("B1", "2026")
      .text("A2", "Rent")
      .number("B2", 14000)
      .text("A3", "Moorings")
      .number("B3", 2500);
    const path = join(files, "Harbour budget.xlsx");
    await writeFile(path, book.xlsx());
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: first.mindId } }),
    );
    const { passages } = structured<{ passages: { passageId: string; document: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "rent moorings 2026" } }),
    );
    const notes = passages.filter((each) => each.document === "Harbour budget notes");
    const cite = async (quote: string) => {
      const { citations } = structured<{ citations: { cite: string | null }[] }>(
        await agent.callTool({
          name: "cite",
          arguments: { citations: notes.map(({ passageId }) => ({ passageId, quote })) },
        }),
      );
      return citations.find((each) => each.cite !== null)?.cite;
    };
    const rent = await cite("Rent for 2026 is 14000.");
    const moorings = await cite("Moorings for 2026 cost 2200.");
    const reportAndCount = async (
      task: string,
      results: {
        n: number;
        verdict: string;
        cites?: (string | null | undefined)[];
        explanation?: string;
      }[],
    ) => {
      expect(
        structured<{ marked: number }>(
          await agent.callTool({
            name: "report_check",
            arguments: { mindId: first.mindId, task, results },
          }),
        ),
      ).toMatchObject({ marked: 2 });
      return structured<{ sentences: unknown[]; checked: { supported: number; needLook: number } }>(
        await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: first.mindId } }),
      );
    };
    const onOneQuote = await reportAndCount(given.task, [
      { n: 1, verdict: "nothing to check" },
      { n: 2, verdict: "supported", cites: [rent] },
      { n: 3, verdict: "contradicted", cites: [moorings], explanation: "2200." },
    ]);
    expect(onOneQuote.sentences).toEqual([]);
    const again = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({
        name: "check_mind_yourself",
        arguments: { mindId: first.mindId, again: true },
      }),
    );
    const row = (text: string) =>
      again.sentences.find((each) => each.text.startsWith(text))?.n ?? 0;
    const onSeveral = await reportAndCount(again.task, [
      { n: row("Rent"), verdict: "supported", cites: [rent, moorings] },
      {
        n: row("Moorings"),
        verdict: "contradicted",
        cites: [moorings, rent],
        explanation: "2200.",
      },
    ]);
    expect(onSeveral.sentences).toEqual([]);
    expect(onSeveral.checked).toEqual(onOneQuote.checked);
    expect(onSeveral.checked).toMatchObject({ needLook: 1 });
  });

  // protects=IncarnaMind reads only the file the agent named, a regular file of a kind it checks, and only for an agent the User let write (#3412); fails_when=a folder, a link, another kind of file or a read-only agent's call is taken
  it("reads only a deck, workbook, Word file or PDF at the path named, never through a link, and only for an agent that may write", async () => {
    const { writer, reader, files, coast } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deck = join(files, "Harbour review.pptx");
    await writeFile(deck, DECK);
    await mkdir(join(files, "Folder.pptx"));
    await symlink(deck, join(files, "Linked.pptx"));
    await writeFile(join(files, "Notes.txt"), "Some notes.");

    expect(refusal(await handOver(agent, { path: join(files, "Notes.txt") }))).toBe(
      "IncarnaMind takes a deck (.pptx), a workbook (.xlsx), a Word file (.docx) or a PDF.",
    );
    for (const path of [join(files, "Folder.pptx"), join(files, "Linked.pptx"), "Harbour.pptx"]) {
      expect(refusal(await handOver(agent, { path, folderId: coast.id }))).toBe(
        "IncarnaMind reads only the file at the path you named, and couldn’t read one there: give the full path of the file itself, not of a folder or a link.",
      );
    }
    const readOnly = await connectLegacyAgent(reader.launch);
    expect(refusal(await handOver(readOnly, { path: deck }))).toMatch(/propose|change|write/i);
  });

  // protects=Ask your AI on a handed-over file's check asks the agent to fix it in the file and hand it over again, naming the file, its version, where it was handed over from, the slide and the quote the check found (#3412, #3383); fails_when=the request speaks of a note to edit, or loses the slide or the quote
  it("asks the agent to fix what the check flagged in the file, on its slide, to what the quote says, and hand it over again", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const mindId = handed.mindId ?? "";
    const client = await connectToMind(core, mindId);
    await client.settled();
    const flagged = claimSpans(readMind(client)).find((span) => span.sentence.text === SOUTH);
    if (!flagged) throw new Error("The flagged claim has no mark.");

    await core.askAgent({
      pairingId: writer.pairing.id,
      mindId,
      ask: {
        kind: "fix",
        sentences: [
          {
            sentence: SOUTH,
            verdict: "contradicted",
            checkId: flagged.check.id,
            quote: "the south quay holds 19 boats",
          },
        ],
      },
    });
    const read = structured<{ request: string }>(
      await agent.callTool({ name: "read_request", arguments: {} }),
    );
    expect(read.request).toBe(
      `In IncarnaMind, the check of the file you handed over, “Harbour review” (version 1, from ${path}), says this is contradicted by my Documents:\n\nOn slide 2: “${SOUTH}”\n\nMy Documents say: “the south quay holds 19 boats”\nRewrite it to say what that quote says and no more: add no figure, name or claim it doesn’t give.\n\nFix it in the file from my Documents, change nothing else, and hand the file over again with hand_over_file.`,
    );
  });
});
