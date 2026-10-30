import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { listedSentences, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    kind: "source",
    qualifier: "According to Residents",
    claim: "According to Residents, Nora lives in Oslo.",
    fact: "Nora lives in Oslo.",
    source: "Residents.md",
    heading: "Residents",
    quote: "Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    kind: "source",
    qualifier: "据居民记录",
    claim: "据居民记录，诺拉住在奥斯陆。",
    fact: "诺拉住在奥斯陆。",
    source: "居民记录.md",
    heading: "居民记录",
    quote: "诺拉住在奥斯陆。",
  },
  {
    language: "en",
    kind: "speaker",
    qualifier: "Nora said",
    claim: "Nora said the branch is open.",
    fact: "the branch is open.",
    source: "Call transcript.txt",
    quote: "Nora: the branch is open.",
  },
  {
    language: "zh-CN",
    kind: "speaker",
    qualifier: "诺拉说",
    claim: "诺拉说分行已营业。",
    fact: "分行已营业。",
    source: "通话文字稿.txt",
    quote: "诺拉：分行已营业。",
  },
] as const;

describe("Attribution through the public Note check", () => {
  test.each(CASES)(
    "$language $kind keeps one original assertion and owned receipts",
    async (row) => {
      const frames: ModelCall[] = [];
      const sorts: string[] = [];
      const plans = [
        { kind: "fact", text: row.qualifier, facet: { kind: row.kind } },
        { kind: "fact", text: row.fact },
      ];
      const model = scriptedModel(
        (call) => {
          frames.push(call);
          const whole = sentenceOf(call) === row.claim;
          const searched = call.results.find((result) => result.tool === "search_documents");
          if (!searched)
            return {
              ...(whole && { text: `Parts: ${JSON.stringify(plans)}` }),
              calls: [{ tool: "search_documents", input: { query: row.fact } }],
            };
          if (!call.results.some((result) => result.tool === "cite")) {
            const passage = shownPassages(searched.text).find((each) =>
              each.text.includes(row.quote),
            );
            if (!passage) throw new Error("The Note check did not find its actual Source quote.");
            return {
              calls: [
                {
                  tool: "cite",
                  input: {
                    citations: [{ marker: 1, passage: passage.id, quote: row.quote }],
                  },
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
              `${row.quote} [^1]`,
              ...(whole
                ? [
                    `Facets: ${JSON.stringify({
                      items: [
                        {
                          text: row.qualifier,
                          kind: row.kind,
                          ...(row.kind === "source" && { sourceName: row.heading }),
                          ...(row.kind === "speaker" && {
                            claimedSpeaker: row.language === "en" ? "Nora" : "诺拉",
                            actualSpeaker: row.language === "en" ? "Nora" : "诺拉",
                            actualSpeakerNamed: true,
                            speakerOrigin: "quote",
                          }),
                          occurrence: 1,
                          verdict: "supported",
                          scope: "same",
                          topic: "found",
                          roles: "same",
                          says: row.quote,
                          evidence: [1],
                        },
                      ],
                    })}`,
                  ]
                : []),
            ].join("\n"),
          };
        },
        {
          generate(call) {
            if (!call.system.startsWith("You sort the sentences"))
              throw new Error("The Note check asked an unexpected auxiliary model question.");
            sorts.push(call.prompt);
            const sentences = listedSentences(call.prompt).map(({ number, text }) => {
              if (text !== row.claim && text !== row.fact)
                throw new Error("The sorter received an unknown fixture sentence.");
              return { number, parts: text === row.claim ? plans : [{ kind: "fact", text }] };
            });
            return { text: JSON.stringify({ sentences }) };
          },
        },
      );
      const clock = manualClock("2026-10-29T12:00:00.000Z");
      const setup = await setUpWithDocuments(model, [], { now: clock.now });
      const { core } = setup;
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
      await core.updateSettings({ user: { language: row.language } });
      const sourceFolder = await createTempDataFolder();
      const contents =
        row.kind === "source" ? `# ${row.heading}\n\n${row.quote}\n` : `${row.quote}\n`;
      const path = await writeSourceFile(sourceFolder, row.source, contents);
      const [document] = await addAndProcess(core, [path]);
      if (!document) throw new Error("The Note fixture's Source was not imported.");

      const measure = async <T>(run: () => Promise<T>) => {
        const before = {
          stream: model.doStreamCalls.length,
          generate: model.doGenerateCalls.length,
          sort: sorts.length,
        };
        const frameStart = frames.length;
        const result = await run();
        return {
          result,
          frames: frames.slice(frameStart),
          requests: {
            streamed: model.doStreamCalls.length - before.stream,
            generated: model.doGenerateCalls.length - before.generate,
            sorter: sorts.length - before.sort,
            total:
              model.doStreamCalls.length +
              model.doGenerateCalls.length -
              before.stream -
              before.generate,
          },
        };
      };
      const checkNote = async (text: string, title: string) => {
        const mind = await core.createMind({ title });
        const client = await connectToMind(core, mind.id);
        const blockId = crypto.randomUUID();
        writeMind(client, [
          {
            type: "paragraph",
            attrs: { id: blockId },
            content: [{ type: "text", text }],
          },
        ]);
        await client.settled();
        const measured = await measure(() =>
          core.checkMind({
            requestId: crypto.randomUUID(),
            mindId: mind.id,
            mode: "all",
          }),
        );
        await client.settled();
        return {
          mind,
          client,
          marks: claimSpans(readMind(client)),
          ...measured,
          recheck: () =>
            measure(() =>
              core.checkSentences({
                requestId: crypto.randomUUID(),
                mindId: mind.id,
                action: "check-against-documents",
                from: { blockId, offset: 0 },
                to: { blockId, offset: text.length },
              }),
            ),
        };
      };

      const baseline = await checkNote(row.fact, "One fact");
      expect(baseline.result).toMatchObject({ kind: "checked", checked: 1 });
      expect(baseline.marks).toHaveLength(1);
      expect(baseline.marks[0]?.check.state).toBe("supported");
      expect(baseline.requests).toEqual({ streamed: 3, generated: 1, sorter: 1, total: 4 });
      const baselineAgain = await baseline.recheck();
      expect(baselineAgain.result).toMatchObject({ kind: "checked", sentences: 1, checked: 1 });
      expect(baselineAgain.requests).toEqual({ streamed: 3, generated: 0, sorter: 0, total: 3 });

      const attributed = await checkNote(row.claim, "Attributed fact");
      expect.soft(attributed.requests).toEqual(baseline.requests);
      expect.soft(attributed.frames.map(sentenceOf)).toEqual([row.claim, row.claim, row.claim]);
      expect(attributed.result).toMatchObject({ kind: "checked", checked: 1 });
      expect(attributed.marks).toHaveLength(1);
      const saved = attributed.marks[0]?.check;
      if (!saved) throw new Error("The original sentence has no canonical check mark.");
      expect(saved.text).toBe(row.claim);
      expect(saved.state).toBe("supported");
      const sourceReceiptId = saved.parts
        ?.find((part) => part.facet?.kind === "source")
        ?.evidence.find((citation) => citation.documentId === document.id)?.id;
      if (row.kind === "source" && !sourceReceiptId)
        throw new Error("The source candidate has no canonical owned Citation id.");
      const sourceMetadata =
        row.kind === "source"
          ? {
              named: {
                start: row.claim.indexOf(row.heading),
                end: row.claim.indexOf(row.heading) + row.heading.length,
              },
              candidates: [{ documentId: document.id, citationId: sourceReceiptId }],
            }
          : {};
      if (row.kind === "source") {
        expect(row.claim.indexOf(row.heading)).toBeGreaterThanOrEqual(0);
        expect(row.claim.lastIndexOf(row.heading)).toBe(row.claim.indexOf(row.heading));
      }
      expect(
        saved.parts?.map((part) => ({
          text: saved.text.slice(part.span.start, part.span.end),
          span: part.span,
          facet: part.facet,
          verdict: part.verdict,
        })),
      ).toEqual([
        {
          text: row.qualifier,
          span: { start: 0, end: row.qualifier.length },
          facet: { kind: row.kind, ...sourceMetadata },
          verdict: "supported",
        },
        {
          text: row.fact,
          span: { start: row.claim.indexOf(row.fact), end: row.claim.length },
          facet: undefined,
          verdict: "supported",
        },
      ]);
      const ids = saved.parts?.map((part) => {
        expect(part.evidence).toHaveLength(1);
        const receipt = part.evidence[0];
        expect(receipt).toMatchObject({
          documentId: document.id,
          contentHash: document.contentHash,
          passageId: expect.any(String),
          quote: row.quote,
          check: "found",
        });
        expect(receipt?.location).not.toBeNull();
        expect(receipt?.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        return receipt?.id;
      });
      expect(new Set(ids).size).toBe(2);

      const attributedAgain = await attributed.recheck();
      await attributed.client.settled();
      expect.soft(attributedAgain.requests).toEqual(baselineAgain.requests);
      expect
        .soft(attributedAgain.frames.map(sentenceOf))
        .toEqual([row.claim, row.claim, row.claim]);
      expect(attributedAgain.result).toMatchObject({ kind: "checked", sentences: 1, checked: 1 });
      const rechecked = claimSpans(readMind(attributed.client));
      expect(rechecked).toHaveLength(1);
      expect(rechecked[0]?.check.parts).toEqual(saved.parts);

      const requestsBeforeReopen = model.doStreamCalls.length + model.doGenerateCalls.length;
      await core.close();
      const restarted = startCore(setup.dataDir, {
        createChatModel: setup.models.createChatModel,
        now: clock.now,
      });
      const freshClient = await connectToMind(restarted, attributed.mind.id);
      await freshClient.settled();
      const reopened = claimSpans(readMind(freshClient));
      expect(reopened).toHaveLength(1);
      expect(reopened[0]?.check).toEqual(rechecked[0]?.check);
      expect(reopened[0]?.check.parts?.map((part) => part.evidence[0]?.id)).toEqual(ids);
      expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBe(requestsBeforeReopen);
    },
  );
});
