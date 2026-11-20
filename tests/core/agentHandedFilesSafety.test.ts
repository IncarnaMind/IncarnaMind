/**
 * Files an outside agent hands over (#3412), where a call meets a change: the User takes a grant
 * back while it waits, many calls come at once, a read fails or a write is cut short, the Document
 * is deleted, the app quits before a check ends, a line's heading changes, or no model is set up.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import {
  DECK,
  type Handed,
  handOver,
  NORTH,
  OFFICE,
  PLANS,
  refusal,
  SOUTH,
  started,
  structured,
} from "../helpers/handedFiles";
import type { ModelCall } from "../helpers/models";
import { plainDeck } from "../helpers/pptx";

const en = translate.bind(null, "en") as (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => string;

/** A promise to hold a step at, and how to let it go. */
function gate() {
  let open = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const at = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return { shut, open: () => open(), at, reached: () => reached() };
}

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
        { lines: [OFFICE, SUNDAYS] },
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
    expect(checked).toMatchObject({ version: 2, status: "checked", supported: 2, needLook: 2 });
    // The lines version 1 had too kept their results: only the new one was sent to the model.
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
});
