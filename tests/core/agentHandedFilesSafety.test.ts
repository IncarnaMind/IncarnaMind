/**
 * Files an outside agent hands over (#3412), where a call meets a change: the User takes a grant
 * back while it waits, many calls come at once, a read fails or a write is cut short, the Document
 * is deleted, the app quits before a check ends, a line's heading changes, no model is set up, the
 * check fails once, or what a kept result rests on changes or leaves the agent's reach.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { PNG } from "../helpers/citedPages";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { WorkbookBuilder } from "../helpers/financeWorkbooks";
import {
  DECK,
  gate,
  type Handed,
  handOver,
  NEVER_CLOSES,
  NORTH,
  OFFICE,
  PLANS,
  refusal,
  SOUTH,
  SURVEY,
  started,
  structured,
} from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import { plainDeck } from "../helpers/pptx";

const en = translate.bind(null, "en") as (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => string;

/** The sentences the check of a version sent its model after `before` of `calls`. */
const sentAfter = (calls: readonly ModelCall[], before: number) =>
  new Set(calls.slice(before).filter(isCheckRun).map(sentenceOf));

/** Writes `to` over the words of the Note's heading that reads `from`, as the User would. */
function retitle(blocks: Y.XmlFragment, from: string, to: string) {
  for (const block of blocks.toArray()) {
    const text = block instanceof Y.XmlElement ? block.get(0) : null;
    if (
      block instanceof Y.XmlElement &&
      block.nodeName === "heading" &&
      text instanceof Y.XmlText
    ) {
      if (text.toString() !== from) continue;
      text.delete(0, text.length);
      text.insert(0, to);
      return;
    }
  }
  throw new Error(`No heading reads ${from}.`);
}

/** `blocks` with every text that reads `from` reading `to`, as the User would retype it. */
const retyped = (blocks: JSONContent[], from: string, to: string): JSONContent[] =>
  blocks.map((block) => ({
    ...block,
    ...(block.text === from && { text: to }),
    ...(block.content && { content: retyped(block.content, from, to) }),
  }));

const SUNDAYS = "The harbour office closes on Sundays.";
const AT_NIGHT = "The harbour office is open at night.";

describe("a file an outside agent hands over, where a call meets a change", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a hand-over waiting its turn writes nothing once the User has taken the agent's write grant back (#3412 review); fails_when=the queued call writes a Document and a Note with the grant it had when it started
  it("reads the agent's grant again when its turn comes, and writes nothing once it is taken back", async () => {
    const held = gate();
    const { core, coast, writer, files } = await started([], {
      reading: async () => {
        held.reached();
        await held.shut;
      },
    });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const asked = handOver(agent, { path, folderId: coast.id });
    await held.at;
    await core.updateAgent(writer.pairing.id, { propose: false });
    held.open();
    expect(refusal(await asked)).toBe(en("agents.problem.read-only"));
    expect((await core.listDocuments()).map((each) => each.name)).not.toContain("Harbour review");
  });

  // protects=the check's results reach the agent only while it still reaches the Note: a grant taken back during the check ends the call with a refusal (#3412 review); fails_when=the call returns what the check found after the User took the Folder away
  it("reads what the agent reaches again after the check, and tells nothing once the Folder is taken away", async () => {
    const held = gate();
    let first = true;
    const plans: Record<string, Plan> = {
      ...PLANS,
      [SOUTH]: {
        ...PLANS[SOUTH],
        reply: (call: ModelCall) => {
          const reply = checkReply(call, PLANS);
          if (!first) return reply;
          first = false;
          return { ...reply, pause: { after: 0, until: held.shut, reached: held.reached } };
        },
      },
    };
    const { core, coast, writer, files, more } = await started([], { plans, folders: ["Other"] });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const asked = handOver(agent, { path, folderId: coast.id });
    await held.at;
    await core.updateAgent(writer.pairing.id, { folderIds: more.map((each) => each.id) });
    held.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
  });

  // protects=a file handed over into no Folder is checked only against the Documents its agent reaches, so what an unshared Folder's Document says never reaches the agent (#3412 review); fails_when=the check searches every Document and the reply says what a Document beyond the agent's reach states
  it("checks a file in no Folder only against what its agent reaches, and says nothing of the rest", async () => {
    const plans: Record<string, Plan> = {
      ...PLANS,
      [AT_NIGHT]: {
        verdict: "contradicted",
        quote: "The harbour office closes at night.",
        says: "The vault notes say the office closes at night.",
      },
    };
    const { core, files } = await started([], { plans });
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    const sources = join(files, "sources");
    await mkdir(sources);
    const [secret] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Vault notes.md",
        "# Vault notes\n\nThe harbour office closes at night.\n",
      ),
    ]);
    if (!secret) throw new Error("No vault notes.");
    await core.assignDocumentGroup(secret.id, vault.id);
    const cursor = await core.connectAgent({
      name: "Cursor",
      folderIds: [NOT_IN_A_FOLDER_ID],
      propose: true,
    });
    const agent = await connectLegacyAgent(cursor.launch);
    const path = join(files, "Office hours.pptx");
    await writeFile(path, plainDeck([{ title: "Office hours" }, { lines: [AT_NIGHT] }]));

    const handed = structured<Handed>(await handOver(agent, { path }));
    expect(handed.status).not.toBe("running");
    expect(JSON.stringify(handed)).not.toContain("closes at night");
    expect(handed.claims.map((claim) => claim.result)).not.toContain("contradicted");
  });

  // protects=calls at once can't pass the hour's limit together: a place is taken before the file is read, and the 60th call still goes through (#3412 review); fails_when=two calls at the 60th place both succeed, or the 60th call alone is refused
  it("takes a place in the hour's count before reading, so calls at once can't pass the limit", async () => {
    const { coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    for (let call = 0; call < 59; call++) {
      structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    }

    const both = await Promise.all([handOver(agent, { path }), handOver(agent, { path })]);
    const refused = both.filter((each) => (each as { isError?: boolean }).isError === true);
    expect(refused).toHaveLength(1);
    expect(refusal(refused[0])).toBe(en("agents.handOver.tooMany", { max: 60 }));
  }, 120_000);

  // protects=a changed file whose read fails is told at once, and the next file read well is its next version, checked (#3412 review); fails_when=the call waits two minutes for a version that never comes, holding every other hand-over behind it, or an earlier failure stops the next version
  it("says at once when a changed file can't be read, and checks the next one", async () => {
    const { coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));

    await writeFile(path, "This is not a deck.");
    const broken = structured<Handed>(await handOver(agent, { path }));
    expect(broken).toMatchObject({
      version: 2,
      status: "not-checked",
      why: en("agents.handOver.unread.unreadable"),
      mindId: null,
    });

    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const next = structured<Handed>(await handOver(agent, { path }));
    expect(next).toMatchObject({ version: 3, status: "checked", supported: 1, needLook: 0 });
  }, 30_000);

  // protects=a version whose copy couldn't be written is made from where it stopped when the same file is handed over again (#3412 review); fails_when=the retry reports the version not checked for good, with no Note
  it("goes on from where a cut-short hand-over stopped when the same file comes again", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("No Document.");
    // Its copy's place taken by a folder: the next version's write fails.
    await rm(document.path);
    await mkdir(document.path);

    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    expect((await handOver(agent, { path })).isError).toBe(true);
    await rm(document.path, { recursive: true });
    const resumed = structured<Handed>(await handOver(agent, { path }));
    expect(resumed).toMatchObject({ version: 2, status: "checked", supported: 1, needLook: 0 });
    expect(resumed.mindId).not.toBeNull();
  });

  // protects=a file whose Document the User deleted is a Document again at its next version, checked (#3412 review); fails_when=the call fails on the deleted Document and leaves a version with no check
  it("makes a new Document of the next version once the User deleted the file's Document", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const first = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!first) throw new Error("No Document.");
    await core.deleteDocuments([first.id]);

    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const next = structured<Handed>(await handOver(agent, { path }));
    expect(next).toMatchObject({ version: 2, status: "checked", supported: 1, needLook: 0 });
    const now = (await core.listDocuments()).filter((each) => each.name === "Harbour review");
    expect(now).toHaveLength(1);
    expect(now[0]?.id).not.toBe(first.id);
  });

  // protects=whether a version's check ended is kept, so after a quit an unfinished check is made, keeping the results that stand, and never read as checked from the marks it has (#3412 review); fails_when=a version with some marks reads as checked after a restart though its other lines were never checked
  it("keeps whether a check ended, and after a quit makes the one that didn't", async () => {
    const plans: Record<string, Plan> = {
      ...PLANS,
      [SUNDAYS]: {
        verdict: "contradicted",
        quote: "The harbour office is open every day of the year.",
        says: "Harbour survey says the office is open every day.",
      },
    };
    const calls: ModelCall[] = [];
    const { core, coast, writer, files, restart } = await started(calls, { plans });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    await writeFile(
      path,
      plainDeck([
        { title: "Harbour review" },
        { lines: [NORTH, SOUTH] },
        { lines: [OFFICE, NEVER_CLOSES] },
        { lines: [SUNDAYS] },
      ]),
    );
    const unchecked = structured<Handed>(await handOver(agent, { path }));
    expect(unchecked).toMatchObject({
      version: 2,
      status: "not-checked",
      supported: 0,
      needLook: 0,
    });
    await agent.close();

    const reopened = await restart();
    await reopened.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const again = await connectLegacyAgent(writer.launch);
    const before = calls.length;
    const checked = structured<Handed>(await handOver(again, { path }));
    expect(checked).toMatchObject({ version: 2, status: "checked", supported: 2, needLook: 3 });
    // The slides version 1 had too kept their results: only the new one's line was sent to the model.
    expect(new Set(calls.slice(before).filter(isCheckRun).map(sentenceOf))).toEqual(
      new Set([SUNDAYS]),
    );
    await again.close();
    await reopened.close();
  }, 60_000);

  // protects=a result is carried to the next version only with the context it was checked with: a line whose slide title changed is checked again, one whose context is the same keeps its result (#3412 review); fails_when=a line under a heading changed from 2025 to 2026 keeps its 2025 result
  it("checks a line again when its heading changed, and keeps the result of one whose context didn't", async () => {
    const calls: ModelCall[] = [];
    const { coast, writer, files } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(
      path,
      plainDeck([
        { title: "2025", lines: [NORTH] },
        { title: "Office", lines: [OFFICE] },
      ]),
    );
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const before = calls.length;

    await writeFile(
      path,
      plainDeck([
        { title: "2026", lines: [NORTH] },
        { title: "Office", lines: [OFFICE] },
      ]),
    );
    structured<Handed>(await handOver(agent, { path }));
    expect(new Set(calls.slice(before).filter(isCheckRun).map(sentenceOf))).toEqual(
      new Set([NORTH]),
    );
  });

  // protects=a deck's line is judged with its own slide, so an edit re-checks only the lines of the slide it is on, whatever the slides before and after hold, titled or not (#3455); fails_when=one edited line re-checks every line after it within the reach of the lines above, across slides
  it("checks again only the lines of the slide an edit is on", async () => {
    const calls: ModelCall[] = [];
    const { coast, writer, files } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    const deck = (opening: string) =>
      plainDeck([
        { lines: ["Harbour review"] },
        { lines: [opening, NORTH] },
        { lines: [SOUTH, OFFICE] },
      ]);
    await writeFile(path, deck("The harbour has two quays, north and south."));
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const before = calls.length;

    await writeFile(path, deck("The harbour has a north quay and a south quay."));
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, before)).toEqual(new Set([NORTH]));
  });

  // protects=a slide's number is no part of what its lines are judged with: a slide put in before a checked one leaves every line after it standing, and a changed box on a slide checks that slide's lines again (#3455 review); fails_when=inserting a slide checks every later slide's lines again, or a box's change keeps its slide's results
  it("keeps the results of a slide's lines when a slide is put in before it, and checks them again when a box on it changes", async () => {
    const calls: ModelCall[] = [];
    const { coast, writer, files } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    const quays = { title: "Quays", lines: [NORTH] };
    await writeFile(path, plainDeck([quays, { title: "Office", lines: [OFFICE] }]));
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const inserted = calls.length;

    await writeFile(
      path,
      plainDeck([{ title: "South", lines: [SOUTH] }, quays, { title: "Office", lines: [OFFICE] }]),
    );
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, inserted)).toEqual(new Set([SOUTH]));
    const changed = calls.length;

    await writeFile(
      path,
      plainDeck([
        { title: "South", lines: [SOUTH] },
        quays,
        { title: "Office", lines: [OFFICE, NEVER_CLOSES] },
      ]),
    );
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, changed)).toEqual(new Set([OFFICE, NEVER_CLOSES]));
  });

  // protects=a result stands on exactly what its check was sent: a deck's cell that Check this Note judged with its slide keeps its result into the next version while its slide is the same, and loses it once anything else on the slide changes (#3455 review); fails_when=a cell judged with its slide is fingerprinted by the Note's lines alone, so its result stays current after its slide changed
  it("keeps a deck cell's own check while its slide stands, and drops it once the slide changes", async () => {
    const plans: Record<string, Plan> = {
      ...PLANS,
      "42": {
        verdict: "supported",
        quote: "The north quay holds 42 boats",
        says: "Harbour survey says the north quay holds 42 boats.",
      },
    };
    const { core, coast, writer, files } = await started([], { plans });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    const deck = (title: string, office: readonly string[]) =>
      plainDeck([
        {
          title,
          table: [
            ["Berth", "Boats"],
            ["North quay", "42"],
          ],
        },
        { title: "Office", lines: [...office] },
      ]);
    const marks = async (mindId: string | null) => {
      const client = await connectToMind(core, mindId ?? "");
      await client.settled();
      return claimSpans(readMind(client))
        .filter((span) => span.sentence.text === "42")
        .map((span) => span.check.state);
    };
    await writeFile(path, deck("Moorings", [OFFICE]));
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await core.checkMind({
      requestId: crypto.randomUUID(),
      mindId: first.mindId ?? "",
      mode: "all",
    });
    expect(await marks(first.mindId)).toEqual(["supported"]);

    // Another slide changed: the cell's slide is the same, and its result stands.
    await writeFile(path, deck("Moorings", [OFFICE, NEVER_CLOSES]));
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(await marks(second.mindId)).toEqual(["supported"]);

    // Its own slide's title changed: what it was judged with changed, and its result goes.
    await writeFile(path, deck("Berths", [OFFICE, NEVER_CLOSES]));
    const third = structured<Handed>(await handOver(agent, { path }));
    expect(await marks(third.mindId)).toEqual([]);
  });

  // protects=the Note's page reads each result by the one reading the core and the agents use: a row whose column heading the User changed in the window since its check shows Needs re-check on the page, from what the core says the row is judged with now, and the agent's hand-over checks it again (#3455); fails_when=the page keeps showing a result that exports and the agent are told needs a re-check, or the window's editor drops what a result was judged with
  it("shows on the Note's page a row whose heading changed since its check as needing a re-check, as the agent is told", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer, files } = await started(calls);
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
    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(handed).toMatchObject({ status: "checked", supported: 1, needLook: 1 });
    const mindId = handed.mindId ?? "";
    const client = await connectToMind(core, mindId);
    await client.settled();

    editMind(client, (blocks) => retyped(blocks, "2026", "2025"));
    await client.settled();
    const versions = new Map(
      (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
    );
    const { lines } = await core.judgedWithNow(mindId);
    const page = claimsOf(readMind(client), {
      footing: "not-yet-known",
      versions,
      folderId: coast.id,
      scope: null,
      judgedNow: new Map(Object.entries(lines)),
    });
    expect(page.claims.map((claim) => claim.shown)).toEqual([
      { state: "needs-recheck", why: "context" },
      { state: "needs-recheck", why: "context" },
    ]);

    const before = calls.length;
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, before)).toEqual(
      new Set(["Rent — 2025: 14000", "Moorings — 2025: 2500"]),
    );
  });

  // protects=no result reaches the agent from a version no check has said stands: with no model set up, a new version tells no carried verdict (#3412 review); fails_when=the agent reads the version before's verdicts as the new version's
  it("tells no result for a version its check couldn't make", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }

    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH, SOUTH] }]));
    expect(structured<Handed>(await handOver(agent, { path }))).toMatchObject({
      version: 2,
      status: "not-checked",
      supported: 0,
      needLook: 0,
      claims: [],
    });
  });
  // protects=a check of a handed-over file that failed (a service down for a moment) is made again when the agent hands the same file over again, its earlier failure never told for good (#3412 review); fails_when=every later hand-over of the file returns the first failure though the service is back
  it("tries the check again when the same file comes after a check that failed", async () => {
    let failing = true;
    const calls: ModelCall[] = [];
    const generate = checkGenerate(PLANS);
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return checkReply(call, PLANS);
      },
      {
        generate: (call) =>
          failing && call.question === "find-claims"
            ? { error: { status: 400, message: "The service couldn’t take the request." } }
            : generate(call),
      },
    );
    const { coast, writer, files } = await started(calls, { model });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    expect(structured<Handed>(await handOver(agent, { path, folderId: coast.id }))).toMatchObject({
      version: 1,
      status: "not-checked",
      claims: [],
    });

    failing = false;
    expect(structured<Handed>(await handOver(agent, { path }))).toMatchObject({
      version: 1,
      status: "checked",
      supported: 2,
      needLook: 2,
    });
  });

  // protects=a Note an agent writes with a picture is written only while the agent may still write: a grant the User took back while the picture was read writes nothing (#3458 review); fails_when=create_mind writes the Note with the grant it had before the picture was read
  it("writes no Note once the agent's write grant is taken back while its picture is read", async () => {
    const held = gate();
    const { core, coast, writer, files } = await started([], {
      reading: async () => {
        held.reached();
        await held.shut;
      },
    });
    const agent = await connectLegacyAgent(writer.launch);
    const picture = join(files, "chart.png");
    await writeFile(picture, PNG);
    const asked = agent.callTool({
      name: "create_mind",
      arguments: {
        title: "Harbour chart",
        markdown: `The north quay holds 42 boats.\n\n![Quays](${picture})`,
        folderId: coast.id,
      },
    });
    await held.at;
    await core.updateAgent(writer.pairing.id, { propose: false });
    held.open();
    expect(refusal(await asked)).toBe(en("agents.problem.read-only"));
    expect((await core.listMinds()).map((each) => each.title)).not.toContain("Harbour chart");
  });

  // protects=a result carried to a file's next version stands only while the agent reaches the Document it rests on: one resting on a Document the User has since filed outside the agent's Folders is checked again within its reach (#3412 review); fails_when=the next version keeps a Supported resting on a Document the agent can no longer reach
  it("checks a kept result again once the agent no longer reaches the Document it rests on", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer, files, added } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH, OFFICE] }]));
    expect(structured<Handed>(await handOver(agent, { path, folderId: coast.id }))).toMatchObject({
      status: "checked",
      supported: 2,
    });
    const survey = added.find((each) => each.name === "Harbour survey");
    if (!survey) throw new Error("No survey.");
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.assignDocumentGroup(survey.id, vault.id);
    const before = calls.length;

    await writeFile(
      path,
      plainDeck([{ title: "Harbour review" }, { lines: [NORTH, OFFICE] }, { lines: [SUNDAYS] }]),
    );
    const next = structured<Handed>(await handOver(agent, { path }));
    // The new slide's line makes no claim: what changed is only what the two rest on.
    expect(sentAfter(calls, before)).toEqual(new Set([NORTH, OFFICE]));
    expect(next).toMatchObject({ version: 2, status: "checked", supported: 0 });
    expect(JSON.stringify(next)).not.toContain("Harbour survey says");
  });

  // protects=a result is carried only to a line read as it was judged: what the result keeps of its judging, not the earlier Note as the User has edited it since (#3412 review); fails_when=after the User changed the earlier version's heading to the next version's, its line's result made under the old heading is carried to the next version
  it("checks a line again when the earlier version's Note was edited above it since its check", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer, files } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    const deck = (year: string) =>
      plainDeck([
        { title: year, lines: [NORTH] },
        { title: "Office", lines: [OFFICE] },
      ]);
    await writeFile(path, deck("2025"));
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const client = await connectToMind(core, first.mindId ?? "");
    retitle(client.blocks, "2025", "2026");
    await client.settled();
    const before = calls.length;

    await writeFile(path, deck("2026"));
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, before)).toEqual(new Set([NORTH]));
  });

  // protects=what a result was judged with survives the window's editor: a Note the User opened and edited there still carries its results to the file's next version (#3412); fails_when=the editor's write-back drops the fingerprint from every mark, and the next version checks every line again
  it("carries results to the next version after the User edited the Note in the window", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer, files } = await started(calls);
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const client = await connectToMind(core, first.mindId ?? "");
    await client.settled();
    // Written back through the window's editor, as any edit there writes its Blocks.
    editMind(client, (blocks) => blocks);
    await client.settled();
    const before = calls.length;

    await writeFile(
      path,
      plainDeck([
        { title: "Harbour review" },
        { lines: [NORTH, SOUTH] },
        { lines: [OFFICE, NEVER_CLOSES] },
        { lines: [SUNDAYS] },
      ]),
    );
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, before)).toEqual(new Set());
  });

  // protects=a hand-over tells as Supported only a result whose Documents are still at the versions it read: once one changed, the result is checked again before it is counted, a file in no Folder too, which no background check covers (#3412 review); fails_when=the same file handed over again after its evidence Document changed reports the earlier Supported as current
  it("checks a result again once its Document changed, before it is counted, for a file in no Folder", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, files, added } = await started(calls);
    const cursor = await core.connectAgent({
      name: "Cursor",
      folderIds: [coast.id, NOT_IN_A_FOLDER_ID],
      propose: true,
    });
    const agent = await connectLegacyAgent(cursor.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    expect(
      structured<Handed>(await handOver(agent, { path, folderId: NOT_IN_A_FOLDER_ID })),
    ).toMatchObject({ folder: "", status: "checked", supported: 2 });
    const survey = added.find((each) => each.name === "Harbour survey");
    if (!survey) throw new Error("No survey.");
    await writeFile(survey.path, `${SURVEY}\n\nThe harbour has one crane.\n`);
    await core.reconcileDocuments();
    await waitForProcessing(core, [survey.id]);
    const before = calls.length;

    const again = structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, before)).toEqual(new Set([NORTH, SOUTH, OFFICE, NEVER_CLOSES]));
    expect(again).toMatchObject({ version: 1, status: "checked", supported: 2, needLook: 2 });
  });

  // protects=a result of a handed PDF stands on its own words and the headings it is under: the next version checks again the lines under a heading whose period changed, and only the line that changed when a line changes, not the lines after it (#3455); fails_when=a line keeps a result made under a heading that names another year, or one changed line sends every line after it to the model again
  it("checks again the lines under a changed heading of a PDF's next version, and of a changed line only it", async () => {
    const forty = "The north quay holds 40 boats.";
    const plans: Record<string, Plan> = {
      ...PLANS,
      [forty]: {
        verdict: "contradicted",
        quote: "The north quay holds 42 boats",
        says: "Harbour survey says the north quay holds 42 boats, not 40.",
      },
    };
    const calls: ModelCall[] = [];
    const { coast, writer, files } = await started(calls, { plans });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour notes.pdf");
    const notes = (year: string, north: string) =>
      buildPdf([{ lines: [`1 Quays in ${year}`, north, SOUTH, "2 Office", OFFICE] }]);
    await writeFile(path, notes("2025", NORTH));
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const renamed = calls.length;

    await writeFile(path, notes("2026", NORTH));
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, renamed)).toEqual(new Set([NORTH, SOUTH]));
    const changed = calls.length;

    await writeFile(path, notes("2026", forty));
    structured<Handed>(await handOver(agent, { path }));
    expect(sentAfter(calls, changed)).toEqual(new Set([forty]));
  });

  // protects=the results an agent's own check reported on a handed file read as the file's check's do: editing one of its claims in the Note re-checks that claim alone, and the agent's Contradicted and Not found after it still show (#3412, #3455); fails_when=one edit turns every result the agent reported after it to Needs re-check
  it("keeps the agent's own results after an edited claim of a handed file", async () => {
    const { core, coast, writer, files } = await started();
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour notes.pdf");
    await writeFile(path, buildPdf([{ lines: [NORTH, SOUTH, AT_NIGHT] }]));
    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const mindId = handed.mindId ?? "";
    const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
    );
    const n = (text: string) => given.sentences.find((each) => each.text === text)?.n;
    const { passages } = structured<{ passages: { passageId: string; document: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "north quay south quay boats" } }),
    );
    const cite = async (quote: string) => {
      const { citations } = structured<{ citations: { cite: string | null }[] }>(
        await agent.callTool({
          name: "cite",
          arguments: {
            citations: passages
              .filter((each) => each.document === "Harbour survey")
              .map(({ passageId }) => ({ passageId, quote })),
          },
        }),
      );
      return citations.find((each) => each.cite !== null)?.cite;
    };
    const reported = structured<{ marked: number; unreported: number[] }>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId,
          task: given.task,
          results: [
            {
              n: n(NORTH),
              verdict: "supported",
              cites: [await cite("The north quay holds 42 boats")],
            },
            {
              n: n(SOUTH),
              verdict: "contradicted",
              cites: [await cite("the south quay holds 19 boats")],
              explanation: "The survey gives the south quay 19 boats.",
            },
            { n: n(AT_NIGHT), verdict: "not found" },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 3, unreported: [] });
    const client = await connectToMind(core, mindId);
    await client.settled();
    const page = async () => {
      await client.settled();
      const { lines } = await core.judgedWithNow(mindId);
      return claimsOf(readMind(client), {
        footing: "not-yet-known",
        versions: new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash])),
        folderId: coast.id,
        scope: null,
        judgedNow: new Map(Object.entries(lines)),
      }).claims.map((claim) => claim.shown.state);
    };
    expect(await page()).toEqual(["supported", "contradicted", "unsupported"]);

    editMind(client, (blocks) => retyped(blocks, NORTH, `Today ${NORTH.toLowerCase()}`));

    expect(await page()).toEqual(["needs-recheck", "contradicted", "unsupported"]);
  });
});
