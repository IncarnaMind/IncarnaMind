/**
 * A sentence an agent writes from a file outside the Library is checked against that file (#3509):
 * the agent cites the file by its path with the words it quotes, IncarnaMind reads the file itself
 * and keeps it as a Document in no Folder and no source, and the Citation and the check work as
 * for a Passage. The agent learns nothing of the file through IncarnaMind but whether its quote is
 * there. Through the shim the app ships, as Claude Code calls it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hiddenOrSystem } from "../../src/core/agents/citedFiles";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createSourceFolder } from "../helpers/documents";
import { PLANS, refusal, started, structured } from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";

const LINE = "The east quay holds 31 boats.";
const RIGHT = "The east quay holds 31 boats.";
const WRONG = "The east quay holds 35 boats.";
const plans = {
  ...PLANS,
  [RIGHT]: {
    verdict: "supported" as const,
    quote: "The east quay holds 31 boats",
    says: "Quay notes say the east quay holds 31 boats.",
  },
  [WRONG]: {
    verdict: "contradicted" as const,
    quote: "The east quay holds 31 boats",
    says: "Quay notes say the east quay holds 31 boats, not 35.",
  },
};
const HIDDEN = translate("en", "agents.cite.fileHidden");
const KIND = translate("en", "agents.cite.fileKind");

interface Cited {
  citations: {
    passageId: string | null;
    check: string;
    cite: string | null;
    document: string | null;
    text: string | null;
  }[];
}

/** The Coast Library, Claude Code connected, and a file of notes in a folder IncarnaMind doesn't hold. */
async function outside(options: Omit<NonNullable<Parameters<typeof started>[1]>, "plans"> = {}) {
  const set = await started([], { plans, ...options });
  const agent = await connectLegacyAgent(set.writer.launch);
  const folder = await createSourceFolder();
  const path = join(folder, "Quay notes.md");
  await writeFile(path, `# Quay notes\n\n${LINE}\n\nThe slipway closes at dusk.\n`);
  const cite = async (quote: string, at = path) =>
    structured<Cited>(
      await agent.callTool({ name: "cite", arguments: { citations: [{ path: at, quote }] } }),
    ).citations[0];
  return { ...set, agent, folder, path, cite };
}

describe("a file outside the Library, cited by its path (#3509)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a quote that is in the file gets a Citation, and the sentence citing it is checked against the file, not marked "not found"; the file is a Document in no Folder that no search reaches, named in the Library with the agent that cited it (#3509); fails_when=the check finds nothing, or the file joins a Folder or a search
  it("checks a sentence against the file it cites, which no search reaches", async () => {
    const { core, coast, agent, cite } = await outside();
    const cited = await cite("The east quay holds 31 boats");
    expect(cited).toMatchObject({ check: "found", document: "Quay notes", text: null });
    expect(cited?.cite).toMatch(/^\[cite:/);

    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Quays", markdown: `${RIGHT} ${cited?.cite}`, folderId: coast.id },
      }),
    );
    expect(
      structured<{ status: string; supported: number }>(
        await agent.callTool({ name: "check_mind", arguments: { mindId } }),
      ),
    ).toMatchObject({ status: "checked", supported: 1 });

    const notes = (await core.listDocuments()).find((each) => each.name === "Quay notes");
    expect(notes).toMatchObject({ citedBy: "Claude Code" });
    const filed = (await core.getLibrary()).assignments.find(
      (each) => each.documentId === notes?.id,
    );
    expect(filed?.groupId ?? null).toBeNull();
    const evidence = await core.searchEvidence("east quay boats");
    expect(evidence.passages.some((passage) => passage.documentId === notes?.id)).toBe(false);
    const searched = JSON.stringify(
      structured(await agent.callTool({ name: "search", arguments: { query: "east quay boats" } })),
    );
    expect(searched).not.toContain("Quay notes");
    const read = await agent.callTool({
      name: "read_passages",
      arguments: { passageId: cited?.passageId },
    });
    expect((read as { isError?: boolean }).isError).toBe(true);
  });

  // protects=a figure the file doesn't state is Contradicted by the file it cites (#3509); fails_when=a changed figure is marked supported or not found
  it("finds a changed figure Contradicted by the file", async () => {
    const { coast, agent, cite } = await outside();
    const cited = await cite("The east quay holds 31 boats");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Quays", markdown: `${WRONG} ${cited?.cite}`, folderId: coast.id },
      }),
    );
    const checked = structured<{ status: string; needLook: number; supported: number }>(
      await agent.callTool({ name: "check_mind", arguments: { mindId } }),
    );
    expect(checked).toMatchObject({ status: "checked", supported: 0, needLook: 1 });
  });

  // protects=a quote that isn't in the file gets no Citation and none of the file's text: the agent learns nothing of the file through IncarnaMind but whether its quote is there (#3509); fails_when=a Citation is given for words the file doesn't hold, or the file's text is given back
  it("refuses a quote that isn't in the file, giving none of its text", async () => {
    const { cite } = await outside();
    expect(await cite("The west quay holds 99 boats")).toMatchObject({
      check: "not-found",
      cite: null,
      passageId: null,
      text: null,
    });
  });

  // protects=a quote word for word inside a longer sentence of the file is found, a Chinese one too, which shares no word with its sentence (#3509 review); fails_when=a Passage that shares no word with the quote is never looked in
  it("finds a quote inside a longer sentence, in Chinese as in English", async () => {
    const { folder, cite } = await outside();
    const minutes = join(folder, "董事会纪要.md");
    await writeFile(
      minutes,
      "# 董事会纪要\n\n董事会认为本年度经营业绩表现良好且增长稳定。\n\nThe slipway closes at dusk on weekdays.\n",
    );
    expect(await cite("本年度经营业绩表现良好", minutes)).toMatchObject({ check: "found" });
    expect(await cite("slipway closes at dusk", minutes)).toMatchObject({ check: "found" });
  });

  // protects=a cite call that reads a file by path judges every Passage it holds by what the agent reaches once the file is read: a Folder taken back meanwhile gives none of its text, whether its Passage came before the file or after (#3509 review, #3458); fails_when=the call gives back a Passage's text under the grant it had before the read
  it.each([
    ["after", "the file"],
    ["before", "the file"],
  ])(
    "gives nothing of a Folder taken back while the file is read, for a Passage %s %s",
    async (order) => {
      let meanwhile = async () => {};
      const { core, writer, more, agent, path } = await outside({
        folders: ["Other"],
        reading: () => meanwhile(),
      });
      const { passages } = structured<{ passages: { passageId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "harbour office open" } }),
      );
      const passageId = passages[0]?.passageId;
      expect(passageId).toBeDefined();
      meanwhile = async () => {
        await core.updateAgent(writer.pairing.id, { folderIds: more.map((each) => each.id) });
      };
      const file = { path, quote: "The east quay holds 31 boats" };
      const passage = { passageId, quote: "The harbour office closes at noon" };
      const asked = await agent.callTool({
        name: "cite",
        arguments: { citations: order === "after" ? [file, passage] : [passage, file] },
      });
      expect((asked as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(asked)).not.toContain("open every day");
    },
  );

  // protects=a Document a check leaves out stays out when an agent cites it by path: an export IncarnaMind wrote supports nothing it cites (#3509 review); fails_when=a file IncarnaMind wrote, cited by path, is a check's evidence
  it("leaves out a file IncarnaMind wrote, cited by its path, as every check does", async () => {
    const { core, coast, agent, folder, cite } = await outside();
    await core.setOutputLocation(folder);
    const quays = await core.createMind({ title: "Quays" });
    writeMind(await connectToMind(core, quays.id), [note(LINE)]);
    const saved = await core.saveMindExport(quays.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`The export wasn't saved: ${saved.status}.`);

    const cited = await cite("The east quay holds 31 boats", saved.file.path);
    expect(cited).toMatchObject({ check: "found" });
    const exported = (await core.listDocuments()).find((each) => each.citedBy !== null);
    expect(exported?.ownFile).toMatchObject({ kind: "export" });
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Quay summary",
          markdown: `${RIGHT} ${cited?.cite}`,
          folderId: coast.id,
        },
      }),
    );
    expect(
      structured<{ supported: number }>(
        await agent.callTool({ name: "check_mind", arguments: { mindId } }),
      ),
    ).toMatchObject({ supported: 0 });
  });

  // protects=a file cited by path is evidence only for the sentence that cites it: the agent's own verdict on another sentence that rests on it isn't taken (#3509 review); fails_when=report_check marks a sentence supported by a file the sentence doesn't cite
  it("takes a verdict resting on the file only for the sentence that cites it", async () => {
    const { coast, agent, cite } = await outside();
    const cited = await cite("The east quay holds 31 boats");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Quays",
          markdown: `${RIGHT} ${cited?.cite}\n\nThe slipway closes at dusk.`,
          folderId: coast.id,
        },
      }),
    );
    const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
    );
    const numbered = (start: string) =>
      given.sentences.find((each) => each.text.startsWith(start))?.n;
    const results = ["The east quay", "The slipway"].map((start) => ({
      n: numbered(start),
      verdict: "supported",
      cites: [cited?.cite],
      explanation: "Quay notes say so.",
    }));
    expect(
      structured<{ unconfirmed: number[] }>(
        await agent.callTool({
          name: "report_check",
          arguments: { mindId, task: given.task, results },
        }),
      ),
    ).toMatchObject({ unconfirmed: [numbered("The slipway")] });
  });

  // protects=a hidden file, a file in a hidden folder, and a file of a kind IncarnaMind doesn't read are refused in plain words, and nothing of them is kept (#3509); fails_when=IncarnaMind reads such a file
  it("refuses a hidden file and a file of another kind, in plain words", async () => {
    const { core, folder, agent } = await outside();
    const hidden = join(folder, ".private notes.md");
    await writeFile(hidden, `${LINE}\n`);
    await mkdir(join(folder, ".cache"));
    const inHidden = join(folder, ".cache", "notes.md");
    await writeFile(inHidden, `${LINE}\n`);
    const archive = join(folder, "notes.zip");
    await writeFile(archive, LINE);
    const tried = async (path: string) =>
      refusal(
        await agent.callTool({ name: "cite", arguments: { citations: [{ path, quote: LINE }] } }),
      );
    expect(await tried(hidden)).toBe(HIDDEN);
    expect(await tried(inHidden)).toBe(HIDDEN);
    expect(await tried(archive)).toBe(KIND);
    expect((await core.listDocuments()).some((each) => each.citedBy !== null)).toBe(false);
  });

  // protects=a file in iCloud Drive or a cloud drive macOS keeps in the Library folder may be cited, and the Library folder's app data may not (#3509); fails_when=a User's file in a cloud drive is refused as a system file
  it("takes a file in a cloud drive, but not an app's own files", () => {
    expect(hiddenOrSystem("/Users/ana/Library/CloudStorage/Dropbox/Pier notes.md")).toBe(false);
    expect(
      hiddenOrSystem("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Pier notes.md"),
    ).toBe(false);
    expect(hiddenOrSystem("/Users/ana/Library/Application Support/Notes/notes.md")).toBe(true);
    expect(hiddenOrSystem("C:\\Users\\ana\\AppData\\Roaming\\notes.md")).toBe(true);
  });

  // protects=the file changing on disk shows on its Citation: check_citations says it changed (#3509); fails_when=a Citation of a file changed since reads as standing
  it("says the Citation changed once the file changes on disk", async () => {
    const { core, agent, path, cite } = await outside();
    const cited = await cite("The east quay holds 31 boats");
    await writeFile(path, "# Quay notes\n\nThe east quay holds 35 boats.\n");
    await core.reconcileDocuments();
    // The new version is the Document's once it is read.
    const changed = async () =>
      structured<{ citations: { changed: boolean }[] }>(
        await agent.callTool({
          name: "check_citations",
          arguments: { text: `${RIGHT} ${cited?.cite}` },
        }),
      ).citations[0]?.changed;
    await expect.poll(changed, { timeout: 15_000 }).toBe(true);
  });

  // protects=the User adding the file themselves makes it one of their own Documents, a source like any (#3509); fails_when=a file the User added stays out of search
  it("is one of the User's own once they add it", async () => {
    const { core, path, cite } = await outside();
    await cite("The east quay holds 31 boats");
    await core.addDocuments([path]);
    const notes = (await core.listDocuments()).find((each) => each.name === "Quay notes");
    expect(notes?.citedBy).toBeNull();
    const evidence = await core.searchEvidence("east quay boats");
    expect(evidence.passages.some((passage) => passage.documentId === notes?.id)).toBe(true);
  });
});
