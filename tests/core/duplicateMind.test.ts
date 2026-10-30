import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CheckMindInput } from "../../src/core";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readFigures } from "../../src/shared/figures";
import { wordFileOf, wordImportProgressOf } from "../../src/shared/wordFiles";
import { checkGenerate, type Plan, requestedFigures, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, waitForDocuments, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { paragraph, run, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

/** A Mind imported from a Word file, its import finished. */
async function importedMind() {
  const core = startCore(await createTempDataFolder());
  const folder = await createTempDataFolder();
  const path = join(folder, "Memo.docx");
  await writeFile(path, wordFile({ body: paragraph(run("Draft.")) }));
  const result = await core.importWordFile({ path, origin: "own" });
  if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
  const client = await connectToMind(core, result.mind.id);
  await new Promise<void>((resolve) => {
    const check = () => {
      if (wordFileOf(client.doc) && wordImportProgressOf(client.doc) === null) {
        client.doc.off("update", check);
        resolve();
      }
    };
    client.doc.on("update", check);
    check();
  });
  return { core, mind: result.mind, client };
}

describe("a Note duplicated from its menu", () => {
  test("keeps the Word file it came from, so it exports back and leaves that file out of its checks (#1935)", async () => {
    const { core, mind, client } = await importedMind();
    const copy = await core.duplicateMind(mind.id);
    const copyClient = await connectToMind(core, copy.id);

    expect(wordFileOf(copyClient.doc)).toEqual(wordFileOf(client.doc));
    expect(wordFileOf(copyClient.doc)).not.toBeNull();
  });

  test("keeps the Note's citation style, font and text size (#1935)", async () => {
    const { core, mind } = await importedMind();
    // A new Mind's own defaults are different, so the copy's first settings and the source's meet.
    await core.updateSettings({ user: { newMindStyle: { font: "mono", size: "small" } } });
    const folder = await core.createLibraryGroup({ name: "Memos", description: "" });
    await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });
    await core.setMindCitationStyle(mind.id, "apa", { folderDefault: "chicago-author-date" });
    await core.setMindStyle(mind.id, { font: "serif", size: "large" });
    const style = await core.getMindStyle(mind.id);
    const citation = await core.getMindCitationStyle(mind.id);

    for (let copy = 0; copy < 20; copy++) {
      const duplicated = await core.duplicateMind(mind.id);
      expect(await core.getMindStyle(duplicated.id)).toEqual(style);
      expect(await core.getMindCitationStyle(duplicated.id)).toEqual(citation);
    }
  });

  test("its checks don't take the Word file's draft as its own evidence (#1935)", async () => {
    const LOAN = "The Northgate Bank term loan stood at £214,480.00 at 31 March 2026.";
    const BANK = "Balance outstanding at 31 March 2026: GBP 212,480.00.";
    const MEMO = `Revenue for the year was £1,284,300. ${LOAN}`;
    const plans: Record<string, Plan> = { [LOAN]: { judgement: "conflict" } };
    const calls: ModelCall[] = [];
    const unbackedFigures = (call: ModelCall) =>
      `Figures: ${JSON.stringify({
        items: requestedFigures(call).map(({ id }) => ({
          id,
          verdict: "unsupported",
          scope: "same",
          topic: "not found",
          roles: "same",
          says: null,
          reading: null,
          relation: "equals",
          source: null,
          calculation: null,
        })),
        remainder: null,
      })}`;
    // The draft's own sentence would support it; the bank's figure contradicts it.
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        }
        const shown = shownPassages(searches.at(-1)?.text ?? "");
        const itself = shown.find((each) => each.text.includes(sentenceOf(call)));
        const bank = shown.find((each) => each.text.includes(BANK));
        const decided = itself ?? bank;
        if (!decided) return { text: unbackedFigures(call) };
        const quote = itself ? sentenceOf(call) : BANK;
        if (!call.results.some((result) => result.tool === "cite")) {
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: decided.id, quote }] } },
            ],
          };
        }
        const sourceNumbers = readFigures(quote, documentFigureContext([{ text: quote }]));
        return {
          text: `Figures: ${JSON.stringify({
            items: requestedFigures(call).map(({ id, shown }) => {
              const amount = shown === "£214,480.00";
              const at = quote.indexOf(!itself && amount ? "GBP" : shown);
              const position = sourceNumbers.findIndex((figure) => figure.start === at) + 1;
              return {
                id,
                verdict: !itself && amount ? "contradicted" : "supported",
                scope: "same",
                topic: "found",
                roles: "same",
                says: !itself && amount ? "The bank says £212,480.00." : null,
                reading: null,
                relation: "equals",
                source: { citation: 1, position, reading: null, unitQuote: null },
                calculation: null,
              };
            }),
            remainder: null,
          })}`,
        };
      },
      { generate: checkGenerate(plans) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [bank] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Northgate Bank confirmation.md",
        `# Audit confirmation\n\n${BANK}\n`,
      ),
    ]);
    const folder = await core.createLibraryGroup({ name: "Year end", description: "" });
    await core.moveToFolder({ documentIds: [bank?.id ?? ""], folderId: folder.id });
    const { mindId, client } = await importWordBytes(
      core,
      sources,
      wordFile({ body: paragraph(MEMO) }),
      {
        name: "Draft memo.docx",
        origin: "own",
        folderId: folder.id,
        addOriginal: true,
      },
    );
    await waitForDocuments(core, (listed) =>
      expect(listed.filter((each) => each.status === "ready")).toHaveLength(2),
    );

    const originalId = wordFileOf(client.doc)?.documentId;
    if (!originalId) throw new Error("The import has no original Document.");
    const importedAs = async () =>
      (await core.listDocuments()).find((each) => each.id === originalId)?.importedAs;
    expect(await importedAs()).toBe(mindId);

    const copy = await core.duplicateMind(mindId);
    // A copy is not the import: the Document still names the Mind it was imported as.
    expect(await importedAs()).toBe(mindId);

    // A later draft of the same original: the copy's checks must leave it out as the source's do.
    const later = `${LOAN} The later draft confirms the facility was renewed.`;
    await importWordBytes(core, sources, wordFile({ body: paragraph(later) }), {
      name: "Draft memo v2.docx",
      origin: "own",
      folderId: folder.id,
      addOriginal: true,
      newVersionOf: originalId,
    });
    await expect
      .poll(async () => {
        const draft = (await core.listDocuments()).find((each) => each.id === originalId);
        if (draft?.status !== "ready") return false;
        const { passages } = await core.searchEvidence("later draft confirms", {});
        return passages.some((each) => each.documentName.startsWith("Draft memo"));
      })
      .toBe(true);

    const copyClient = await connectToMind(core, copy.id);
    const request: CheckMindInput = { requestId: "copy-all", mindId: copy.id, mode: "all" };
    await core.checkMind(request);
    await copyClient.settled();

    const check = claimSpans(readMind(copyClient)).find(
      (span) => span.sentence.text.trim() === LOAN,
    )?.check;
    expect(check).toMatchObject({ state: "contradicted", evidence: { quote: BANK } });

    // The copy's own Word file is left out of the search, its later drafts too: never evidence.
    const shownToChecks = calls.flatMap((call) =>
      call.results
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text)),
    );
    expect(shownToChecks.some((each) => each.document.startsWith("Draft memo"))).toBe(false);
    // The bank's Document is still evidence: the checks searched, and found it.
    expect(shownToChecks.some((each) => each.document.startsWith("Northgate Bank"))).toBe(true);
  });
});
