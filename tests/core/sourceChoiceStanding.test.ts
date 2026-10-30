import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import { SENTENCE_RESULT_LABELS } from "../../src/shared/claimChecks";
import { checkWithParts } from "../../src/shared/claimParts";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { isCheckRun, listedSentences } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { parseCsv } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { textOf, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  claimCheckReply,
  type GenerateCall,
  type ModelCall,
  scriptedModel,
} from "../helpers/models";
import { fakePrinter } from "../helpers/printer";

const CASES = [
  {
    language: "en",
    name: "Report",
    prefix: "According to Report",
    claim: "According to Report, Nora lives in Oslo.",
    fact: "Nora lives in Oslo.",
    note: "Public source standing note",
    privateName: "Cobalt-7Q private register",
    privateFolder: "Amber-9Z private records",
    question: "Read Public source standing note.",
  },
  {
    language: "zh-CN",
    name: "报告",
    prefix: "据报告",
    claim: "据报告，诺拉住在奥斯陆。",
    fact: "诺拉住在奥斯陆。",
    note: "公开来源状态笔记",
    privateName: "钴蓝7Q保密登记册",
    privateFolder: "琥珀9Z保密档案",
    question: "读取公开来源状态笔记。",
  },
] as const;

test.each(CASES)(
  "$language Core standing changes without rewriting or disclosing Source choices",
  async (row) => {
    const calls: ModelCall[] = [];
    const generated: GenerateCall[] = [];
    const plans = [
      { kind: "fact", text: row.prefix, facet: { kind: "source" } },
      { kind: "fact", text: row.fact },
    ];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        if (!isCheckRun(call)) {
          if (!call.results.some((result) => result.tool === "read_mind")) {
            expect(call.tools).toContain("read_mind");
            return { calls: [{ tool: "read_mind", input: { mind: row.note } }] };
          }
          return { text: "Read." };
        }
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search)
          return {
            text: `Parts: ${JSON.stringify(plans)}`,
            calls: [{ tool: "search_documents", input: { query: row.fact } }],
          };
        if (!call.results.some((result) => result.tool === "cite")) {
          const passage = shownPassages(search.text).find((each) => each.text.includes(row.fact));
          if (!passage) throw new Error("The checked Source's actual quote was not found.");
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: row.fact }] },
              },
            ],
          };
        }
        return {
          text: [
            "Verdict: supported",
            "Scope: none, same",
            "Topic: found",
            "Roles: none, same",
            "Calculation: none",
            "Evidence: [1]",
            `${row.fact} [^1]`,
            `Facets: ${JSON.stringify({
              items: [
                {
                  text: row.prefix,
                  kind: "source",
                  sourceName: row.name,
                  occurrence: 1,
                  verdict: "supported",
                  scope: "same",
                  topic: "found",
                  roles: "same",
                  says: row.fact,
                  evidence: [1],
                },
              ],
            })}`,
          ].join("\n"),
        };
      },
      {
        generate(call) {
          generated.push(call);
          if (call.system.includes(CLAIM_CHECK_INSTRUCTIONS)) return claimCheckReply(call, []);
          if (!call.system.startsWith("You sort the sentences"))
            throw new Error("The standing fixture received an unexpected auxiliary request.");
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number, text }) => {
                if (text !== row.claim)
                  throw new Error("The sorter received another Note sentence.");
                return { number, parts: plans };
              }),
            }),
          };
        },
      },
    );
    const setup = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-30T12:00:00.000Z").now,
      printer: fakePrinter().printer,
    });
    const { core, client, mind } = setup;
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    await core.updateSettings({ user: { language: row.language } });
    await core.renameMind(mind.id, row.note);
    const sources = await createTempDataFolder();
    const paths = [
      await writeSourceFile(sources, `${row.name}.md`, row.fact),
      await writeSourceFile(sources, "Public office.md", "The public office has a blue door."),
    ];
    const [document] = await addAndProcess(core, paths);
    if (!document) throw new Error("The real Source was not processed.");
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "standing" },
        content: [{ type: "text", text: row.claim }],
      },
    ]);
    await client.settled();
    expect(
      await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" }),
    ).toMatchObject({ kind: "checked", checked: 1 });
    await client.settled();
    const owner = () => {
      const marked = markedSentences(client.blocks)[0];
      if (!marked?.check.parts) throw new Error("The canonical checked parts were not stored.");
      return marked;
    };
    const initial = owner();
    expect(initial.check.parts?.map((part) => part.verdict)).toEqual(["supported", "supported"]);
    expect(
      initial.check.parts?.every((part) =>
        part.evidence.some(
          (citation) =>
            citation.documentId === document.id &&
            citation.contentHash === document.contentHash &&
            citation.check === "found" &&
            citation.quote === row.fact &&
            typeof citation.id === "string",
        ),
      ),
    ).toBe(true);
    client.doc.transact(() =>
      markSentence(
        initial.element,
        initial.from,
        initial.to,
        checkWithParts(
          initial.check,
          initial.check.parts?.map((part) =>
            part.facet?.kind === "source"
              ? { ...part, facet: { ...part.facet, selectedDocumentId: document.id } }
              : part,
          ) ?? [],
        ),
      ),
    );
    await client.settled();
    const rawCheck = () =>
      JSON.stringify(
        owner()
          .element.toArray()
          .map((node) => (node instanceof Y.XmlText ? node.toDelta() : node.toJSON())),
      );
    const before = rawCheck();
    const projection = async (stale: boolean) => {
      expect(await core.planMindCheck(mind.id, "changed")).toMatchObject(
        stale ? { kind: "ready", sentences: 1 } : { kind: "unchanged" },
      );
      const saved = await core.saveCheckRecord(mind.id);
      if (saved.status !== "saved") throw new Error("The actual Check record was not saved.");
      const csv = await readFile(
        join(out, saved.file.name.replace(/\.(pdf|csv)$/, ".csv")),
        "utf8",
      );
      const rows = parseCsv(csv);
      const recordRow = rows.find(
        (cells) =>
          cells[0] === translate(row.language, "checkRecord.kind.sentence") &&
          cells[1] === row.claim,
      );
      expect(recordRow?.[2]).toBe(
        translate(row.language, SENTENCE_RESULT_LABELS[stale ? "needsRecheck" : "supported"]),
      );
      const exported = await core.exportMind(mind.id, {
        format: "docx",
        commentFailedChecks: true,
      });
      expect(exported.sentenceChecks.needsRecheck).toBe(stale ? 1 : 0);
      if (stale) {
        const comments = unzip(exported.data).get("word/comments.xml")?.toString("utf8") ?? "";
        expect(textOf(comments)).toContain(
          translate(row.language, "export.comment.sentence.needs-recheck.source-choice"),
        );
      }
      const statement = await core.createAiUseStatement(mind.id);
      const statementClient = await connectToMind(core, statement.id);
      const tableRows: string[][] = [];
      readMind(statementClient).descendants((node) => {
        if (node.type.name !== "tableRow") return;
        const cells: string[] = [];
        node.forEach((cell) => {
          cells.push(cell.textContent);
        });
        tableRows.push(cells);
      });
      expect(tableRows.find((cells) => cells[0] === row.claim)?.[1]).toBe(
        translate(row.language, SENTENCE_RESULT_LABELS[stale ? "needsRecheck" : "supported"]),
      );
      expect(rawCheck()).toBe(before);
    };
    await projection(false);
    const renamed = await core.renameDocument(document.id, row.privateName);
    expect(renamed.contentHash).toBe(document.contentHash);
    await projection(true);
    const folder = await core.createLibraryGroup({ name: row.privateFolder, description: "" });
    await core.assignDocumentGroup(document.id, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: "",
      keepInside: true,
    });
    await projection(true);
    const firstCall = calls.length;
    const firstGenerated = generated.length;
    await askAssistant(core, { text: row.question });
    const outside = calls.slice(firstCall);
    const sent = outside
      .map((call) =>
        [call.system, call.prompt, ...call.results.map((result) => result.text)].join("\n"),
      )
      .concat(generated.slice(firstGenerated).map((call) => `${call.system}\n${call.prompt}`))
      .join("\n");
    const read = outside
      .flatMap((call) => call.results)
      .find((result) => result.tool === "read_mind");
    expect(read?.text).toContain(row.claim);
    expect(sent).not.toContain(row.privateName);
    expect(sent).not.toContain(row.privateFolder);
    expect(rawCheck()).toBe(before);
    console.info(
      JSON.stringify({
        language: row.language,
        outsideRequests: outside.length,
        auxiliaryRequests: generated.length - firstGenerated,
        read: read?.text,
        privateNameSent: sent.includes(row.privateName),
        privateFolderSent: sent.includes(row.privateFolder),
        storedCheckUnchanged: rawCheck() === before,
      }),
    );
  },
);
