/**
 * Files an outside agent hands over (#3412), where a call meets a change: the User takes a grant
 * back while it waits, many calls come at once, a read fails or a write is cut short, the Document
 * is deleted, the app quits before a check ends, a line's heading changes, no model is set up, the
 * check fails once, or what a kept result rests on changes or leaves the agent's reach.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, link, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { hashBytes } from "../../src/core/documents/files";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { keepCheckAsView } from "../../src/shared/claimParts";
import { translate } from "../../src/shared/i18n";
import { countingCheckOf } from "../../src/shared/markKeys";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { PNG } from "../helpers/citedPages";
import { startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkWithoutFolder,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { refuseChangesOf } from "../helpers/failingStorage";
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
import { paragraph, table, wordFile } from "../helpers/word";

// Each file the core opens to read, and each it writes whole (by its rename into place), by its
// path: what a start reads and writes of the handed files. `next` holds, by path, one step to run
// at the next read of that file, rename into it (`renamed`: after it), listing of that folder or
// look at it: what a test does while that step waits.
const opened = vi.hoisted(() => [] as string[]);
const written = vi.hoisted(() => [] as string[]);
const next = vi.hoisted(() => ({
  read: new Map<string, () => Promise<void>>(),
  rename: new Map<string, () => Promise<void>>(),
  renamed: new Map<string, () => Promise<void>>(),
  list: new Map<string, () => Promise<void>>(),
  stat: new Map<string, () => Promise<void>>(),
}));
const once = vi.hoisted(() => async (steps: Map<string, () => Promise<void>>, path: string) => {
  const step = steps.get(path);
  if (!step) return;
  steps.delete(path);
  await step();
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const { Readable } = await import("node:stream");
  const createReadStream = ((...args: Parameters<typeof real.createReadStream>) => {
    const path = String(args[0]);
    opened.push(path);
    if (!next.read.has(path)) return real.createReadStream(...args);
    return Readable.from(
      (async function* () {
        await once(next.read, path);
        yield* real.createReadStream(...args);
      })(),
    );
  }) as typeof real.createReadStream;
  return { ...real, createReadStream };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof real.readFile>) => {
    opened.push(String(args[0]));
    await once(next.read, String(args[0]));
    return real.readFile(...args);
  }) as typeof real.readFile;
  const rename = (async (...args: Parameters<typeof real.rename>) => {
    const to = String(args[1]);
    written.push(to);
    await once(next.rename, to);
    await real.rename(...args);
    await once(next.renamed, to);
  }) as typeof real.rename;
  const readdir = (async (...args: Parameters<typeof real.readdir>) => {
    await once(next.list, String(args[0]));
    return real.readdir(...args);
  }) as typeof real.readdir;
  const stat = (async (...args: Parameters<typeof real.stat>) => {
    await once(next.stat, String(args[0]));
    return real.stat(...args);
  }) as typeof real.stat;
  return { ...real, readFile, rename, readdir, stat };
});

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

  // protects=a hand-over refused after it recorded its version keeps nothing of it: no version, no copy in the data folder, no check Note, the file's Document back to the version before, and that Note named as before; handed over again once the agent reaches the Folder, the same file is that next version, checked (#3751); fails_when=the refused version, its copy or its Note stays, or the Document keeps its bytes
  it("takes back a version refused after its check, and makes it again when the same file comes", async () => {
    const held = gate();
    let holding = false;
    const plans: Record<string, Plan> = {
      ...PLANS,
      [OFFICE]: {
        ...PLANS[OFFICE],
        reply: (call: ModelCall) => {
          const reply = checkReply(call, PLANS);
          if (!holding) return reply;
          holding = false;
          return { ...reply, pause: { after: 0, until: held.shut, reached: held.reached } };
        },
      },
    };
    const { core, coast, writer, files, more, dataDir } = await started([], {
      plans,
      folders: ["Other"],
    });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document || first.mindId === null) throw new Error("The first version wasn't kept.");
    const checkNote = en("verify.mindTitle", { name: "Harbour review" });

    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH, OFFICE] }]));
    holding = true;
    const asked = handOver(agent, { path });
    await held.at;
    const refused = (await core.listMinds()).find(
      (each) => each.id !== first.mindId && each.title === checkNote,
    );
    if (!refused) throw new Error("The second version's check Note wasn't made.");
    await core.updateAgent(writer.pairing.id, { folderIds: more.map((each) => each.id) });
    held.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect((await core.handedFileOf(first.mindId))?.file.version).toBe(1);
    expect(readdirSync(join(dataDir, "Handed files", first.fileId)).sort()).toEqual([
      "file-1.pptx",
      "v1",
    ]);
    const now = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(document.contentHash);
    const notes = await core.listMinds();
    expect(notes.map((each) => each.id)).not.toContain(refused.id);
    expect(
      notes
        .filter((each) => each.title.endsWith(": Harbour review"))
        .map((each) => [each.id, each.title]),
    ).toEqual([[first.mindId, checkNote]]);
    expect((await core.listDeleted()).map((each) => each.name)).toEqual([]);

    await core.updateAgent(writer.pairing.id, { folderIds: [coast.id] });
    const again = structured<Handed>(await handOver(agent, { path }));
    expect(again).toMatchObject({ fileId: first.fileId, version: 2, status: "checked" });
    expect(again.mindId).not.toBeNull();
  });

  // protects=a hand-over refused after the User edited its deck by hand while its check ran keeps the User's edit: the Document, both versions and the check Note stay theirs, and nothing goes to Recently deleted or is deleted for good (#3751, #149); fails_when=the refusal ends the item, deletes the Document, or writes back over the hand edit
  it("keeps a hand edit made to the deck while a refused hand-over's check ran", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    const edit = await core.editDeck({
      documentId: document.id,
      sittingId: null,
      shown: document.contentHash,
      edits: [{ kind: "box", slide: 2, shape: "3", box: { x: 60, y: 115, w: 840, h: 126 } }],
    });
    if (edit.kind !== "saved") throw new Error(`Not saved: ${edit.why}`);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, hashBytes(edit.bytes), 2);
  });

  // protects=a hand-over refused after the User's own app changed the agent's Word file in its Linked folder while the check ran keeps the change: the Document holds it, the version and the check Note stay, nothing goes to Recently deleted or is deleted for good (#3751); fails_when=the refusal ends the item or deletes the check Note of a file the User changed since
  it("keeps the User's change to a Word file in its Linked folder made while a refused hand-over's check ran", async () => {
    const waiting = await waitingHandOver({ linked: true, name: "Harbour review.docx" });
    const { core, path } = waiting;
    await writeFile(path, wordFile({ body: paragraph(OFFICE) }));
    const asked = waiting.handOver();
    await waiting.held.at;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The Word file isn't in the Library.");
    const changed = wordFile({ body: [paragraph(OFFICE), paragraph(NORTH)].join("") });
    await writeFile(path, changed);
    await core.reconcileDocuments();
    await waitForDocuments(core, (all) =>
      expect(all.find((each) => each.id === document.id)?.contentHash).toBe(hashBytes(changed)),
    );
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, hashBytes(changed), 1);
  });

  // protects=a new item refused after its check, of the agent's Word file in a Linked folder, ends with the file a source again: the Not cited the hand-over gave it goes once no item is the agent's file there, and the file stays in its folder (#3751); fails_when=the file stays Not cited with no item holding it, so the User's own file is never evidence again
  it("leaves a Linked folder's file a source again when a refused hand-over takes back its new item", async () => {
    const waiting = await waitingHandOver({ linked: true, name: "Harbour review.docx" });
    const { core, path } = waiting;
    await writeFile(path, wordFile({ body: paragraph(OFFICE) }));
    const asked = waiting.handOver();
    await waiting.held.at;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    expect(document?.notCited).toBe(true);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const now = (await core.listDocuments()).find((each) => each.id === document?.id);
    expect(now).toMatchObject({ path, notCited: false });
    expect((await core.listMinds()).map((each) => each.title)).not.toContain(
      en("verify.mindTitle", { name: "Harbour review" }),
    );
  });

  // protects=a Linked folder's file a hand-over made Not cited, in a try that failed part way, is a source again when the next try of it goes on from there and is refused: the take-back undoes what either try set (#3751); fails_when=the file stays Not cited with no item holding it
  it("leaves a Linked folder's file a source again when a try that failed goes on and is refused", async () => {
    const waiting = await waitingHandOver({ linked: true, name: "Harbour review.docx" });
    const { core, path, dataDir } = waiting;
    await writeFile(path, wordFile({ body: paragraph(OFFICE) }));
    const mend = refuseChangesOf(dataDir, "agent_file_versions", "mind_id");
    try {
      expect((await waiting.handOver()).isError).toBe(true);
    } finally {
      mend();
    }
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    expect(document?.notCited).toBe(true);
    const asked = waiting.handOver();
    await waiting.held.at;
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const now = (await core.listDocuments()).find((each) => each.id === document?.id);
    expect(now).toMatchObject({ path, notCited: false });
  });

  // protects=a Linked folder's file the agent wrote and the User made Not cited before it was handed over stays Not cited when a refused hand-over takes back its new item: the take-back undoes only what the hand-over set (#3751); fails_when=the refusal makes the User's Not cited file a source again
  it("keeps a Linked folder's file Not cited by the User when a refused hand-over takes back its new item", async () => {
    const waiting = await waitingHandOver({ linked: true, name: "Harbour review.docx" });
    const { core, path } = waiting;
    await writeFile(path, wordFile({ body: paragraph(OFFICE) }));
    await core.reconcileDocuments();
    const found = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!found) throw new Error("The Linked folder didn't read the agent's file");
    await core.setNotCited(found.id, true);
    const asked = waiting.handOver();
    await waiting.held.at;
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const now = (await core.listDocuments()).find((each) => each.id === found.id);
    expect(now).toMatchObject({ path, notCited: true });
  });

  // protects=two agents handing over one file at once, by two paths to it, take turns: the second waits for the first to end, so a first refused and taken back leaves the file to the second, as one after it would (#3751); fails_when=the second call runs beside the first and is refused as a file the Library holds already, by a Document the first's refusal then takes back
  it("takes calls of one file by two agents and two paths to it in turn", async () => {
    const waiting = await waitingHandOver();
    const { core, coast, path, files } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const linked = join(await createSourceFolder(), "link");
    await symlink(files, linked);
    const second = await core.connectAgent({
      name: "Gemini CLI",
      folderIds: [coast.id],
      propose: true,
    });
    const other = await connectLegacyAgent(second.launch);
    const beside = handOver(other, {
      path: join(linked, "Harbour review.pptx"),
      folderId: coast.id,
    });
    // While the first call's check runs, the second waits its turn rather than answering.
    const answered = await Promise.race([
      beside.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(answered).toBe(false);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const handed = structured<Handed>(await beside);
    expect(handed).toMatchObject({ version: 1, folder: "Coast", status: "checked" });
    const document = (await core.listDocuments()).filter((each) => each.name === "Harbour review");
    expect(document).toHaveLength(1);
    expect(await core.listDeleted()).toEqual([]);
  });

  // protects=two agents handing over one file at once, by its path and a hard link to it, take turns as by two paths to it: the second waits for the first to end, so a first refused and taken back leaves the file to the second, as one after it would (#3751); fails_when=the second call runs beside the first and is refused as a file the Library holds already, by a Document the first's refusal then takes back
  it("takes calls of one file by two agents and a hard link to it in turn", async () => {
    const waiting = await waitingHandOver();
    const { core, coast, path } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const linked = join(await createSourceFolder(), "Harbour review.pptx");
    await link(path, linked);
    const second = await core.connectAgent({
      name: "Gemini CLI",
      folderIds: [coast.id],
      propose: true,
    });
    const other = await connectLegacyAgent(second.launch);
    const beside = handOver(other, {
      path: linked,
      folderId: coast.id,
    });
    // While the first call's check runs, the second waits its turn rather than answering.
    const answered = await Promise.race([
      beside.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(answered).toBe(false);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const handed = structured<Handed>(await beside);
    expect(handed).toMatchObject({ version: 1, folder: "Coast", status: "checked" });
    const document = (await core.listDocuments()).filter((each) => each.name === "Harbour review");
    expect(document).toHaveLength(1);
    expect(await core.listDeleted()).toEqual([]);
  });

  // protects=a version's check rests only on what the agent reaches once its Note is made: a Folder the User takes away while the version is written is no evidence for a file in no Folder, which is checked against all the agent reaches (#3751); fails_when=the check sends the model the Folder's Documents as the agent reached them before the wait
  it("checks a version against what the agent reaches after its Note is made", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, files, dataDir } = await started(calls);
    const cursor = await core.connectAgent({
      name: "Cursor",
      folderIds: [coast.id, NOT_IN_A_FOLDER_ID],
      propose: true,
    });
    const agent = await connectLegacyAgent(cursor.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await handOver(agent, { path, folderId: NOT_IN_A_FOLDER_ID }));
    expect(first).toMatchObject({ status: "checked", supported: 1 });

    await writeFile(path, DECK);
    next.rename.set(join(dataDir, "Handed files", first.fileId, "v2", "Harbour review.pptx"), () =>
      core
        .updateAgent(cursor.pairing.id, { folderIds: [NOT_IN_A_FOLDER_ID] })
        .then(() => undefined),
    );
    const before = calls.length;
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second).toMatchObject({
      version: 2,
      status: "not-checked",
      why: en("agents.handOver.notChecked.no-documents"),
    });
    expect(sentAfter(calls, before)).toEqual(new Set());
  });

  // protects=the copy of a version taken back that a quit left in the data folder before the take-back's last step is removed at the next start, and the item's own copies stay (#3751); fails_when=the copy stays where nothing shows it or can remove it, or the start removes a copy a version that stands holds
  it("removes at the next start the copy of a version taken back that a quit left", async () => {
    const waiting = await waitingHandOver();
    const { path, dataDir, restart } = waiting;
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await waiting.handOver());
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    // As a quit before the take-back's last step leaves it: the version's record gone, its copy not.
    const left = join(dataDir, "Handed files", first.fileId, "v2");
    await mkdir(left, { recursive: true });
    await writeFile(join(left, "Harbour review.pptx"), DECK);

    const reopened = await restart();
    await vi.waitFor(() => expect(existsSync(left)).toBe(false));
    expect(readdirSync(join(dataDir, "Handed files", first.fileId)).sort()).toEqual([
      "file-1.pptx",
      "v1",
    ]);
    reopened.close();
  });

  // protects=a core closed as it starts leaves the closed storage and a quit's leftover alone: its start-up clean-up logs nothing and removes nothing (#3751); fails_when=the clean-up reads the closed database, or removes the leftover after the core closed
  it("closed as it starts, leaves a taken-back version's leftover and the closed storage alone", async () => {
    const waiting = await waitingHandOver();
    const { core, path, dataDir } = waiting;
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await waiting.handOver());
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const left = join(dataDir, "Handed files", first.fileId, "v2");
    await mkdir(left, { recursive: true });
    await writeFile(join(left, "Harbour review.pptx"), DECK);
    await core.close();

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startCore(dataDir).close();
    // Work on files that was started takes several round trips to the disk: this takes more.
    for (let hop = 0; hop < 100; hop++) await stat(dataDir);
    expect(errors).not.toHaveBeenCalled();
    expect(existsSync(left)).toBe(true);
    errors.mockRestore();
  });

  // protects=the start's removal of a taken-back version's copy runs before any hand-over writes one: a hand-over asked for at once after the start, its version taking the freed number, keeps its own copy (#3751); fails_when=the removal chosen before the hand-over deletes the new version's copy
  it("keeps the copy of a version handed over at once after a start that removes a quit's leftover", async () => {
    const waiting = await waitingHandOver();
    const { path, dataDir, restart, writer } = waiting;
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await waiting.handOver());
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const left = join(dataDir, "Handed files", first.fileId, "v2");
    await mkdir(left, { recursive: true });
    await writeFile(join(left, "Harbour review.pptx"), DECK);
    await waiting.core.updateAgent(writer.pairing.id, { folderIds: [waiting.coast.id] });

    const reopened = await restart();
    await reopened.setAgentsEnabled(true);
    const next = plainDeck([{ title: "Harbour review" }, { lines: [NORTH, NEVER_CLOSES] }]);
    await writeFile(path, next);
    const again = await handOver(await connectLegacyAgent(writer.launch), { path });
    expect(structured<Handed>(again)).toMatchObject({ fileId: first.fileId, version: 2 });
    expect(hashBytes(new Uint8Array(readFileSync(join(left, "Harbour review.pptx"))))).toBe(
      hashBytes(next),
    );
    reopened.close();
  });

  // protects=a hand-over refused after the User wrote in its check Note while the check ran keeps the Note with the User's words, its version and its Document, and nothing is deleted for good (#3751); fails_when=the take-back deletes the Note the User wrote in
  it("keeps a check Note the User wrote in while a refused hand-over's check ran", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const checkNote = (await core.listMinds()).find(
      (each) => each.title === en("verify.mindTitle", { name: "Harbour review" }),
    );
    if (!checkNote) throw new Error("The check Note wasn't made.");
    await typeAtEnd(core, checkNote.id, "Ask the harbourmaster about the night berths.");
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, document.contentHash, 1);
    const kept = await core.exportMind(checkNote.id, { format: "markdown" });
    expect(new TextDecoder().decode(kept.data)).toContain(
      "Ask the harbourmaster about the night berths.",
    );
  });

  // protects=a version taken back after its refusal names the earlier check Note back only while it has the name the version gave it: a name the User gave it during the wait stays (#3751); fails_when=the take-back writes over the User's name
  it("keeps a name the User gave the earlier check Note while a refused version's check ran", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await waiting.handOver());
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    await core.renameMind(first.mindId ?? "", "Quay deck, first look");
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect((await core.listMinds()).map((each) => each.title)).toContain("Quay deck, first look");
    expect(
      (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
  });

  // protects=another connection of the same agent handing over the same file while a call's check runs waits for that call to end, and makes the item's next version after it: the first, refused once the User moved its check Note, keeps its version and both check Notes, and nothing goes to Recently deleted or is deleted for good (#3751); fails_when=the other call makes its version while the first's check runs, or the refusal ends the item with the other call's version in it
  it("makes another connection's next version of the file once a refused hand-over ends", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const checkNote = (await core.listMinds()).find(
      (each) => each.title === en("verify.mindTitle", { name: "Harbour review" }),
    );
    if (!checkNote) throw new Error("The check Note wasn't made.");
    const next = plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]);
    await writeFile(path, next);
    const other = handOver(await connectLegacyAgent(waiting.writer.launch), { path });
    const answered = await Promise.race([
      other.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(answered).toBe(false);
    expect((await core.handedFileOf(checkNote.id))?.versions).toHaveLength(1);
    // The first call alone is refused: its check Note is moved where the agent doesn't reach.
    const board = await core.createLibraryGroup({ name: "Board only", description: "" });
    await core.moveToFolder({ mindIds: [checkNote.id], folderId: board.id });
    waiting.held.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect(structured<Handed>(await other)).toMatchObject({ version: 2 });
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    await waiting.keptAll(document.id, hashBytes(next), 2);
  });

  // protects=a refused hand-over never writes the version before over the Library's copy of the file once another app saved that copy after the hand-over, before IncarnaMind read it again: the copy keeps that app's bytes, and the version and its check Note stay (#3751); fails_when=the take-back trusts the Document's last read and writes the version before over the copy
  it("keeps the bytes another app saved into the file's copy while a refused hand-over's check ran", async () => {
    const waiting = await secondVersionWaiting();
    const { core, document, checkNote, asked } = waiting;
    const theirs = plainDeck([{ title: "Harbour review" }, { lines: [NORTH, NEVER_CLOSES] }]);
    await writeFile(document.path, theirs);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    await waiting.keptAll(document.id, document.contentHash, 2);
    expect((await core.listMinds()).map((each) => each.id)).toContain(checkNote.id);
  });

  // protects=a refused hand-over whose records can't be taken back takes nothing else back: its version, its check Note, its copy and the bytes it wrote into the Document all stay, and the agent is refused as it would be (#3751); fails_when=the take-back goes on past the records, deleting the check Note and the version's copy or writing the version before back while the version stands
  it("keeps all of a refused version whose records can't be taken back, and refuses as before", async () => {
    const waiting = await secondVersionWaiting();
    const { core, dataDir, document, checkNote, first, asked } = waiting;
    const mend = refuseChangesOf(dataDir, "agent_file_versions", "deleted_at");
    try {
      await waiting.refuse();
      expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
      await waiting.keptAll(document.id, hashBytes(DECK), 2);
      expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
      expect((await core.listMinds()).map((each) => each.id)).toContain(checkNote.id);
      expect(readdirSync(join(dataDir, "Handed files", first.fileId)).sort()).toEqual([
        "file-1.pptx",
        "v1",
        "v2",
      ]);
    } finally {
      mend();
    }
  });

  // protects=a refused hand-over whose version before can't be read back keeps the whole version, so the item's newest version is what its Document holds (#3751); fails_when=the version is taken back while the Document keeps its bytes, and nothing writes the version before back later
  it("keeps a refused version whose version before can't be read back", async () => {
    const waiting = await secondVersionWaiting();
    const { core, dataDir, document, checkNote, first, asked } = waiting;
    await rm(join(dataDir, "Handed files", first.fileId, "v1"), { recursive: true });
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, hashBytes(DECK), 2);
    expect((await core.listMinds()).map((each) => each.id)).toContain(checkNote.id);
  });

  // protects=a refused hand-over whose version before can't be written back into the Document puts its records back and keeps the rest, so the item's newest version is what its Document holds (#3751); fails_when=the version is taken back while the Document keeps its bytes
  it("keeps a refused version whose version before can't be written back", async () => {
    const waiting = await secondVersionWaiting();
    const { core, dataDir, document, checkNote, first, asked } = waiting;
    const folder = join(dataDir, "Handed files", first.fileId);
    await chmod(folder, 0o555);
    try {
      await waiting.refuse();
      expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
      await waiting.keptAll(document.id, hashBytes(DECK), 2);
      expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
      expect((await core.listMinds()).map((each) => each.id)).toContain(checkNote.id);
    } finally {
      await chmod(folder, 0o755);
    }
  });

  // protects=a refused hand-over's take-back writes the version before back only from a copy that holds that version's bytes: one changed since keeps the whole version, and the User's file keeps what it holds (#3751); fails_when=the take-back writes whatever the copy holds into the User's file
  it("keeps a refused version whose version before's copy holds other bytes", async () => {
    const waiting = await secondVersionWaiting();
    const { core, dataDir, document, checkNote, first, asked } = waiting;
    await writeFile(
      join(dataDir, "Handed files", first.fileId, "v1", "Harbour review.pptx"),
      plainDeck([{ title: "Harbour review" }, { lines: [SOUTH] }]),
    );
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    await waiting.keptAll(document.id, hashBytes(DECK), 2);
    expect((await core.listMinds()).map((each) => each.id)).toContain(checkNote.id);
  });

  // protects=a refused hand-over's take-back looks at its Document again after reading its file: a name the User gave it while the file was read keeps the Document, its version and its check Note (#3751); fails_when=the take-back compares the Document's name before that read and deletes the Document the User renamed
  it("keeps a Document the User renamed while a refused hand-over's take-back read its file", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    const reading = holdNext(next.read, document.path);
    await waiting.refuse();
    await reading.at;
    await core.renameDocument(document.id, "Quay works deck");
    reading.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, document.contentHash, 1);
    const kept = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(kept?.name).toBe("Quay works deck");
  });

  // protects=a refused hand-over's take-back looks at the Document it added again just before deleting it: a Tag the User gave it while the take-back deleted the check Note keeps the Document and its file as theirs, with one log line (#3751); fails_when=the Document is deleted for good by what the take-back read of it before
  it("keeps a Document the User tagged while a refused hand-over's take-back deleted its check Note", async () => {
    const waiting = await waitingHandOver();
    const { core, path, dataDir, log } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    const tag = await core.createTag({ name: "Quay works" });
    const deleting = holdNext(next.list, join(dataDir, "Handed files"));
    await waiting.refuse();
    await deleting.at;
    await core.addDocumentTag(document.id, tag.id);
    deleting.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const kept = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(kept?.tags.map((each) => each.tagId)).toEqual([tag.id]);
    expect(kept?.contentHash).toBe(document.contentHash);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(document.contentHash);
    expect(
      (await core.listMinds()).filter((each) => each.title.endsWith(": Harbour review")),
    ).toEqual([]);
    expect(await core.listDeleted()).toEqual([]);
    expect(log.lines.filter((line) => line.includes("handedFile.takeBack.kept"))).toEqual([
      expect.stringContaining('"what":"document"'),
    ]);
  });

  // protects=a refused hand-over's take-back looks at the check Note again just before deleting it: words the User wrote in it while the version before was written back keep it, their own Note no version points to, with one log line, and the earlier Note still gets its name back (#3751); fails_when=the take-back deletes the Note by what it read of it before the write
  it("keeps a check Note the User wrote in while a refused hand-over wrote the version before back", async () => {
    const waiting = await secondVersionWaiting();
    const { core, document, checkNote, first, asked, log } = waiting;
    const writing = holdNext(next.rename, document.path);
    await waiting.refuse();
    await writing.at;
    await typeAtEnd(core, checkNote.id, "Ask the harbourmaster about the night berths.");
    writing.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const named = en("verify.mindTitle", { name: "Harbour review" });
    const notes = await core.listMinds();
    expect(notes.find((each) => each.id === checkNote.id)?.title).toBe(named);
    expect(notes.find((each) => each.id === first.mindId)?.title).toBe(named);
    expect(await core.handedFileOf(checkNote.id)).toBeNull();
    expect(
      (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
    const kept = await core.exportMind(checkNote.id, { format: "markdown" });
    expect(new TextDecoder().decode(kept.data)).toContain(
      "Ask the harbourmaster about the night berths.",
    );
    expect(log.lines.filter((line) => line.includes("handedFile.takeBack.kept"))).toEqual([
      expect.stringContaining('"what":"check note"'),
    ]);
  });

  // protects=a refused hand-over's take-back names the Document back only while it has the name the hand-over gave it: a name the User gave it while the version before was written back stays (#3751); fails_when=the take-back writes the name before over the User's
  it("keeps a name the User gave the Document while a refused hand-over wrote the version before back", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    const first = structured<Handed>(await waiting.handOver());
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    await core.renameDocument(document.id, "Quay deck");
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const writing = holdNext(next.rename, document.path);
    await waiting.refuse();
    await writing.at;
    await core.renameDocument(document.id, "Quay deck, final");
    writing.open();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    const now = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(now?.name).toBe("Quay deck, final");
    expect(
      (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
  });

  // protects=a take-back whose write of the version before fails after the file is in place reads what the file holds: holding the version before, it goes on as written, so the item and its Document agree on that version (#3751); fails_when=the take-back puts the refused version back over a file that holds the version before
  it("goes on with a take-back whose write of the version before fails after the file is in place", async () => {
    const waiting = await secondVersionWaiting();
    const { core, dataDir, document, checkNote, first, asked } = waiting;
    const folder = join(dataDir, "Handed files", first.fileId);
    const before = new Uint8Array(readFileSync(join(folder, "v1", "Harbour review.pptx")));
    failsOnceInPlace(document.path);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(before));
    expect(
      (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
    const now = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(hashBytes(before));
    expect((await core.listMinds()).map((each) => each.id)).not.toContain(checkNote.id);
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1"]);
  });

  // protects=a take-back whose write of the version before fails after the file is in place, the file then holding another app's bytes, puts nothing back over them and keeps the copies, and the next start leaves the file as it is and says why (#3751); fails_when=the take-back stands the refused version again over bytes it doesn't hold, or the next start writes over them
  it("puts nothing back over another app's bytes when a take-back's write fails after the file is in place, and the next start leaves them", async () => {
    const waiting = await secondVersionWaiting();
    const { core, dataDir, document, first, asked, restart, log } = waiting;
    const folder = join(dataDir, "Handed files", first.fileId);
    const before = new Uint8Array(readFileSync(join(folder, "v1", "Harbour review.pptx")));
    const theirs = plainDeck([{ title: "Harbour review" }, { lines: [NORTH, NEVER_CLOSES] }]);
    failsOnceInPlace(document.path, () => writeFile(document.path, theirs));
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    expect(
      (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
    expect((await core.listMinds()).map((each) => each.id)).not.toContain(waiting.checkNote.id);
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
    expect(log.lines.filter((line) => line.includes("handedFile.takeBack.unsure"))).toHaveLength(1);

    const reopened = await restart();
    await afterTheStart(reopened, waiting, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
    expect(notFinished(log.lines)).toEqual([expect.stringContaining('"why":"file-changed"')]);
    reopened.close();
  });

  // protects=a hand-over that writes its version into the item's Document while that Document holds bytes no version has keeps a copy of them first, and its refusal writes them back: the User's file holds what it held, the item is on its version before, and the copy goes with the refused version's (#3751); fails_when=the take-back leaves the refused version in the file, or writes back a version the file didn't hold
  it("writes back the bytes no version had when a hand-over written over them is refused", async () => {
    const waiting = await outsideBytesWaiting();
    const { core, dataDir, document, first, theirs, asked } = waiting;
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    const now = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(hashBytes(theirs));
    expect(
      (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
    expect(readdirSync(join(dataDir, "Handed files", first.fileId)).sort()).toEqual([
      "file-1.pptx",
      "v1",
    ]);
    core.close();
  });

  // protects=a take-back a quit cut short after its records, of a version written over bytes no version had, writes those bytes back at the next start, never the version before's (#3751); fails_when=the start writes the version before over the refused bytes, and what the file held is lost
  it("writes back at the next start the bytes no version had, for a take-back a quit cut short", async () => {
    const waiting = await outsideBytesWaiting();
    const { core, document, theirs, before } = waiting;
    const folder = await refuseCutAfterRecords(waiting);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    await core.close();

    const reopened = await waiting.restart();
    await afterTheStart(reopened, waiting, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1"]);
    reopened.close();
  });

  // protects=the copy of bytes no version had that a first try kept, before its write failed, is made to hold what the file holds when the same file comes again, so a take-back writes back what the file held last (#3751); fails_when=the next start writes the first try's copy over the file
  it("writes back what the file held at the last try, for a take-back a quit cut short of a hand-over tried twice", async () => {
    const outside = await outsideBytes();
    const { core, document, before } = outside;
    next.rename.set(document.path, async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, rename"), {
        code: "ENOSPC",
      });
    });
    expect((await outside.handOverWhole()).isError).toBe(true);
    // Another app puts the version before's bytes back into the file.
    await writeFile(document.path, before);
    const waiting = await outsideBytesWaiting(outside);
    await refuseCutAfterRecords(waiting);
    await core.close();

    const reopened = await outside.restart();
    await afterTheStart(reopened, waiting, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(before));
    reopened.close();
  });

  // protects=a hand-over that can't keep a copy of bytes no version has writes nothing over them and fails as a failed write does; the same file handed over again keeps the copy and goes on (#3751); fails_when=the version is written over bytes nothing kept
  it("writes nothing over bytes no version had when their copy can't be kept, and goes on when the same file comes again", async () => {
    const outside = await outsideBytes();
    const { core, dataDir, document, first, theirs } = outside;
    outside.held.open();
    const copy = join(dataDir, "Handed files", first.fileId, "v2", "before", "file.pptx");
    next.rename.set(copy, async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, rename"), {
        code: "ENOSPC",
      });
    });
    expect((await outside.handOverWhole()).isError).toBe(true);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    expect((await core.listDocuments()).find((each) => each.id === document.id)?.contentHash).toBe(
      hashBytes(theirs),
    );

    const again = structured<Handed>(await outside.handOverWhole());
    expect(again).toMatchObject({ fileId: first.fileId, version: 2, status: "checked" });
    expect(hashBytes(new Uint8Array(readFileSync(copy)))).toBe(hashBytes(theirs));
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    core.close();
  });

  // protects=a hand-over into the item's Document whose file is gone, while the Library last read bytes no version has, writes nothing, so a refusal never writes a version where the User had other words (#3751); fails_when=the hand-over takes the version before as what the file held, and its refusal would write it back
  it("writes nothing into a Document whose file is gone while the Library holds bytes no version had", async () => {
    const outside = await outsideBytes();
    const { core, document, theirs } = outside;
    outside.held.open();
    await rm(document.path);
    expect((await outside.handOverWhole()).isError).toBe(true);
    expect(existsSync(document.path)).toBe(false);
    expect((await core.listDocuments()).find((each) => each.id === document.id)?.contentHash).toBe(
      hashBytes(theirs),
    );
    core.close();
  });

  // protects=a hand-over refused after the User changed the note of a highlight on its Document while the check ran keeps the Document, both versions and the check Note: a highlight's note and colour are the User's, not only that it is there (#3751); fails_when=the take-back compares the highlights' ids alone and writes the version before back under the User's note
  it("keeps a Document whose highlight's note the User changed while a refused hand-over's check ran", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
    structured<Handed>(await waiting.handOver());
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    const highlight = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: 2, text: NORTH }],
      colour: "yellow",
    });
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    await core.updateAnnotation(highlight.id, { note: "Count the boats again in spring." });
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, hashBytes(DECK), 2);
    expect((await core.listAnnotations(document.id)).map((each) => [each.id, each.note])).toEqual([
      [highlight.id, "Count the boats again in spring."],
    ]);
  });

  // protects=a hand-over refused after the User kept a sentence of its check Note as their own view while the check ran keeps the Note, its version and its Document: a keep is the User's choice, though it sits with the check's results (#3751); fails_when=the take-back leaves out everything stored with a check, the keep too, and deletes the Note
  it("keeps a check Note in which the User kept a sentence as their own view while a refused hand-over's check ran", async () => {
    const waiting = await secondVersionWaiting();
    const { core, checkNote, document, asked } = waiting;
    const client = await connectToMind(core, checkNote.id);
    await client.settled();
    await vi.waitFor(() =>
      expect(
        claimSpans(readMind(client)).find((span) => span.sentence.text === SOUTH)?.check.state,
      ).toBe("contradicted"),
    );
    client.doc.transact(() => keepAsOwnView(client.blocks, SOUTH));
    await client.settled();
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, hashBytes(DECK), 2);
    expect((await core.listMinds()).map((each) => each.id)).toContain(checkNote.id);
  });

  // protects=a take-back a quit cut short after its records, its Document renamed by the User before the next start, is finished at that start with the User's name kept (#3751); fails_when=the start names the Document by the item's title over the User's name
  it("keeps a name the User gave the Document after a take-back a quit cut short", async () => {
    const cut = await cutAfterRecords();
    const { core, document, before, restart } = cut;
    await core.renameDocument(document.id, "Quay deck, final");

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    const now = (await reopened.listDocuments()).find((each) => each.id === document.id);
    expect(now?.name).toBe("Quay deck, final");
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(before));
    reopened.close();
  });

  // protects=a take-back a quit cut short after its records, its Document still holding the refused version, is finished at the next start: the version before written back into the Document and read, and only then the refused version's copy removed; the agent's refusal stands as it was (#3751); fails_when=the start leaves the Document holding a version its item no longer has
  it("finishes at the next start a take-back a quit cut short after its records", async () => {
    const cut = await cutAfterRecords();
    const { document, first, folder, before, restart } = cut;

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(before));
    const now = (await reopened.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(hashBytes(before));
    expect(
      (await reopened.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
    ).toEqual([1]);
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1"]);
    reopened.close();
  });

  // protects=a take-back a quit cut short is left as it is at the next start once its Document's file changed since: nothing is written, the file keeps the new bytes, and both versions' copies stay (#3751); fails_when=the start writes the version before over bytes another app saved, or removes the copy of the version the take-back hadn't finished
  it("leaves a take-back a quit cut short as it is when the file changed before the next start", async () => {
    const cut = await cutAfterRecords();
    const { document, folder, before, restart, log } = cut;
    const theirs = plainDeck([{ title: "Harbour review" }, { lines: [NORTH, NEVER_CLOSES] }]);
    await writeFile(document.path, theirs);

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(theirs));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
    expect(hashBytes(new Uint8Array(readFileSync(join(folder, "v1", "Harbour review.pptx"))))).toBe(
      hashBytes(before),
    );
    expect(notFinished(log.lines)).toEqual([expect.stringContaining('"why":"file-changed"')]);
    reopened.close();
  });

  // protects=a take-back a quit cut short whose version before's copy is gone is left as it is at the next start, and one log line says why (#3751); fails_when=the start says nothing of it, writes something, or removes the refused version's copy
  it("leaves a take-back a quit cut short as it is when the version before's copy is gone, and says so once", async () => {
    const cut = await cutAfterRecords();
    const { document, folder, before, restart, log } = cut;
    await rm(join(folder, "v1"), { recursive: true });

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v2"]);
    expect(notFinished(log.lines)).toEqual([expect.stringContaining('"why":"copy-missing"')]);
    reopened.close();
  });

  // protects=a take-back a quit cut short whose version before's copy no longer holds that version's bytes is left as it is at the next start: those bytes are never written into the Document (#3751); fails_when=the start writes whatever the copy holds into the User's file
  it("leaves a take-back a quit cut short as it is when the version before's copy holds other bytes", async () => {
    const cut = await cutAfterRecords();
    const { document, folder, before, restart, log } = cut;
    await writeFile(
      join(folder, "v1", "Harbour review.pptx"),
      plainDeck([{ title: "Harbour review" }, { lines: [SOUTH] }]),
    );

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
    expect(notFinished(log.lines)).toEqual([expect.stringContaining('"why":"copy-changed"')]);
    reopened.close();
  });

  // protects=a take-back a quit cut short whose Document's file can't be read at the next start is left as it is, and its log line carries the error, so a permissions fault reads apart from a missing file (#3751); fails_when=the start takes a file it couldn't read as one it may finish, or logs no cause
  it("leaves a take-back a quit cut short as it is when its Document's file can't be read, and says why", async () => {
    const cut = await cutAfterRecords();
    const { document, folder, before, restart, log } = cut;
    await chmod(document.path, 0o000);
    try {
      const reopened = await restart();
      await afterTheStart(reopened, cut, before, 1);
      reopened.close();
    } finally {
      await chmod(document.path, 0o644);
    }
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
    expect(notFinished(log.lines)).toEqual([
      expect.stringMatching(/"why":"file-unreadable","message":"EACCES/),
    ]);
  });

  // protects=a take-back a quit cut short after the version before was written back, before it was read, is only read at the next start: the Document's text and the item agree on the version before, nothing is written, and the refused version's copy goes (#3751); fails_when=the start gives the take-back up because the file no longer holds the refused bytes, keeping that copy, or writes the file again
  it("only reads again at the next start a take-back a quit cut short after its write", async () => {
    const cut = await cutAfterRecords();
    const { core, document, first, folder, before, restart } = cut;
    core.close();
    await writeFile(document.path, before);
    written.length = 0;

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    expect(written.filter((path) => path === document.path)).toEqual([]);
    const now = (await reopened.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(hashBytes(before));
    const text = await reopened.readDocumentText(document.id);
    expect(text.contentHash).toBe(hashBytes(before));
    const words = text.pages.map((each) => each.text).join("\n");
    expect(words).toContain(NORTH);
    expect(words).not.toContain(SOUTH);
    const item = await reopened.handedFileOf(first.mindId ?? "");
    expect(item?.versions.map((each) => [each.number, each.contentHash])).toEqual([
      [1, hashBytes(before)],
    ]);
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1"]);
    reopened.close();
  });

  // protects=a core closed while its start finishes a take-back a quit cut short writes nothing after the close, and its start's clean-up removes no copy (#3751); fails_when=the start writes the version before into the User's file once the core has closed, or the clean-up runs
  it("closed as it starts, writes no take-back a quit cut short and keeps its copies", async () => {
    const cut = await cutAfterRecords();
    const { document, folder, restart, log } = cut;
    const logged = log.lines.length;
    written.length = 0;

    (await restart()).close();
    await vi.waitFor(() =>
      expect(notFinished(log.lines.slice(logged))).toEqual([
        expect.stringContaining('"why":"closed"'),
      ]),
    );
    for (let hop = 0; hop < 100; hop++) await stat(folder);
    expect(written.filter((path) => path === document.path)).toEqual([]);
    expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
  });

  // protects=a core closed while its start would read again a take-back a quit cut short after its write reads nothing closed and logs no failure, and the next start reads it (#3751); fails_when=the start reads the closed Library, logs that as a failure and says the take-back finished
  it("closed as it starts, reads nothing closed for a take-back a quit cut short after its write", async () => {
    const cut = await cutAfterRecords();
    const { core, document, folder, before, restart, log } = cut;
    core.close();
    await writeFile(document.path, before);
    const logged = log.lines.length;

    (await restart()).close();
    await vi.waitFor(() =>
      expect(notFinished(log.lines.slice(logged))).toEqual([
        expect.stringContaining('"why":"closed"'),
      ]),
    );
    for (let hop = 0; hop < 100; hop++) await stat(folder);
    expect(log.lines.slice(logged).filter((line) => line.includes("handedFile.takeBack."))).toEqual(
      notFinished(log.lines.slice(logged)),
    );
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);

    const reopened = await restart();
    await afterTheStart(reopened, cut, before, 1);
    const now = (await reopened.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(hashBytes(before));
    expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1"]);
    reopened.close();
  });

  // protects=a start with no take-back cut short reads no file of an item whose Document holds its newest version, and changes nothing (#3751); fails_when=each start hashes every handed file's Document or copies
  it("starts with no take-back cut short reading no handed file and changing nothing", async () => {
    const waiting = await secondVersionWaiting();
    const { dataDir, document, first, asked, restart, log } = waiting;
    waiting.held.open();
    expect(structured<Handed>(await asked)).toMatchObject({ fileId: first.fileId, version: 2 });
    const folder = join(dataDir, "Handed files", first.fileId);
    const listed = readdirSync(folder).sort();
    const logged = log.lines.length;
    opened.length = 0;

    const reopened = await restart();
    await afterTheStart(reopened, waiting, DECK, 2);
    expect(opened.filter((path) => path.startsWith(folder))).toEqual([]);
    expect(readdirSync(folder).sort()).toEqual(listed);
    const now = (await reopened.listDocuments()).find((each) => each.id === document.id);
    expect(now?.contentHash).toBe(hashBytes(DECK));
    expect(log.lines.slice(logged).filter((line) => line.includes("handedFile.takeBack"))).toEqual(
      [],
    );
    reopened.close();
  });

  // protects=a hand-over refused after the User tagged its Document while the check ran keeps the Document with the Tag, its version and its check Note, and nothing is deleted for good (#3751); fails_when=the take-back deletes the tagged Document because its bytes, name and Folder are as the call left them
  it("keeps a Document the User tagged while a refused hand-over's check ran", async () => {
    const waiting = await waitingHandOver();
    const { core, path } = waiting;
    await writeFile(path, DECK);
    const asked = waiting.handOver();
    await waiting.held.at;
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The deck isn't in the Library.");
    const tag = await core.createTag({ name: "Quay works" });
    await core.addDocumentTag(document.id, tag.id);
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, document.contentHash, 1);
    const kept = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(kept?.tags.map((each) => each.tagId)).toEqual([tag.id]);
  });

  // protects=a hand-over refused after the User moved a value into an empty cell of its check Note's table keeps the Note as the User left it, though its words read in the same order (#3751); fails_when=the take-back compares only the Note's words, which skip empty cells, and deletes the Note
  it("keeps a check Note whose table the User changed while a refused hand-over's check ran", async () => {
    const waiting = await waitingHandOver({ name: "Harbour review.docx" });
    const { core, path } = waiting;
    await writeFile(
      path,
      wordFile({ body: [paragraph(OFFICE), table([["North quay", "42", ""]])].join("") }),
    );
    const asked = waiting.handOver();
    await waiting.held.at;
    const checkNote = (await core.listMinds()).find(
      (each) => each.title === en("verify.mindTitle", { name: "Harbour review" }),
    );
    if (!checkNote) throw new Error("The check Note wasn't made.");
    const client = await connectToMind(core, checkNote.id);
    await client.settled();
    // The boats moved one cell along, as the User retypes them there.
    const [, from, to] = cellsOf(client.blocks).map((cell) => cell.firstChild);
    const boats = from instanceof Y.XmlElement ? from.firstChild : null;
    if (!(boats instanceof Y.XmlText) || !(to instanceof Y.XmlElement))
      throw new Error("The check Note has no row of three cells with the boats in the second.");
    const empty = to.firstChild;
    client.doc.transact(() => {
      boats.delete(0, boats.length);
      if (empty instanceof Y.XmlText) empty.insert(0, "42");
      else to.insert(0, [new Y.XmlText("42")]);
    });
    await client.settled();
    expect(cellsOf(client.blocks).map(cellText)).toEqual(["North quay", "", "42"]);
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
    if (!document) throw new Error("The Word file isn't in the Library.");
    await waiting.refuse();
    expect(refusal(await asked)).toBe(en("agents.handOver.notFound"));
    await waiting.keptAll(document.id, document.contentHash, 1);
    const reopened = await connectToMind(core, checkNote.id);
    await reopened.settled();
    expect(cellsOf(reopened.blocks).map(cellText)).toEqual(["North quay", "", "42"]);
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

/**
 * "Harbour review" handed over into Coast and held while its check checks the office's line
 * (`held`), in a Linked folder or not; `refuse` takes Coast from the agent and lets the check end;
 * `keptAll` says nothing of it was taken back: the Document holds `contentHash`, the item has its
 * versions up to `versions` with a check Note, and nothing went to Recently deleted.
 */
async function waitingHandOver({ linked = false, name = "Harbour review.pptx" } = {}) {
  const held = gate();
  let holding = true;
  const plans: Record<string, Plan> = {
    ...PLANS,
    [OFFICE]: {
      ...PLANS[OFFICE],
      reply: (call: ModelCall) => {
        const reply = checkReply(call, PLANS);
        if (!holding) return reply;
        holding = false;
        return { ...reply, pause: { after: 0, until: held.shut, reached: held.reached } };
      },
    },
  };
  const set = await started([], { plans, folders: ["Other"] });
  const { core, coast, writer, files, more } = set;
  if (linked) {
    await linkWithoutFolder(core, files);
    await core.updateAgent(writer.pairing.id, { folderIds: [coast.id, NOT_IN_A_FOLDER_ID] });
  }
  const agent = await connectLegacyAgent(writer.launch);
  const path = join(files, name);
  return {
    ...set,
    path,
    held,
    handOver: () => handOver(agent, { path, folderId: coast.id }),
    refuse: async () => {
      await core.updateAgent(writer.pairing.id, { folderIds: more.map((each) => each.id) });
      held.open();
    },
    keptAll: async (documentId: string, contentHash: string | null, versions: number) => {
      const document = (await core.listDocuments()).find((each) => each.id === documentId);
      expect(document?.contentHash).toBe(contentHash);
      const checks = (await core.listMinds()).filter((each) =>
        each.title.endsWith(": Harbour review"),
      );
      expect(checks.length).toBeGreaterThan(0);
      const item = await core.handedFileOf(checks[0]?.id ?? "");
      expect(item?.versions.map((each) => each.number)).toEqual(
        Array.from({ length: versions }, (_, at) => at + 1),
      );
      expect(await core.listDeleted()).toEqual([]);
    },
  };
}

/**
 * `waitingHandOver`'s deck handed over once with the north quay alone, then whole and held in its
 * check: the first version, the Library's Document as the second left it, the second version's
 * check Note, and the call.
 */
async function secondVersionWaiting() {
  const waiting = await waitingHandOver();
  const { core, path } = waiting;
  await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]));
  const first = structured<Handed>(await waiting.handOver());
  await writeFile(path, DECK);
  const asked = waiting.handOver();
  await waiting.held.at;
  const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
  const checkNote = (await core.listMinds()).find(
    (each) =>
      each.id !== first.mindId && each.title === en("verify.mindTitle", { name: "Harbour review" }),
  );
  if (!document || !checkNote) throw new Error("The second version wasn't made.");
  return { ...waiting, first, asked, document, checkNote };
}

/**
 * `secondVersionWaiting`'s call refused, its take-back stopped after the records as a quit there
 * leaves it: the item back on its first version, its Document still holding the second's bytes,
 * both versions' copies in its `folder`, and the first version's bytes (`before`).
 */
async function cutAfterRecords() {
  const waiting = await secondVersionWaiting();
  const { core, dataDir, document, first } = waiting;
  const before = new Uint8Array(
    readFileSync(join(dataDir, "Handed files", first.fileId, "v1", "Harbour review.pptx")),
  );
  const folder = await refuseCutAfterRecords(waiting);
  expect(
    (await core.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
  ).toEqual([1]);
  expect(hashBytes(new Uint8Array(readFileSync(document.path)))).toBe(hashBytes(DECK));
  expect(readdirSync(folder).sort()).toEqual(["file-1.pptx", "v1", "v2"]);
  return { ...waiting, folder, before };
}

/**
 * Refuses the held call with its take-back stopped after the records, as a quit there leaves it:
 * the write back fails, and so does standing the version again. Returns the item's folder.
 */
async function refuseCutAfterRecords(waiting: {
  dataDir: string;
  first: Handed;
  asked: Promise<unknown>;
  refuse(): Promise<void>;
}): Promise<string> {
  const folder = join(waiting.dataDir, "Handed files", waiting.first.fileId);
  const mend = refuseChangesOf(
    waiting.dataDir,
    "agent_file_versions",
    "deleted_at",
    "NEW.deleted_at IS NULL",
  );
  await chmod(folder, 0o555);
  try {
    await waiting.refuse();
    expect(refusal(await waiting.asked)).toBe(en("agents.handOver.notFound"));
  } finally {
    await chmod(folder, 0o755);
    mend();
  }
  return folder;
}

/**
 * Waits out the start of the core opened again: a hand-over of the item's newest version's bytes,
 * which only finds that version, comes after the start in the hand-overs' turn.
 */
async function afterTheStart(
  reopened: Core,
  waiting: Pick<
    Awaited<ReturnType<typeof secondVersionWaiting>>,
    "writer" | "coast" | "path" | "first"
  >,
  bytes: Uint8Array,
  version: number,
) {
  await reopened.setAgentsEnabled(true);
  await reopened.updateAgent(waiting.writer.pairing.id, { folderIds: [waiting.coast.id] });
  await writeFile(waiting.path, bytes);
  const again = await handOver(await connectLegacyAgent(waiting.writer.launch), {
    path: waiting.path,
  });
  expect(structured<Handed>(again)).toMatchObject({ fileId: waiting.first.fileId, version });
}

/** The log's lines that say a start left a take-back a quit cut short as it was. */
const notFinished = (lines: readonly string[]) =>
  lines.filter((line) => line.includes("handedFile.takeBack.notFinished"));

/**
 * `waitingHandOver`'s deck handed over with the north quay alone; another app then saves the
 * Document's file while IncarnaMind is closed (`theirs`, bytes no version has), and the core opened
 * again reads it. `handOverWhole` hands the whole deck over to that core.
 */
async function outsideBytes() {
  const waiting = await waitingHandOver();
  const { core, path, restart, writer, coast } = waiting;
  const before = plainDeck([{ title: "Harbour review" }, { lines: [NORTH] }]);
  await writeFile(path, before);
  const first = structured<Handed>(await waiting.handOver());
  const document = (await core.listDocuments()).find((each) => each.name === "Harbour review");
  if (!document) throw new Error("The deck isn't in the Library.");
  const theirs = plainDeck([{ title: "Harbour review" }, { lines: [NORTH, NEVER_CLOSES] }]);
  await core.close();
  await writeFile(document.path, theirs);
  const reopened = await restart();
  await waitForDocuments(reopened, (all) =>
    expect(all.find((each) => each.id === document.id)?.contentHash).toBe(hashBytes(theirs)),
  );
  expect(
    (await reopened.handedFileOf(first.mindId ?? ""))?.versions.map((each) => each.number),
  ).toEqual([1]);
  await reopened.setAgentsEnabled(true);
  await reopened.updateAgent(writer.pairing.id, { folderIds: [coast.id] });
  const agent = await connectLegacyAgent(writer.launch);
  return {
    ...waiting,
    core: reopened,
    first,
    document,
    before,
    theirs,
    handOverWhole: async () => {
      await writeFile(path, DECK);
      return handOver(agent, { path });
    },
  };
}

/** `outsideBytes` with the whole deck handed over and held in its check, and `refuse` for that core. */
async function outsideBytesWaiting(given?: Awaited<ReturnType<typeof outsideBytes>>) {
  const outside = given ?? (await outsideBytes());
  const { core, writer, more, held } = outside;
  const asked = outside.handOverWhole();
  await held.at;
  return {
    ...outside,
    asked,
    refuse: async () => {
      await core.updateAgent(writer.pairing.id, { folderIds: more.map((each) => each.id) });
      held.open();
    },
  };
}

/** Holds the next step of `path` in `steps` at a gate, as a slow disk would. */
function holdNext(steps: Map<string, () => Promise<void>>, path: string) {
  const held = gate();
  steps.set(path, async () => {
    held.reached();
    await held.shut;
  });
  return held;
}

/**
 * The next write of a file into `path` fails once the file is in place, as the look at it that
 * follows can; `meanwhile`: what another app does to the file first.
 */
function failsOnceInPlace(path: string, meanwhile: () => Promise<void> = async () => {}) {
  next.renamed.set(path, async () => {
    await meanwhile();
    next.stat.set(path, async () => {
      throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" });
    });
  });
}

/** Types a paragraph at the end of a Note, as the editor writes one. */
async function typeAtEnd(core: Core, mindId: string, words: string) {
  const client = await connectToMind(core, mindId);
  await client.settled();
  client.doc.transact(() => {
    const mine = new Y.XmlElement("paragraph");
    mine.insert(0, [new Y.XmlText(words)]);
    client.blocks.push([mine]);
  });
  await client.settled();
}

/** Keeps the checked sentence that holds `words` as the User's own view, as the editor writes a keep (#1111). */
function keepAsOwnView(blocks: Y.XmlFragment, words: string): void {
  for (const text of textsOf(blocks)) {
    const runs = text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
    const holding = runs.find(
      (run) => typeof run.insert === "string" && run.insert.includes(words),
    );
    const key = countingCheckOf(holding?.attributes)?.key;
    if (!key) continue;
    let offset = 0;
    for (const run of runs) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      const check = readClaimCheck(run.attributes?.[key]);
      if (check) text.format(offset, length, { [key]: keepCheckAsView(check) });
      offset += length;
    }
    return;
  }
  throw new Error(`No checked sentence holds "${words}".`);
}

function* textsOf(parent: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlText> {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) yield child;
    else if (child instanceof Y.XmlElement) yield* textsOf(child);
  }
}

/** A Note's table cells, in order. */
function cellsOf(parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  return parent
    .toArray()
    .flatMap((child) =>
      child instanceof Y.XmlElement
        ? child.nodeName === "tableCell" || child.nodeName === "tableHeader"
          ? [child]
          : cellsOf(child)
        : [],
    );
}

/** The words in a part of a Note, without its marks. */
function cellText(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[])
      .map((run) => (typeof run.insert === "string" ? run.insert : ""))
      .join("");
  }
  return node
    .toArray()
    .map((child) =>
      child instanceof Y.XmlElement || child instanceof Y.XmlText ? cellText(child) : "",
    )
    .join("");
}
