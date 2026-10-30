import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readFigures } from "../../src/shared/figures";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const CLAIM = "The lease has no break clause.";
const CLAUSE = "Either party may end this lease with 30 days' notice.";

function absenceModel(verdict: "supported" | "contradicted", wholeReads: number[]) {
  return scriptedModel(
    (call) => checkReply(call, { [CLAIM]: { verdict: "supported", absence: true } }),
    {
      generate: (call) => {
        if (call.system.startsWith("Read the whole Documents")) {
          wholeReads.push(1);
          if (verdict === "supported") return { text: JSON.stringify({ verdict }) };
          const passage = /id="([^"]+)"/.exec(call.prompt)?.[1];
          return { text: JSON.stringify({ verdict, passage, quote: CLAUSE }) };
        }
        return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
      },
    },
  );
}

const TERM = "The lease runs for three years.";
const LEASE = {
  name: "Lease.pdf",
  contents: buildPdf([{ lines: ["Term", TERM] }, { lines: ["Break clause", CLAUSE] }]),
};

/**
 * A check of `claim` that searches, cites the lease's term and writes `fields` below its Supported
 * verdict, or `fields` alone when they are a JSON reply. Asked anything else but the whole read, it
 * gives `fields` too; each request is kept in `requests`.
 */
function leaseModel(claim: string, fields: string, wholeReads: number[], requests: string[] = []) {
  const plan = { verdict: "supported", quote: TERM } as const;
  return scriptedModel(
    (call) => {
      requests.push(call.system);
      const scripted = checkReply(call, { [claim]: plan });
      if (!("text" in scripted)) return scripted;
      return { text: fields.startsWith("{") ? fields : `Verdict: supported\n${fields}` };
    },
    {
      generate: (call) => {
        requests.push(call.system);
        if (!call.system.startsWith("Read the whole Documents")) {
          return call.system.startsWith("You sort the sentences")
            ? checkGenerate({ [claim]: plan })(call)
            : { text: fields };
        }
        wholeReads.push(1);
        const passage = /id="([^"]+)"/.exec(call.prompt)?.[1];
        return { text: JSON.stringify({ verdict: "contradicted", passage, quote: CLAUSE }) };
      },
    },
  );
}

describe("Checking an absence sentence", () => {
  test("a true absence is Supported only after the whole Document is read, with its pages kept", async () => {
    const wholeReads: number[] = [];
    const { core, documents } = await setUpWithDocuments(absenceModel("supported", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Rent", "The tenant pays rent monthly."] },
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "supported", evidence: null });
    expect(result.readDocuments?.[0]).toMatchObject({
      documentId: documents[0]?.id,
      locations: [
        { kind: "page", from: 1, to: 1 },
        { kind: "page", from: 2, to: 2 },
      ],
    });
    expect(wholeReads).toHaveLength(1);
  });

  test("a failed re-check clears the earlier whole-read Locations", async () => {
    let wholeReply = JSON.stringify({ verdict: "supported" });
    const model = scriptedModel(
      (call) => checkReply(call, { [CLAIM]: { verdict: "supported", absence: true } }),
      {
        generate: (call) => {
          if (call.system.startsWith("Read the whole Documents")) return { text: wholeReply };
          return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
        },
      },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Lease.pdf",
        contents: buildPdf([{ lines: ["Term", "The lease runs for three years."] }]),
      },
    ]);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: CLAIM }] },
    ]);
    await client.settled();
    const check = () =>
      core.checkSentences({
        requestId: randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId: "one", offset: 0 },
        to: { blockId: "one", offset: CLAIM.length },
      });

    await check();
    await client.settled();
    expect(claimSpans(readMind(client))[0]?.check.readDocuments).toHaveLength(1);

    wholeReply = "not JSON";
    await check();
    await client.settled();
    expect(claimSpans(readMind(client))[0]?.check).toMatchObject({
      state: "not-checked",
      reason: "malformed",
    });
    expect(claimSpans(readMind(client))[0]?.check.readDocuments).toEqual([]);
  });

  test("a sentence with a saved figure still needs the whole read before Supported", async () => {
    const claim = "The company never disclosed the $5 million loan.";
    const quote = "The company disclosed a $5 million loan on 14 May 2026.";
    const reading = readFigures("$5 million", { language: "en" })[0];
    if (!reading) throw new Error("The absence fixture has no figure.");
    const wholeReads: number[] = [];
    const model = scriptedModel(
      (call) => checkReply(call, { [claim]: { verdict: "supported", absence: true, quote } }),
      {
        generate: (call) => {
          if (call.system.startsWith("Read the whole Documents")) {
            wholeReads.push(1);
            return { text: JSON.stringify({ verdict: "supported" }) };
          }
          return checkGenerate({ [claim]: { verdict: "supported", absence: true, quote } })(call);
        },
      },
    );
    const { core } = await setUpWithDocuments(model, [
      { name: "Disclosures.pdf", contents: buildPdf([{ lines: [quote] }]) },
    ]);

    const result = await core.checkClaim({
      claim,
      figures: [
        {
          id: "loan",
          locator: {
            kind: "text",
            from: { blockId: "p", offset: 0 },
            to: { blockId: "p", offset: 1 },
          },
          reading,
          calculated: null,
        },
      ],
    });

    expect(result).toMatchObject({ verdict: "supported" });
    expect(result.readDocuments).toHaveLength(1);
    expect(wholeReads).toHaveLength(1);
  });

  test("a scan with an unreadable page has nothing to search: Unsupported, with nothing sent", async () => {
    const wholeReads: number[] = [];
    const requests: string[] = [];
    const scan = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
    const textRecognition = createFakeTextRecognizer({
      script: {
        pages: {
          "1": { lines: ["The lease runs for three years."] },
          "2": { fail: "Unreadable page" },
        },
      },
    });
    const { core } = await setUpWithDocuments(
      leaseModel(CLAIM, "Absence: yes", wholeReads, requests),
      [{ name: "Lease.pdf", contents: buildPdf([{ scan }, { scan }]) }],
      { textRecognizer: textRecognition },
    );

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "unsupported", evidence: null });
    expect(requests.filter((system) => system.startsWith("You check one sentence"))).toEqual([]);
    expect(wholeReads).toHaveLength(0);
  });

  test("an unreadable PDF beside a readable one makes the scope Not checked, never Supported", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("supported", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf([{ lines: ["The lease runs for three years."] }]),
      },
      { name: "Broken.pdf", contents: "Not a PDF" },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "absence-read-limit" });
    expect(wholeReads).toHaveLength(0);
  });

  test("a false absence is Contradicted with the clause found by the whole read", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("contradicted", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Break clause", CLAUSE] },
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { quote: CLAUSE, check: "found", pageFrom: 2, pageTo: 2 },
    });
    expect(result.readDocuments?.[0]?.locations).toHaveLength(2);
    expect(wholeReads).toHaveLength(1);
  });

  test("an invalid whole-read Passage never falls back to the search's Citation", async () => {
    const wholeReads: number[] = [];
    const model = scriptedModel(
      (call) =>
        checkReply(call, {
          [CLAIM]: {
            verdict: "supported",
            absence: true,
            quote: "The lease runs for three years.",
          },
        }),
      {
        generate: (call) => {
          if (call.system.startsWith("Read the whole Documents")) {
            wholeReads.push(1);
            return {
              text: JSON.stringify({ verdict: "contradicted", passage: "P999", quote: CLAUSE }),
            };
          }
          return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
        },
      },
    );
    const { core } = await setUpWithDocuments(model, [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Break clause", CLAUSE] },
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(wholeReads).toHaveLength(1);
  });

  test.each<{ name: string; reply: string; shown: "whole read" | "search" | "not checked" }>([
    { name: "Absence: yes", reply: "Absence: yes", shown: "whole read" },
    { name: "Absence: **Yes.**", reply: "Absence: **Yes.**", shown: "whole read" },
    {
      name: "asserts_absence true",
      reply: '{"verdict":"supported","asserts_absence":true}',
      shown: "whole read",
    },
    { name: "Absence: no", reply: "Absence: no", shown: "search" },
    {
      name: "asserts_absence false",
      reply: '{"verdict":"supported","asserts_absence":false}',
      shown: "search",
    },
    {
      name: "a line that corrects itself",
      reply: "Absence: No. Wait, yes: it asserts the clause is absent.",
      shown: "not checked",
    },
    { name: "缺失：是", reply: "缺失：是", shown: "whole read" },
    { name: "缺失：否", reply: "缺失：否", shown: "search" },
    { name: "missing Absence line", reply: "", shown: "not checked" },
    {
      name: "JSON with no asserts_absence",
      reply: '{"verdict":"supported"}',
      shown: "not checked",
    },
    { name: "Absence: true", reply: "Absence: true", shown: "not checked" },
    { name: "no and yes on one line", reply: "Absence: no yes", shown: "not checked" },
    { name: "two lines that disagree", reply: "Absence: no\nAbsence: yes", shown: "not checked" },
    {
      name: "a field that corrects itself",
      reply: '{"verdict":"supported","asserts_absence":"no, wait, yes"}',
      shown: "not checked",
    },
  ])(
    "the judge's $name decides whether search alone may support an absence",
    async ({ reply, shown }) => {
      const wholeReads: number[] = [];
      const { core } = await setUpWithDocuments(leaseModel(CLAIM, reply, wholeReads), [LEASE]);

      const result = await core.checkClaim({ claim: CLAIM });

      if (shown === "whole read") {
        expect(result).toMatchObject({
          verdict: "contradicted",
          evidence: { quote: CLAUSE, check: "found", pageFrom: 2, pageTo: 2 },
        });
        expect(wholeReads).toHaveLength(1);
      } else if (shown === "search") {
        expect(result).toMatchObject({ verdict: "supported", evidence: { quote: TERM } });
        expect(wholeReads).toHaveLength(0);
      } else {
        expect(result).toMatchObject({ verdict: "not-checked", reason: "malformed" });
        expect(wholeReads).toHaveLength(0);
      }
    },
  );

  test.each([
    { name: "no Absence line", field: "" },
    ...[
      "Absence: The sentence does not assert an absence.",
      "Absence: **Answer:** no",
      "Absence: nope",
      "Absence: true",
      "Absence: No. Wait, yes: it asserts the clause is absent.",
    ].map((field) => ({ name: `“${field}”`, field })),
  ])(
    "an ordinary sentence whose reply has $name is Not checked, never sent to the whole read",
    async ({ field }) => {
      const wholeReads: number[] = [];
      const { core } = await setUpWithDocuments(leaseModel(TERM, field, wholeReads), [LEASE]);

      const result = await core.checkClaim({ claim: TERM });

      expect(result).toMatchObject({ verdict: "not-checked", reason: "malformed" });
      expect(result.readDocuments).toBeUndefined();
      expect(wholeReads).toHaveLength(0);
    },
  );

  test("a plain Supported fact takes three model requests: search, cite and verdict", async () => {
    const requests: string[] = [];
    const { core } = await setUpWithDocuments(leaseModel(TERM, "Absence: no", [], requests), [
      LEASE,
    ]);

    const result = await core.checkClaim({ claim: TERM });

    expect(result).toMatchObject({ verdict: "supported", evidence: { quote: TERM } });
    // Processing the Document asks for its Tags; that request is no part of the check.
    expect(requests.filter((system) => !system.startsWith("You sort Documents"))).toHaveLength(3);
  });

  test("a clause the search found contradicts an absence on a scope too long to read whole", async () => {
    const wholeReads: number[] = [];
    const plan = { verdict: "contradicted", absence: true, quote: CLAUSE } as const;
    const model = scriptedModel((call) => checkReply(call, { [CLAIM]: plan }), {
      generate: (call) => {
        if (call.system.startsWith("Read the whole Documents")) wholeReads.push(1);
        return checkGenerate({ [CLAIM]: plan })(call);
      },
    });
    const { core } = await setUpWithDocuments(model, [
      {
        name: "Lease.pdf",
        contents: buildPdf([
          { lines: ["Term", "The lease runs for three years."] },
          { lines: ["Break clause", CLAUSE] },
          ...Array.from({ length: 39 }, (_, index) => ({
            lines: [`Schedule ${index + 1}`, "Rent schedule"],
          })),
        ]),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { quote: CLAUSE, check: "found", pageFrom: 2, pageTo: 2 },
    });
    expect(wholeReads).toHaveLength(0);
  });

  test("a figure the search found contradicts an absence on a scope too long to read whole", async () => {
    const claim = "The company never disclosed the $5 million loan.";
    const quote = "The company disclosed a $5 million loan on 14 May 2026.";
    const reading = readFigures("$5 million", { language: "en" })[0];
    if (!reading) throw new Error("The absence fixture has no figure.");
    const wholeReads: number[] = [];
    const plan = { verdict: "contradicted", absence: true, quote } as const;
    const model = scriptedModel((call) => checkReply(call, { [claim]: plan }), {
      generate: (call) => {
        if (call.system.startsWith("Read the whole Documents")) wholeReads.push(1);
        return checkGenerate({ [claim]: plan })(call);
      },
    });
    const { core } = await setUpWithDocuments(model, [
      {
        name: "Disclosures.pdf",
        contents: buildPdf([
          { lines: ["Loans", quote] },
          ...Array.from({ length: 40 }, (_, index) => ({
            lines: [`Schedule ${index + 1}`, "Rent schedule"],
          })),
        ]),
      },
    ]);

    const result = await core.checkClaim({
      claim,
      figures: [
        {
          id: "loan",
          locator: {
            kind: "text",
            from: { blockId: "p", offset: 0 },
            to: { blockId: "p", offset: 1 },
          },
          reading,
          calculated: null,
        },
      ],
    });

    expect(result).toMatchObject({ verdict: "contradicted" });
    expect(wholeReads).toHaveLength(0);
  });

  test("a scope over 40 pages is Not checked instead of guessed from search results", async () => {
    const wholeReads: number[] = [];
    const { core } = await setUpWithDocuments(absenceModel("supported", wholeReads), [
      {
        name: "Lease.pdf",
        contents: buildPdf(
          Array.from({ length: 41 }, (_, index) => ({
            lines: [`Page ${index + 1}`, "Rent schedule"],
          })),
        ),
      },
    ]);

    const result = await core.checkClaim({ claim: CLAIM });

    expect(result).toMatchObject({ verdict: "not-checked", reason: "absence-read-limit" });
    expect(wholeReads).toHaveLength(0);
  });
});

describe("Checking an absence sentence with a figure in a Note", () => {
  const cases = [
    {
      language: "en" as const,
      claim: "The company never disclosed the $5 million loan.",
      quote: "The company disclosed a $5 million loan on 14 May 2026.",
    },
    {
      language: "zh-CN" as const,
      claim: "公司从未披露这笔 500 万元的贷款。",
      quote: "公司于 2026 年 5 月 14 日披露了一笔 500 万元的贷款。",
    },
  ];

  async function checkedInNote(
    each: (typeof cases)[number],
    absence: boolean,
    whole: "supported" | "contradicted",
  ) {
    const wholeReads: number[] = [];
    const plan = { verdict: "supported", absence, quote: each.quote } as const;
    const model = scriptedModel((call) => checkReply(call, { [each.claim]: plan }), {
      generate: (call) => {
        if (call.system.startsWith("Read the whole Documents")) {
          wholeReads.push(1);
          if (whole === "supported") return { text: JSON.stringify({ verdict: whole }) };
          const passage = /id="([^"]+)"/.exec(call.prompt)?.[1];
          return { text: JSON.stringify({ verdict: whole, passage, quote: each.quote }) };
        }
        return checkGenerate({ [each.claim]: plan })(call);
      },
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Disclosures.md", contents: `# Disclosures\n\n${each.quote}\n` },
    ]);
    if (each.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
    writeMind(client, [
      { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: each.claim }] },
    ]);
    await client.settled();
    await core.checkSentences({
      requestId: randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "one", offset: 0 },
      to: { blockId: "one", offset: each.claim.length },
    });
    await client.settled();
    const check = claimSpans(readMind(client))[0]?.check;
    return { check, wholeReads };
  }

  test.each(cases)(
    "$language: the whole read's verdict decides the sentence and each of its figures",
    async (each) => {
      const supported = await checkedInNote(each, true, "supported");
      expect(supported.wholeReads).toHaveLength(1);
      expect(supported.check).toMatchObject({ state: "supported" });
      expect(supported.check?.readDocuments).toHaveLength(1);
      expect(supported.check?.figures?.length).toBeGreaterThan(0);
      expect(supported.check?.figures?.map((figure) => figure.state)).toEqual(
        supported.check?.figures?.map(() => "supported"),
      );

      const contradicted = await checkedInNote(each, true, "contradicted");
      expect(contradicted.wholeReads).toHaveLength(1);
      expect(contradicted.check).toMatchObject({
        state: "contradicted",
        evidence: { quote: each.quote, check: "found" },
      });
      expect(contradicted.check?.figures?.length).toBeGreaterThan(0);
      expect(contradicted.check?.figures?.map((figure) => figure.state)).toEqual(
        contradicted.check?.figures?.map(() => "contradicted"),
      );
    },
  );

  test.each(cases)(
    "$language: without the absence answer, each figure keeps its own result from the search",
    async (each) => {
      const { check, wholeReads } = await checkedInNote(each, false, "supported");
      expect(wholeReads).toHaveLength(0);
      expect(check).toMatchObject({ state: "supported" });
      expect(check?.readDocuments ?? []).toEqual([]);
      expect(check?.figures?.length).toBeGreaterThan(0);
      for (const figure of check?.figures ?? []) {
        expect(figure).toMatchObject({ state: "supported", source: { check: "found" } });
      }
    },
  );
});
