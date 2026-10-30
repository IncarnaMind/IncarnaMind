import { expect, test } from "vitest";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import { checkWithParts } from "../../src/shared/claimParts";
import { setMindScope } from "../../src/shared/mindScope";
import { listedSentences, requestedFigures } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

const ROWS = [
  {
    language: "en",
    title: "Lease record",
    prefix: "According to Lease record",
    when: "currently",
    quote: "In March 2026, the board reviewed routine operating costs.",
    plain: "the lease has no break clause.",
    native: "the company has not disclosed the GBP 5 million loan.",
    absent: "a break clause",
    nativeAbsent: "the GBP 5 million loan",
    separator: ", ",
  },
  {
    language: "zh-CN",
    title: "租约记录",
    prefix: "据租约记录",
    when: "目前",
    quote: "2026年3月，董事会审阅了日常运营成本。",
    plain: "租约没有解约条款。",
    native: "公司没有披露这笔500万英镑的贷款。",
    absent: "解约条款",
    nativeAbsent: "这笔500万英镑的贷款",
    separator: "，",
  },
] as const;

function targets(call: ModelCall): { text: string; kind: string }[] {
  const line =
    /Judge these exact facet targets in that complete assertion, in this same Run:\n([^\n]+)/.exec(
      call.prompt,
    )?.[1] ?? /^Parts: ([^\n]+)/m.exec(call.prompt)?.[1];
  const value: unknown = line ? JSON.parse(line) : [];
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        if (
          typeof item !== "object" ||
          item === null ||
          !("kind" in item) ||
          typeof item.kind !== "string" ||
          !("text" in item) ||
          typeof item.text !== "string"
        )
          return [];
        const kind =
          "facet" in item &&
          typeof item.facet === "object" &&
          item.facet !== null &&
          "kind" in item.facet &&
          typeof item.facet.kind === "string"
            ? item.facet.kind
            : item.kind;
        return kind === "source" || kind === "time" ? [{ text: item.text, kind }] : [];
      })
    : [];
}

const TWINS = [
  {
    language: "en",
    title: "Atlas",
    prefix: "According to Atlas",
    fact: "the lease has no break clause.",
    claim: "According to Atlas, the lease has no break clause.",
    quote: "The tenant pays rent monthly.",
    clause: "The lease contains a break clause: either party may end it with written notice.",
    absent: "a break clause",
  },
  {
    language: "zh-CN",
    title: "登记册",
    prefix: "据登记册",
    fact: "租约没有解约条款。",
    claim: "据登记册，租约没有解约条款。",
    quote: "承租人应当按月支付租金。",
    clause: "租约包含解约条款：双方均可提前书面通知终止本租约。",
    absent: "解约条款",
  },
] as const;

function sourceChoices(
  prompt: string,
): { text: string; document: string; span: { start: number; end: number } }[] {
  const json = /<source-choices>\n([\s\S]*?)\n<\/source-choices>/.exec(prompt)?.[1];
  const value: unknown = json ? JSON.parse(json) : [];
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        if (
          typeof item !== "object" ||
          item === null ||
          !("text" in item) ||
          typeof item.text !== "string" ||
          !("document" in item) ||
          typeof item.document !== "string" ||
          !("span" in item) ||
          typeof item.span !== "object" ||
          item.span === null ||
          !("start" in item.span) ||
          typeof item.span.start !== "number" ||
          !("end" in item.span) ||
          typeof item.span.end !== "number"
        )
          return [];
        return [
          {
            text: item.text,
            document: item.document,
            span: { start: item.span.start, end: item.span.end },
          },
        ];
      })
    : [];
}

test.each(TWINS)(
  "$language absence whole read retains the chosen UUID and both scoped Documents",
  async (row) => {
    const whole: GenerateCall[] = [];
    const searches: { query: string; document: string }[] = [];
    const initialPrompts: string[] = [];
    const model = scriptedModel(
      (call) => {
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (!searched) {
          initialPrompts.push(call.prompt);
          const input = {
            query: row.quote,
            document: sourceChoices(call.prompt)[0]?.document ?? row.title,
          };
          searches.push(input);
          return {
            text: `Parts: ${JSON.stringify([
              { kind: "fact", text: row.prefix, facet: { kind: "source" } },
              { kind: "fact", text: row.fact },
            ])}`,
            calls: [{ tool: "search_documents", input }],
          };
        }
        const passage = shownPassages(searched.text).find((item) => item.text.includes(row.quote));
        if (!passage) throw new Error("The actual scoped Source did not return its rent quote.");
        if (!call.results.some((result) => result.tool === "cite"))
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
              },
            ],
          };
        return {
          text: [
            "Verdict: supported",
            "Absence: yes",
            "Scope: none, same",
            "Topic: found",
            "Roles: none, same",
            "Calculation: none",
            "Evidence: [1]",
            `${row.quote} [^1]`,
            `Facets: ${JSON.stringify({ items: targets(call).map((target) => ({ ...target, occurrence: 1, sourceName: row.title, verdict: "supported", scope: "same", topic: "found", roles: "same", evidence: [1], says: row.quote })) })}`,
          ].join("\n"),
        };
      },
      {
        generate(call) {
          if (call.system.startsWith("You sort the sentences"))
            return {
              text: JSON.stringify({
                sentences: listedSentences(call.prompt).map(({ number, text }) => {
                  if (text !== row.claim)
                    throw new Error("The twin Source sorter received another sentence.");
                  return {
                    number,
                    parts: [
                      { kind: "fact", text: row.prefix, facet: { kind: "source" } },
                      { kind: "fact", text: row.fact },
                    ],
                  };
                }),
              }),
            };
          if (!call.system.startsWith("Read the whole Documents"))
            throw new Error("Unexpected auxiliary request in the twin Source fixture.");
          whole.push(call);
          const choice = sourceChoices(call.prompt)[0];
          const labels = [...call.prompt.matchAll(/Document ("[^"\n]+"):\n/g)];
          const own = labels.findIndex(
            (match) => JSON.parse(match[1] ?? "null") === choice?.document,
          );
          const selectedText =
            own < 0
              ? null
              : call.prompt.slice(
                  (labels[own]?.index ?? 0) + (labels[own]?.[0].length ?? 0),
                  labels[own + 1]?.index,
                );
          if (choice && selectedText !== null && !selectedText.includes(row.clause))
            return { text: JSON.stringify({ absence: "holds", absent: row.absent }) };
          const contained = shownPassages(call.prompt).find((item) =>
            item.text.includes(row.clause),
          );
          if (!contained) throw new Error("The whole scope lost its actual break-clause Document.");
          return {
            text: JSON.stringify({
              absence: "contained",
              absent: row.absent,
              citations: [{ marker: 1, passage: contained.id, quote: row.clause }],
            }),
          };
        },
      },
    );
    const { core, mind, client } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-30T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    await core.updateSettings({ user: { language: row.language } });
    const folderA = await createTempDataFolder();
    const folderB = await createTempDataFolder();
    const pathA = await writeSourceFile(folderA, `${row.title}.md`, row.quote);
    const pathB = await writeSourceFile(
      folderB,
      `${row.title}.md`,
      `${row.quote}\n\n${row.clause}`,
    );
    const [documentA, documentB] = await addAndProcess(core, [pathA, pathB]);
    if (!documentA || !documentB) throw new Error("Both actual same-title Sources are required.");
    const blockId = "absence-source-context";
    writeMind(client, [
      { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: row.claim }] },
    ]);
    setMindScope(client.doc, {
      folderIds: [],
      tagIds: [],
      documentIds: [documentA.id, documentB.id],
    });
    await client.settled();
    await core.findMindClaims({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
    const check = () =>
      core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId, offset: 0 },
        to: { blockId, offset: row.claim.length },
      });
    await check();
    await client.settled();
    const [marked] = markedSentences(client.blocks);
    if (!marked?.check.parts) throw new Error("The initial whole Check has no canonical parts.");
    expect(marked.check.parts.find((part) => !part.facet)).toMatchObject({
      verdict: "contradicted",
      evidence: [
        expect.objectContaining({ documentId: documentB.id, quote: row.clause, check: "found" }),
      ],
    });
    client.doc.transact(() =>
      markSentence(
        marked.element,
        marked.from,
        marked.to,
        checkWithParts(
          marked.check,
          marked.check.parts?.map((part) =>
            part.facet?.kind === "source"
              ? { ...part, facet: { ...part.facet, selectedDocumentId: documentA.id } }
              : part,
          ) ?? [],
        ),
      ),
    );
    await client.settled();
    const firstStream = model.doStreamCalls.length;
    const firstGenerate = model.doGenerateCalls.length;
    await check();
    await client.settled();
    const after = markedSentences(client.blocks)[0]?.check;
    const secondRead = whole.at(-1);
    if (!secondRead) throw new Error("The selected Source absence was not whole-read.");
    expect(sourceChoices(secondRead.prompt)).toContainEqual({
      text: row.prefix,
      document: documentA.id,
      span: { start: 0, end: row.prefix.length },
    });
    const initialPrompt = initialPrompts.at(-1);
    if (!initialPrompt) throw new Error("The chosen Source check had no initial request.");
    expect(secondRead.prompt.startsWith(initialPrompt)).toBe(true);
    expect(secondRead.prompt).toContain(`<sentence>\n${row.claim}\n</sentence>`);
    expect(secondRead.prompt).toContain(`Document ${JSON.stringify(documentA.id)}:\n`);
    expect(secondRead.prompt).toContain(`Document ${JSON.stringify(documentB.id)}:\n`);
    expect(secondRead.prompt).toContain(row.quote);
    expect(secondRead.prompt).toContain(row.clause);
    expect(after?.parts?.find((part) => !part.facet)).toMatchObject({
      verdict: "supported",
      readDocuments: expect.arrayContaining([
        expect.objectContaining({ documentId: documentA.id }),
        expect.objectContaining({ documentId: documentB.id }),
      ]),
    });
    expect(after?.parts?.find((part) => part.facet?.kind === "source")).toMatchObject({
      verdict: "supported",
      facet: { selectedDocumentId: documentA.id },
      evidence: [expect.objectContaining({ documentId: documentA.id, check: "found" })],
    });
    expect(searches.at(-1)).toEqual({ query: row.quote, document: documentA.id });
    expect(model.doStreamCalls.length - firstStream).toBe(3);
    expect(model.doGenerateCalls.length - firstGenerate).toBe(1);
    expect(whole).toHaveLength(2);
  },
);

for (const row of ROWS) {
  test.each([false, true])(
    `${row.language} absence keeps Source/time proof and selected-only cost; native=%s`,
    async (native) => {
      const fact = native ? row.native : row.plain;
      const claim = `${row.prefix}${row.separator}${row.when}${row.language === "en" ? " " : ""}${fact}`;
      const plans = [
        { kind: "fact", text: row.prefix, facet: { kind: "source" } },
        { kind: "fact", text: row.when, facet: { kind: "time" } },
        { kind: "fact", text: fact },
      ];
      const streams: ModelCall[] = [];
      const whole: GenerateCall[] = [];
      const model = scriptedModel(
        (call) => {
          streams.push(call);
          const searched = call.results.find((result) => result.tool === "search_documents");
          if (!searched)
            return {
              text: `Parts: ${JSON.stringify(plans)}`,
              calls: [
                { tool: "search_documents", input: { query: row.quote, document: row.title } },
              ],
            };
          if (!call.results.some((result) => result.tool === "cite")) {
            const passage = shownPassages(searched.text).find((passage) =>
              passage.text.includes(row.quote),
            );
            if (!passage)
              throw new Error("The attribution check did not find its actual period quote.");
            return {
              calls: [
                {
                  tool: "cite",
                  input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
                },
              ],
            };
          }
          const figures = requestedFigures(call).map(({ id, reading }) => ({
            id,
            verdict: "unsupported",
            scope: "same",
            topic: "not found",
            roles: "same",
            says: null,
            reading,
            relation: "equals",
            source: null,
            calculation: null,
          }));
          return {
            text: [
              "Verdict: supported",
              "Absence: yes",
              "Scope: none, same",
              "Topic: found",
              "Roles: none, same",
              "Calculation: none",
              "Evidence: [1]",
              `${row.quote} [^1]`,
              ...(figures.length
                ? [`Figures: ${JSON.stringify({ items: figures, remainder: null })}`]
                : []),
              `Facets: ${JSON.stringify({ items: targets(call).map((target) => ({ ...target, occurrence: 1, verdict: "supported", scope: "same", topic: "found", roles: "same", evidence: [1], says: row.quote, ...(target.kind === "source" ? { sourceName: row.title } : { time: "present", period: { start: "2026-03-01", end: "2026-03-31", precision: "month" } }) })) })}`,
            ].join("\n"),
          };
        },
        {
          generate(call) {
            if (call.system.startsWith("Read the whole Documents")) {
              whole.push(call);
              return {
                text: JSON.stringify({
                  absence: "holds",
                  absent: native ? row.nativeAbsent : row.absent,
                }),
              };
            }
            if (call.system.startsWith("You sort the sentences"))
              return {
                text: JSON.stringify({
                  sentences: listedSentences(call.prompt).map(({ number, text }) => {
                    if (text !== claim)
                      throw new Error("Unexpected sentence in the absence sorter.");
                    return { number, parts: plans };
                  }),
                }),
              };
            throw new Error("Unexpected auxiliary request in the absence fixture.");
          },
        },
      );
      const { core, mind, client } = await setUpWithDocuments(model, [], {
        now: manualClock("2026-10-30T12:00:00.000Z").now,
      });
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
      await core.updateSettings({ user: { language: row.language } });
      const folder = await createTempDataFolder();
      const path = await writeSourceFile(
        folder,
        `${row.title}.md`,
        `# ${row.title}\n\n${row.quote}`,
      );
      const [document] = await addAndProcess(core, [path]);
      if (!document) throw new Error("The actual absence Source was not imported.");
      const blockId = "attribution-absence";
      writeMind(client, [
        { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: claim }] },
      ]);
      await client.settled();
      await core.findMindClaims({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
      const firstStream = model.doStreamCalls.length;
      const firstGenerate = model.doGenerateCalls.length;
      const input = {
        mindId: mind.id,
        action: "check-against-documents" as const,
        from: { blockId, offset: 0 },
        to: { blockId, offset: claim.length },
      };
      await core.checkSentences({ ...input, requestId: crypto.randomUUID() });
      await client.settled();
      const before = markedSentences(client.blocks)[0]?.check;
      if (!before?.parts)
        throw new Error("The actual absence check did not retain its part inventory.");
      const ordinary = before.parts.find((part) => !part.facet);
      const source = before.parts.find((part) => part.facet?.kind === "source");
      const time = before.parts.find((part) => part.facet?.kind === "time");
      expect(ordinary).toMatchObject({
        verdict: "supported",
        readDocuments: [
          {
            documentId: document.id,
            contentHash: document.contentHash,
            locations: expect.any(Array),
          },
        ],
      });
      if (native) {
        const firstCall = streams[firstStream];
        if (!firstCall) throw new Error("The native check sent no actual provider request.");
        expect(requestedFigures(firstCall)).toHaveLength(1);
      }
      expect(source).toMatchObject({
        verdict: "supported",
        evidence: [
          expect.objectContaining({ documentId: document.id, quote: row.quote, check: "found" }),
        ],
      });
      expect(time).toMatchObject({
        verdict: "supported",
        facet: {
          kind: "time",
          period: { start: "2026-03-01", end: "2026-03-31", precision: "month" },
        },
      });
      expect(model.doStreamCalls.length - firstStream).toBe(3);
      expect(model.doGenerateCalls.length - firstGenerate).toBe(1);
      expect(whole).toHaveLength(1);
      if (native)
        expect(ordinary?.figures?.[0]?.result).toMatchObject({
          verdict: "supported",
          evidence: null,
          readDocuments: expect.any(Array),
        });
      if (!time) throw new Error("The actual time part was not stored.");
      const recheckStream = model.doStreamCalls.length;
      const recheckGenerate = model.doGenerateCalls.length;
      await core.checkSentences({
        ...input,
        requestId: crypto.randomUUID(),
        part: { id: before.id, span: time.span },
      });
      await client.settled();
      const after = markedSentences(client.blocks)[0]?.check;
      expect(whole).toHaveLength(1);
      expect(model.doStreamCalls.length - recheckStream).toBe(3);
      expect(model.doGenerateCalls.length - recheckGenerate).toBe(0);
      expect(after?.parts?.find((part) => !part.facet)).toEqual(ordinary);
      expect(after?.parts?.find((part) => part.facet?.kind === "source")).toEqual(source);
      expect(after?.parts?.find((part) => part.facet?.kind === "time")).toMatchObject({
        verdict: "supported",
      });
      expect(streams.every((call) => !call.system.startsWith("Read the whole Documents"))).toBe(
        true,
      );
    },
  );
}
