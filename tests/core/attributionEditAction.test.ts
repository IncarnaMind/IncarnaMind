import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { EditWithAiInput } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { formatClaimFacetPeriod } from "../../src/shared/dates";
import { pendingProposals, proposalRequestOf } from "../../src/shared/proposals";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const PERIOD = { start: "2024-03-01", end: "2024-03-31", precision: "month" } as const;
interface Scenario {
  language: Language;
  kind: "source" | "time";
  qualifier: string;
  name: string;
  named: string;
  fact: string;
  claim: string;
  quote: string;
  corrected: string;
  namedDocument?: boolean;
}
const CASES = [
  {
    language: "en",
    kind: "source",
    qualifier: "According to Residents",
    name: "Register",
    named: "Residents",
    fact: "Nora lives in Oslo.",
    claim: "According to Residents, Nora lives in Oslo.",
    quote: "Nora lives in Oslo.",
    corrected: "According to Register[1], Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    kind: "source",
    qualifier: "根据旧名册",
    name: "居民登记",
    named: "旧名册",
    fact: "诺拉住在奥斯陆。",
    claim: "根据旧名册，诺拉住在奥斯陆。",
    quote: "诺拉住在奥斯陆。",
    corrected: "根据居民登记[1]，诺拉住在奥斯陆。",
  },
  {
    language: "en",
    kind: "time",
    qualifier: "Currently",
    name: "Facility letter",
    named: "",
    fact: "the branch with a public entrance at the eastern side of the building is open.",
    claim:
      "Currently, the branch with a public entrance at the eastern side of the building is open.",
    quote:
      "As at March 2024, the branch with a public entrance at the eastern side of the building was open.",
    corrected:
      "In March 2024[1], the branch with a public entrance at the eastern side of the building was open.",
  },
  {
    language: "zh-CN",
    kind: "time",
    qualifier: "目前",
    name: "分行通知",
    named: "",
    fact: "位于大楼东侧、设有公共入口的分行对外营业。",
    claim: "目前，位于大楼东侧、设有公共入口的分行对外营业。",
    quote: "截至2024年3月，位于大楼东侧、设有公共入口的分行对外营业。",
    corrected: "2024年3月[1]，位于大楼东侧、设有公共入口的分行对外营业。",
  },
] as const;

const WRONG_YEAR: readonly Scenario[] = [
  {
    language: "en",
    kind: "source",
    qualifier: "According to the 2024 report",
    name: "2023 report",
    named: "2024 report",
    namedDocument: false,
    fact: "Nora lives in Oslo.",
    claim: "According to the 2024 report, Nora lives in Oslo.",
    quote: "Nora lives in Oslo.",
    corrected: "According to the 2023 report[1], Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    kind: "source",
    qualifier: "根据2024年报告",
    name: "2023年报告",
    named: "2024年报告",
    namedDocument: false,
    fact: "诺拉住在奥斯陆。",
    claim: "根据2024年报告，诺拉住在奥斯陆。",
    quote: "诺拉住在奥斯陆。",
    corrected: "根据2023年报告[1]，诺拉住在奥斯陆。",
  },
];

async function checkedNote(row: Scenario) {
  const edits: ModelCall[] = [];
  let editReply: string = row.corrected;
  let beforeReply: (() => Promise<void>) | undefined;
  let includeFacet = true;
  const model = scriptedModel((call) => {
    if (call.system.startsWith("You edit a passage")) {
      edits.push(call);
      return {
        text: editReply,
        ...(beforeReply && { pause: { after: 0, until: beforeReply() } }),
      };
    }
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched)
      return {
        text: `Parts: ${JSON.stringify([
          { kind: "fact", text: row.qualifier, facet: { kind: row.kind } },
          { kind: "fact", text: row.fact },
        ])}`,
        calls: [{ tool: "search_documents", input: { query: row.fact } }],
      };
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = shownPassages(searched.text).find((each) => each.text.includes(row.quote));
      if (!passage) throw new Error("The check did not find the actual fixture quote.");
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
          },
        ],
      };
    }
    return {
      text: [
        "Verdict: supported",
        "Scope: none, same",
        "Topic: found",
        "Absence: no",
        "Roles: none, same",
        "Calculation: none",
        "Evidence: [1]",
        `${row.quote} [^1]`,
        ...(includeFacet
          ? [
              `Facets: ${JSON.stringify({
                items: [
                  {
                    text: row.qualifier,
                    kind: row.kind,
                    occurrence: 1,
                    verdict: "supported",
                    scope: "same",
                    topic: "found",
                    roles: "same",
                    says: row.quote,
                    evidence: [1],
                    ...(row.kind === "source"
                      ? { sourceName: row.named }
                      : { time: "present", period: PERIOD }),
                  },
                ],
              })}`,
            ]
          : []),
      ].join("\n"),
    };
  });
  const setup = await setUpWithDocuments(model, [], {
    now: manualClock("2026-10-29T12:00:00.000Z").now,
  });
  const { core, client, mind } = setup;
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  await core.updateSettings({ user: { language: row.language } });
  const folder = await createTempDataFolder();
  const files = [
    await writeSourceFile(folder, `${row.name}.md`, `# ${row.name}\n\n${row.quote}\n`),
  ];
  if (row.kind === "source" && row.namedDocument !== false)
    files.push(
      await writeSourceFile(
        folder,
        `${row.named}.md`,
        `# ${row.named}\n\nNo address is recorded.\n`,
      ),
    );
  const documents = await addAndProcess(core, files);
  const blockId = randomUUID();
  writeMind(client, [
    { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: row.claim }] },
  ]);
  await client.settled();
  const beforeCheck = model.doStreamCalls.length + model.doGenerateCalls.length;
  expect(
    await core.checkSentences({
      requestId: randomUUID(),
      mindId: mind.id,
      from: { blockId, offset: 0 },
      to: { blockId, offset: row.claim.length },
      action: "check-against-documents",
    }),
  ).toMatchObject({ kind: "checked", sentences: 1 });
  await client.settled();
  expect(model.doStreamCalls.length + model.doGenerateCalls.length - beforeCheck).toBe(3);
  const owners = claimSpans(readMind(client));
  expect(owners).toHaveLength(1);
  const owner = owners[0];
  const part = owner?.check.parts?.find((each) => each.facet?.kind === row.kind);
  const receipt = part?.evidence[0];
  if (!owner || !part || !receipt)
    throw new Error("The checked Note did not retain its actual facet receipt.");
  expect(owner.check.parts).toHaveLength(2);
  expect(receipt).toMatchObject({
    id: expect.any(String),
    documentId: documents[0]?.id,
    quote: row.quote,
    check: "found",
  });
  let instruction = `Use ${receipt.documentName} as the attribution and keep all facts unchanged.`;
  if (row.kind === "time") {
    const period = part.facet?.kind === "time" ? part.facet.period : null;
    if (!period) throw new Error("The checked time row has no actual Source period.");
    instruction = `State ${formatClaimFacetPeriod(period, row.language)} and adjust the tense, keeping all facts unchanged.`;
  }
  const input: EditWithAiInput = {
    requestId: randomUUID(),
    mindId: mind.id,
    from: { blockId, offset: 0 },
    to: { blockId, offset: row.claim.length },
    text: row.claim,
    action: "follow-citation",
    instruction,
    part: { id: owner.check.id, span: part.span },
  };
  return {
    ...setup,
    edits,
    model,
    input,
    receipt,
    row,
    beforeEditReply(run: () => Promise<void>) {
      beforeReply = run;
    },
    omitFacetReply() {
      includeFacet = false;
    },
    useEditReply(text: string) {
      editReply = text;
    },
  };
}

test.each([...CASES, ...WRONG_YEAR])(
  "$language $kind corrects the full Note with only its real row receipt",
  async (row) => {
    const { core, client, model, edits, input, receipt, mind } = await checkedNote(row);
    const before = model.doStreamCalls.length + model.doGenerateCalls.length;
    const untrusted = "Use the wrong UI source and anchor this to 2099.";
    const result = await core.editWithAi({ ...input, instruction: untrusted });
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") throw new Error("The targeted correction was not proposed.");
    await client.settled();
    expect(model.doStreamCalls.length + model.doGenerateCalls.length - before).toBe(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.prompt).not.toContain(untrusted);
    const canonical =
      row.kind === "source" ? receipt.documentName : formatClaimFacetPeriod(PERIOD, "en");
    if (canonical === null) throw new Error("The actual Source has no name.");
    expect(edits[0]?.prompt).toContain(canonical);
    expect(edits[0]?.prompt).toContain(`[1] “${row.quote}”`);
    expect(edits[0]?.prompt).not.toContain("[2]");
    expect(proposalRequestOf(client.doc, result.request)).toMatchObject({
      part: input.part,
      instruction: expect.stringContaining(canonical),
    });
    const reopened = await connectToMind(core, mind.id);
    expect(proposalRequestOf(reopened.doc, result.request)).toMatchObject({ part: input.part });
    await resolveChanges(client, "accept");
    expect(readMind(client).textContent).toBe(row.corrected.replace("[1]", ""));
    const citations: Record<string, unknown>[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name === "citation") citations.push(node.attrs);
    });
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ ...receipt, id: expect.any(String) });
    expect(citations[0]?.id).not.toBe(receipt.id);
  },
);

test("targeted regeneration refuses a sibling proposal without spending or changing the Note", async () => {
  const { core, client, model, input } = await checkedNote(CASES[2]);
  expect((await core.editWithAi(input)).kind).toBe("proposed");
  await client.settled();
  const pending = pendingProposals(client.blocks);
  expect(pending.length).toBeGreaterThan(1);
  const first = pending[0];
  if (!first) throw new Error("The correction has no Proposal.");
  const original = readMind(client).toJSON();
  const calls = model.doStreamCalls.length + model.doGenerateCalls.length;
  expect(
    await core.regenerateProposal({
      requestId: randomUUID(),
      mindId: input.mindId,
      proposalId: first.id,
    }),
  ).toEqual({ kind: "has-proposals" });
  await client.settled();
  expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBe(calls);
  expect(readMind(client).toJSON()).toEqual(original);
});

test("a renamed Source supplies live wording without rewriting the stored Citation version", async () => {
  const setup = await checkedNote(CASES[0]);
  const { core, client, receipt, input, edits } = setup;
  if (!receipt.documentId) throw new Error("The actual Source has no id.");
  await core.renameDocument(receipt.documentId, "Current register");
  setup.useEditReply("According to Current register[1], Nora lives in Oslo.");
  const result = await core.editWithAi({ ...input, instruction: "Use an outdated UI name." });
  expect(result.kind).toBe("proposed");
  expect(edits[0]?.prompt).toContain('"Current register"');
  expect(edits[0]?.prompt).not.toContain('"Register"');
  expect(edits[0]?.prompt).not.toContain("Use an outdated UI name.");
  await client.settled();
  await resolveChanges(client, "accept");
  expect(readMind(client).textContent).toBe("According to Current register, Nora lives in Oslo.");
  const citations: Record<string, unknown>[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "citation") citations.push(node.attrs);
  });
  expect(citations).toHaveLength(1);
  expect(citations[0]).toMatchObject({ ...receipt, id: expect.any(String) });
});

test("a Source renamed during the edit cannot apply stale attribution wording", async () => {
  const setup = await checkedNote(CASES[0]);
  const { core, client, receipt, input } = setup;
  const original = readMind(client).toJSON();
  setup.beforeEditReply(async () => {
    if (!receipt.documentId) throw new Error("The Source has no id.");
    await core.renameDocument(receipt.documentId, "Renamed during edit");
  });
  expect(await core.editWithAi(input)).toEqual({ kind: "changed" });
  await client.settled();
  expect(pendingProposals(client.blocks)).toEqual([]);
  expect(readMind(client).toJSON()).toEqual(original);
});

test("a full-owner target keeps a physical Citation after the sentence", async () => {
  const { core, client, input, receipt } = await checkedNote(CASES[0]);
  const block = readMind(client).child(0).toJSON();
  writeMind(client, [
    {
      ...block,
      content: [
        ...(block.content ?? []),
        { type: "text", text: " " },
        { type: "citation", attrs: receipt },
      ],
    },
  ]);
  await client.settled();
  const result = await core.editWithAi({
    ...input,
    requestId: randomUUID(),
    text: `${input.text} \uFFFC`,
    to: { ...input.to, offset: input.to.offset + 2 },
  });
  expect(result.kind).toBe("proposed");
  await client.settled();
  await resolveChanges(client, "accept");
  const citations: Record<string, unknown>[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "citation") citations.push(node.attrs);
  });
  expect(citations).toHaveLength(1);
  expect(citations[0]).toMatchObject(receipt);
});

test("a targeted single change regenerates from its stored row after reopening", async () => {
  const { core, client, model, input } = await checkedNote(CASES[0]);
  expect((await core.editWithAi(input)).kind).toBe("proposed");
  await client.settled();
  const pending = pendingProposals(client.blocks);
  expect(pending).toHaveLength(1);
  const first = pending[0];
  if (!first) throw new Error("The correction has no Proposal.");
  const reopened = await connectToMind(core, input.mindId);
  expect(proposalRequestOf(reopened.doc, first.request)).toMatchObject({ part: input.part });
  const before = model.doStreamCalls.length;
  const result = await core.regenerateProposal({
    requestId: randomUUID(),
    mindId: input.mindId,
    proposalId: first.id,
  });
  expect(result.kind).toBe("proposed");
  expect(model.doStreamCalls.length - before).toBe(1);
  if (result.kind !== "proposed") throw new Error("The correction was not regenerated.");
  await client.settled();
  expect(proposalRequestOf(client.doc, result.request)).toMatchObject({ part: input.part });
});

test("stale row targets and partial owners make no edit request", async () => {
  const { core, input, model } = await checkedNote(CASES[0]);
  const calls = model.doStreamCalls.length + model.doGenerateCalls.length;
  for (const changed of [
    { ...input, part: { id: randomUUID(), span: { start: 0, end: CASES[0].qualifier.length } } },
    { ...input, part: { id: input.part?.id ?? "", span: { start: 0, end: 1 } } },
    { ...input, to: { ...input.to, offset: CASES[0].qualifier.length }, text: CASES[0].qualifier },
    { ...input, action: "improve" as const },
  ])
    await expect(core.editWithAi({ ...changed, requestId: randomUUID() })).rejects.toThrow();
  expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBe(calls);
});

test.each([CASES[0], CASES[1]])(
  "$language cannot apply the first row's target to identical words later in the same block",
  async (row) => {
    const { core, client, input, model } = await checkedNote(row);
    const block = readMind(client).child(0).toJSON();
    writeMind(client, [
      {
        ...block,
        content: [...(block.content ?? []), { type: "text", text: ` ${row.claim}` }],
      },
    ]);
    await client.settled();
    const original = readMind(client).toJSON();
    const calls = model.doStreamCalls.length + model.doGenerateCalls.length;
    const later = row.claim.length + 1;
    const outcome = await core
      .editWithAi({
        ...input,
        requestId: randomUUID(),
        from: { ...input.from, offset: later },
        to: { ...input.to, offset: later + row.claim.length },
      })
      .then(
        (result) => ({ kind: "result", result }),
        (error: unknown) => ({ kind: "rejected", error }),
      );
    await client.settled();
    expect({
      outcome: outcome.kind,
      calls: model.doStreamCalls.length + model.doGenerateCalls.length - calls,
      proposals: pendingProposals(client.blocks).length,
    }).toEqual({ outcome: "rejected", calls: 0, proposals: 0 });
    expect(readMind(client).toJSON()).toEqual(original);
  },
);

test("a row result changed during the edit cannot apply an older correction", async () => {
  const setup = await checkedNote(CASES[2]);
  const { core, client, input, edits } = setup;
  let current: unknown;
  setup.beforeEditReply(async () => {
    setup.omitFacetReply();
    await core.checkSentences({
      requestId: randomUUID(),
      mindId: input.mindId,
      from: input.from,
      to: input.to,
      action: "check-against-documents",
    });
    await client.settled();
    current = readMind(client).toJSON();
  });
  expect(await core.editWithAi(input)).toEqual({ kind: "changed" });
  await client.settled();
  expect(edits).toHaveLength(1);
  expect(pendingProposals(client.blocks)).toEqual([]);
  expect(readMind(client).toJSON()).toEqual(current);
});
