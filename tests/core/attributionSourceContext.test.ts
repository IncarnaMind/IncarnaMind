import { describe, expect, test } from "vitest";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import { checkWithParts } from "../../src/shared/claimParts";
import { setMindScope } from "../../src/shared/mindScope";
import { listedSentences, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    title: "Atlas",
    prefix: "According to Atlas",
    claim: "According to Atlas, Nora lives in Oslo and the branch is open.",
    first: "Nora lives in Oslo",
    second: "the branch is open.",
    firstQuote: "Nora lives in Oslo.",
    secondQuote: "The branch is open.",
    otherQuote: "The branch is closed.",
    context:
      "The northern district register covers the branch, its public entrance, the nearby station and residents' addresses. The building has a reception desk and a separate records room.",
  },
  {
    language: "zh-CN",
    title: "登记册",
    prefix: "据登记册",
    claim: "据登记册，诺拉住在奥斯陆，而且分行已营业。",
    first: "诺拉住在奥斯陆",
    second: "分行已营业。",
    firstQuote: "诺拉住在奥斯陆。",
    secondQuote: "分行已营业。",
    otherQuote: "分行已停业。",
    context:
      "北区登记册详细记录分行、公共入口、附近车站和居民的住址。分行大楼内设有接待处和独立档案室，入口旁边还有一块公布营业信息的告示板。",
  },
] as const;

type SourceTarget = { text: string; document?: string };

function sourceTargets(value: unknown): SourceTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item !== null &&
    typeof item === "object" &&
    (!("kind" in item) || item.kind === "source") &&
    "text" in item &&
    typeof item.text === "string"
      ? [
          {
            text: item.text,
            ...("document" in item && typeof item.document === "string"
              ? { document: item.document }
              : {}),
          },
        ]
      : [],
  );
}

function offeredSources(call: ModelCall): SourceTarget[] {
  const lines = call.prompt.split("\n");
  const at = lines.indexOf(
    "Judge these exact facet targets in that complete assertion, in this same Run:",
  );
  const line = at < 0 ? undefined : lines[at + 1];
  return line ? sourceTargets(JSON.parse(line)) : [];
}

function visibleSources(call: ModelCall): SourceTarget[] {
  const choices = /<source-choices>\n([\s\S]*?)\n<\/source-choices>/.exec(call.prompt)?.[1];
  return [...(choices ? sourceTargets(JSON.parse(choices)) : []), ...offeredSources(call)];
}

describe("a remembered Source prefix across independent assertions", () => {
  test.each(
    CASES.flatMap((row) => [
      { ...row, mode: "shared" as const },
      { ...row, mode: "two-prefixes" as const },
      { ...row, mode: "outside-scope" as const },
      { ...row, mode: "renamed" as const },
      { ...row, mode: "deleted" as const },
      { ...row, mode: "moved-behind-wall" as const },
      { ...row, mode: "same-wall" as const },
    ]),
  )("$language $mode preserves current source choices without duplicate targets", async (row) => {
    const secondTitle = row.language === "en" ? "Beacon" : "分行记录";
    const secondPrefix = row.language === "en" ? "according to Beacon" : "据分行记录";
    const twoPrefixes = row.mode === "two-prefixes";
    const stale = row.mode !== "shared" && row.mode !== "two-prefixes" && row.mode !== "same-wall";
    const claim = twoPrefixes
      ? row.language === "en"
        ? `According to Atlas, ${row.first}; ${secondPrefix}, ${row.second}`
        : `据登记册，${row.first}；${secondPrefix}，${row.second}`
      : row.claim;
    const plans = [
      { kind: "fact", text: row.prefix, facet: { kind: "source" } },
      { kind: "fact", text: row.first },
      ...(twoPrefixes ? [{ kind: "fact", text: secondPrefix, facet: { kind: "source" } }] : []),
      { kind: "fact", text: row.second },
    ];
    const frames: ModelCall[] = [];
    const comparisons: GenerateCall[] = [];
    const model = scriptedModel(
      (call) => {
        frames.push(call);
        const first = sentenceOf(call) === row.first;
        const facets = offeredSources(call);
        const context = visibleSources(call);
        const source = (prefix: string, title: string) =>
          context.find((item) => item.text === prefix && item.document)?.document ?? title;
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0)
          return {
            calls: [
              {
                tool: "search_documents",
                input: {
                  query: first ? row.firstQuote : row.secondQuote,
                  document: first
                    ? source(row.prefix, row.title)
                    : source(
                        twoPrefixes ? secondPrefix : row.prefix,
                        twoPrefixes ? secondTitle : row.title,
                      ),
                },
              },
              ...(first && twoPrefixes
                ? [
                    {
                      tool: "search_documents",
                      input: {
                        query: row.secondQuote,
                        document: source(secondPrefix, secondTitle),
                      },
                    },
                  ]
                : []),
            ],
          };
        const passages = searches.flatMap((search) => shownPassages(search.text));
        const quote = first
          ? row.firstQuote
          : passages.some((passage) => passage.text.includes(row.secondQuote))
            ? row.secondQuote
            : row.otherQuote;
        const passage = passages.find((candidate) => candidate.text.includes(quote));
        if (!passage) throw new Error("The chosen named Document did not return its real quote.");
        const secondPassages = first && twoPrefixes ? shownPassages(searches[1]?.text ?? "") : [];
        const secondQuote = secondPassages.some((item) => item.text.includes(row.secondQuote))
          ? row.secondQuote
          : row.otherQuote;
        const secondPassage = secondPassages.find((item) => item.text.includes(secondQuote));
        if (first && twoPrefixes && !secondPassage)
          throw new Error("The second Source target did not return its real quote.");
        if (!call.results.some((result) => result.tool === "cite"))
          return {
            calls: [
              {
                tool: "cite",
                input: {
                  citations: [
                    { marker: 1, passage: passage.id, quote },
                    ...(secondPassage
                      ? [{ marker: 2, passage: secondPassage.id, quote: secondQuote }]
                      : []),
                  ],
                },
              },
            ],
          };
        const verdict = quote === row.otherQuote ? "contradicted" : "supported";
        return {
          text: [
            `Verdict: ${verdict}`,
            "Scope: none, same",
            "Topic: found",
            "Roles: none, same",
            "Calculation: none",
            "Evidence: [1]",
            `${quote} [^1]`,
            ...(secondPassage ? [`${secondQuote} [^2]`] : []),
            ...(facets.length
              ? [
                  `Facets: ${JSON.stringify({
                    items: facets.map((facet) => ({
                      text: facet.text,
                      kind: "source",
                      sourceName: facet.text === secondPrefix ? secondTitle : row.title,
                      occurrence: 1,
                      verdict: "supported",
                      scope: "same",
                      topic: "found",
                      roles: "same",
                      says: facet.text === secondPrefix ? secondQuote : quote,
                      evidence: [facet.text === secondPrefix ? 2 : 1],
                    })),
                  })}`,
                ]
              : []),
          ].join("\n"),
        };
      },
      {
        generate(call) {
          if (call.system.startsWith("You sort the sentences"))
            return {
              text: JSON.stringify({
                sentences: listedSentences(call.prompt).map(({ number, text }) => {
                  if (text !== claim) throw new Error("The sorter received another sentence.");
                  return { number, parts: plans };
                }),
              }),
            };
          if (!call.system.startsWith("Compare a sentence"))
            throw new Error("The Source context fixture received an unexpected auxiliary call.");
          comparisons.push(call);
          return {
            text: call.system.includes("exactly three lines")
              ? `Sentence: ${row.second}\nQuote: ${row.otherQuote}\nJudgement: conflict`
              : "conflict",
          };
        },
      },
    );
    const setup = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-30T12:00:00.000Z").now,
    });
    const { settings } = await setup.core.getLibrary();
    await setup.core.saveLibrarySettings({ ...settings, automatic: false });
    await setup.core.updateSettings({ user: { language: row.language } });
    const folderA = await createTempDataFolder();
    const folderB = await createTempDataFolder();
    const pathA = await writeSourceFile(
      folderA,
      `${row.title}.md`,
      `${row.firstQuote}\n\n${row.secondQuote}`,
    );
    const pathB = await writeSourceFile(
      folderB,
      `${row.title}.md`,
      `${row.firstQuote}\n\n${row.otherQuote}\n\n${row.context}`,
    );
    const otherPaths = twoPrefixes
      ? [
          await writeSourceFile(folderA, `${secondTitle}.md`, row.secondQuote),
          await writeSourceFile(
            folderB,
            `${secondTitle}.md`,
            `${row.otherQuote}\n\n${row.context}`,
          ),
        ]
      : [];
    const [documentA, documentB, documentC, documentD] = await addAndProcess(setup.core, [
      pathA,
      pathB,
      ...otherPaths,
    ]);
    if (!documentA || !documentB || (twoPrefixes && (!documentC || !documentD)))
      throw new Error("The actual same-title Sources are required.");
    const wall =
      row.mode === "moved-behind-wall" || row.mode === "same-wall"
        ? await setup.core.createLibraryGroup({ name: "Client register", description: "" })
        : null;
    if (row.mode === "same-wall" && wall) {
      await setup.core.assignDocumentGroup(documentA.id, wall.id);
      await setup.core.assignDocumentGroup(documentB.id, wall.id);
      await setup.core.updateLibraryGroup(wall.id, {
        name: wall.name,
        description: "",
        keepInside: true,
      });
    }
    const mind =
      row.mode === "same-wall" && wall
        ? await setup.core.createMind({ title: "Inside register", folderId: wall.id })
        : setup.mind;
    const client =
      row.mode === "same-wall" ? await connectToMind(setup.core, mind.id) : setup.client;
    const blockId = "shared-source-context";
    writeMind(client, [
      { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: claim }] },
    ]);
    setMindScope(client.doc, {
      folderIds: [],
      tagIds: [],
      documentIds: [
        documentA.id,
        documentB.id,
        ...[documentC, documentD].flatMap((item) => (item ? [item.id] : [])),
      ],
    });
    await client.settled();
    await setup.core.findMindClaims({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      mode: "all",
    });
    const check = () =>
      setup.core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId, offset: 0 },
        to: { blockId, offset: claim.length },
      });
    await check();
    await client.settled();
    const [marked] = markedSentences(client.blocks);
    if (!marked?.check.parts) throw new Error("The initial whole Check has no canonical parts.");
    client.doc.transact(() =>
      markSentence(
        marked.element,
        marked.from,
        marked.to,
        checkWithParts(
          marked.check,
          marked.check.parts?.map((part) =>
            part.facet?.kind === "source"
              ? {
                  ...part,
                  facet: {
                    ...part.facet,
                    selectedDocumentId:
                      claim.slice(part.span.start, part.span.end) === secondPrefix
                        ? documentC?.id
                        : documentA.id,
                  },
                }
              : part,
          ) ?? [],
        ),
      ),
    );
    await client.settled();
    expect(
      markedSentences(client.blocks)[0]?.check.parts?.filter(
        (part) => part.facet?.kind === "source",
      ),
    ).toHaveLength(twoPrefixes ? 2 : 1);
    expect(
      markedSentences(client.blocks)[0]?.check.parts?.find((part) => part.facet?.kind === "source")
        ?.facet,
    ).toMatchObject({ kind: "source", selectedDocumentId: documentA.id });
    if (row.mode === "outside-scope") {
      setMindScope(client.doc, { folderIds: [], tagIds: [], documentIds: [documentB.id] });
      await client.settled();
    } else if (row.mode === "renamed") {
      await setup.core.renameDocument(
        documentA.id,
        row.language === "en" ? "Other register" : "其他登记册",
      );
    } else if (row.mode === "deleted") {
      await setup.core.deleteDocument(documentA.id);
    } else if (row.mode === "moved-behind-wall" && wall) {
      await setup.core.assignDocumentGroup(documentA.id, wall.id);
      await setup.core.updateLibraryGroup(wall.id, {
        name: wall.name,
        description: "",
        keepInside: true,
      });
    }
    frames.length = 0;
    comparisons.length = 0;
    const generated = model.doGenerateCalls.length;
    const checked = await check();
    await client.settled();
    const saved = markedSentences(client.blocks)[0]?.check;
    const firstFrames = frames.filter((call) => sentenceOf(call) === row.first);
    const laterFrames = frames.filter((call) => sentenceOf(call) === row.second);
    console.info(
      JSON.stringify({
        language: row.language,
        mode: row.mode,
        chosen: documentA.id,
        other: documentB.id,
        streams: frames.length,
        generated: model.doGenerateCalls.length - generated,
        confirmations: comparisons.length,
        parts: saved?.parts,
        firstPrompt: firstFrames[0]?.prompt,
        laterFrames: laterFrames.map(({ prompt, results }) => ({ prompt, results })),
      }),
    );
    expect(checked).toMatchObject({ kind: "checked", checked: 1 });
    expect(firstFrames).toHaveLength(3);
    expect(laterFrames).toHaveLength(3);
    const firstCall = firstFrames[0];
    if (!firstCall) throw new Error("The first ordinary Run was not requested.");
    expect(offeredSources(firstCall)).toHaveLength(twoPrefixes ? 2 : 1);
    expect(offeredSources(laterFrames[0] ?? firstCall)).toHaveLength(0);
    if (stale) {
      expect(frames.every((call) => !call.prompt.includes(documentA.id))).toBe(true);
      expect(
        saved?.parts
          ?.filter((part) => !part.facet)
          .flatMap((part) => part.evidence.map((citation) => citation.documentId)),
      ).toEqual([documentB.id, documentB.id]);
      if (row.mode === "moved-behind-wall") {
        expect(saved?.parts?.find((part) => part.facet)?.verdict).not.toBe("supported");
        expect(saved?.state).not.toBe("supported");
        return;
      }
      expect(saved?.parts?.find((part) => part.facet)?.facet).not.toHaveProperty(
        "selectedDocumentId",
      );
      expect(saved?.parts?.find((part) => part.facet)?.verdict).toBe("unsupported");
      expect(
        saved?.parts
          ?.filter((part) => !part.facet)
          .flatMap((part) => part.evidence.map((citation) => citation.documentId)),
      ).toEqual([documentB.id, documentB.id]);
      expect(saved?.state).not.toBe("supported");
      return;
    }
    expect
      .soft(visibleSources(firstCall).find((part) => part.text === row.prefix)?.document)
      .toBe(documentA.id);
    expect.soft(laterFrames[0]?.prompt).toContain(twoPrefixes ? documentC?.id : documentA.id);
    expect.soft(model.doGenerateCalls.length - generated).toBe(0);
    expect
      .soft(saved?.parts?.filter((part) => !part.facet).map((part) => part.verdict))
      .toEqual(["supported", "supported"]);
    expect
      .soft(
        saved?.parts
          ?.filter((part) => !part.facet)
          .flatMap((part) => part.evidence.map((citation) => citation.documentId)),
      )
      .toEqual([documentA.id, twoPrefixes ? documentC?.id : documentA.id]);
    expect(saved?.parts?.filter((part) => part.facet)).toHaveLength(twoPrefixes ? 2 : 1);
    expect(saved?.state).toBe("supported");
  });
});
