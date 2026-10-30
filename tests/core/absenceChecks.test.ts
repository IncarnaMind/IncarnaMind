import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readFigures } from "../../src/shared/figures";
import { checkGenerate, checkReply, requestedFigures } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
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
          return {
            text: JSON.stringify({ verdict, citations: [{ marker: 1, passage, quote: CLAUSE }] }),
          };
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
        return {
          text: JSON.stringify({
            verdict: "contradicted",
            citations: [{ marker: 1, passage, quote: CLAUSE }],
          }),
        };
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
              text: JSON.stringify({
                verdict: "contradicted",
                citations: [{ marker: 1, passage: "P999", quote: CLAUSE }],
              }),
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

describe("The whole read of an absence sentence judges the whole sentence", () => {
  interface Read {
    verdict: "supported" | "contradicted" | "unsupported";
    absent: string;
    quotes: string[];
    /** A figure's verdict and the number its quote writes, by the figure as the sentence shows it. */
    figures?: Record<string, { verdict: string; number?: string }>;
  }
  interface Case {
    claim: string;
    document: string;
    read: Read;
  }

  /** A whole read that answers as a faithful judge of the whole sentence would. */
  function wholeRead(call: { prompt: string }, read: Read): string {
    const passages = shownPassages(call.prompt);
    const citations = read.quotes.map((quote, index) => ({
      marker: index + 1,
      passage: passages.find((each) => each.text.includes(quote))?.id,
      quote,
    }));
    const judged = JSON.stringify({ verdict: read.verdict, absent: read.absent, citations });
    const asked = requestedFigures(call as Parameters<typeof requestedFigures>[0]);
    if (asked.length === 0) return judged;
    const items = asked.map(({ id, shown }) => {
      const own = read.figures?.[shown];
      const inAbsent = read.absent.includes(shown);
      const marker = read.quotes.findIndex((quote) => quote.includes(own?.number ?? shown)) + 1;
      const number = own?.number ?? (marker > 0 && !inAbsent ? shown : null);
      return {
        id,
        verdict: own?.verdict ?? (inAbsent ? read.verdict : number ? "supported" : "unsupported"),
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        reading: null,
        relation: "equals",
        source:
          number && marker > 0
            ? { citation: marker, number, reading: null, unitQuote: null }
            : null,
        calculation: null,
      };
    });
    return `${judged}\nFigures: ${JSON.stringify({ items, remainder: null })}`;
  }

  async function checkedInNote(each: Case, language: "en" | "zh-CN", absence = true) {
    const reads: { system: string; prompt: string }[] = [];
    const requests: string[] = [];
    const plan = absence
      ? ({ verdict: "unsupported", absence: true } as const)
      : ({ verdict: "supported", absence: false, quote: each.read.quotes[0] } as const);
    const model = scriptedModel(
      (call) => {
        requests.push(call.system);
        return checkReply(call, { [each.claim]: plan });
      },
      {
        generate: (call) => {
          requests.push(call.system);
          if (call.system.startsWith("Read the whole Documents")) {
            reads.push({ system: call.system, prompt: call.prompt });
            return { text: wholeRead(call, each.read) };
          }
          return checkGenerate({ [each.claim]: plan })(call);
        },
      },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Filing.md", contents: `# Filing\n\n${each.document}\n` },
    ]);
    if (language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
    writeMind(client, [
      { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: each.claim }] },
    ]);
    await client.settled();
    requests.length = 0;
    await core.checkSentences({
      requestId: randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "one", offset: 0 },
      to: { blockId: "one", offset: each.claim.length },
    });
    await client.settled();
    const check = claimSpans(readMind(client))[0]?.check;
    const figure = (shown: string) => check?.figures?.find((each) => each.reading.chars === shown);
    return { check, figure, reads, requests };
  }

  const LOAN = { en: "the $5 million loan", "zh-CN": "这笔 500 万元的贷款" };
  const MILLIONS = { en: "$5 million", "zh-CN": "500 万元" };
  const REVENUE = { en: "Revenue rose 8% in 2025.", "zh-CN": "2025 年收入增长了 8%。" };
  const languages = ["en", "zh-CN"] as const;

  test.each(languages)(
    "%s: a wrong figure beside a true absence is never Supported (Contradicted with the Document's figure)",
    async (language) => {
      const claim =
        language === "en"
          ? "The company never disclosed the $5 million loan, and revenue rose 12% in 2025."
          : "公司从未披露这笔 500 万元的贷款，且 2025 年收入增长了 12%。";
      const { check, figure, reads } = await checkedInNote(
        {
          claim,
          document: REVENUE[language],
          read: {
            verdict: "contradicted",
            absent: LOAN[language],
            quotes: [REVENUE[language]],
            figures: { "12%": { verdict: "contradicted", number: "8%" } },
          },
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check?.state).toBe("contradicted");
      expect(figure("12%")?.state).toBe("contradicted");
      expect(figure("12%")?.source).toMatchObject({ check: "found" });
      expect(figure(MILLIONS[language])?.state).not.toBe("supported");
    },
  );

  test.each(languages)(
    "%s: another fact the sentence states wrongly beside its absence is Contradicted",
    async (language) => {
      const each =
        language === "en"
          ? {
              claim: "The lease has no break clause and is governed by French law.",
              document: "This lease is governed by English law.",
              absent: "break clause",
            }
          : {
              claim: "租约没有提前解约条款，并受法国法律管辖。",
              document: "本租约受英国法律管辖。",
              absent: "提前解约条款",
            };
      const { check, reads } = await checkedInNote(
        {
          claim: each.claim,
          document: each.document,
          read: { verdict: "contradicted", absent: each.absent, quotes: [each.document] },
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check).toMatchObject({
        state: "contradicted",
        evidence: { quote: each.document, check: "found" },
      });
    },
  );

  test.each(languages)(
    "%s: a true absence with a right figure is Supported, the figure with its own source",
    async (language) => {
      const claim =
        language === "en"
          ? "The company never disclosed the $5 million loan, and revenue rose 8% in 2025."
          : "公司从未披露这笔 500 万元的贷款，且 2025 年收入增长了 8%。";
      const { check, figure, reads, requests } = await checkedInNote(
        {
          claim,
          document: REVENUE[language],
          read: { verdict: "supported", absent: LOAN[language], quotes: [REVENUE[language]] },
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check?.state).toBe("supported");
      expect(check?.readDocuments).toHaveLength(1);
      expect(figure("8%")).toMatchObject({ state: "supported", source: { check: "found" } });
      expect(figure(MILLIONS[language])?.state).toBe("supported");
      // The check's own search, cite and verdict, then the one whole read.
      expect(requests.filter((system) => !system.startsWith("You sort"))).toHaveLength(4);
    },
  );

  test.each(languages)(
    "%s: a true absence with a figure inside it is Supported, and so is the figure",
    async (language) => {
      const claim =
        language === "en"
          ? "The company never disclosed the $5 million loan."
          : "公司从未披露这笔 500 万元的贷款。";
      const { check, figure } = await checkedInNote(
        {
          claim,
          document: REVENUE[language],
          read: { verdict: "supported", absent: LOAN[language], quotes: [] },
        },
        language,
      );
      expect(check?.state).toBe("supported");
      expect(figure(MILLIONS[language])?.state).toBe("supported");
    },
  );

  test.each(languages)(
    "%s: a false absence with a figure is Contradicted, quoting what the Document holds",
    async (language) => {
      const claim =
        language === "en"
          ? "The company never disclosed the $5 million loan."
          : "公司从未披露这笔 500 万元的贷款。";
      const document =
        language === "en"
          ? "The company disclosed a $5 million loan on 14 May 2026."
          : "公司于 2026 年 5 月 14 日披露了一笔 500 万元的贷款。";
      const { check, figure } = await checkedInNote(
        {
          claim,
          document,
          read: { verdict: "contradicted", absent: LOAN[language], quotes: [document] },
        },
        language,
      );
      expect(check).toMatchObject({ state: "contradicted", evidence: { quote: document } });
      expect(figure(MILLIONS[language])?.state).toBe("contradicted");
    },
  );

  test.each(languages)(
    "%s: without the absence answer, each figure keeps its own result from the search",
    async (language) => {
      const claim =
        language === "en"
          ? "The company disclosed the $5 million loan."
          : "公司披露了这笔 500 万元的贷款。";
      const document =
        language === "en"
          ? "The company disclosed a $5 million loan on 14 May 2026."
          : "公司于 2026 年 5 月 14 日披露了一笔 500 万元的贷款。";
      const { check, figure, reads, requests } = await checkedInNote(
        {
          claim,
          document,
          read: { verdict: "supported", absent: "", quotes: [document] },
        },
        language,
        false,
      );
      expect(reads).toHaveLength(0);
      expect(check).toMatchObject({ state: "supported" });
      expect(check?.readDocuments ?? []).toEqual([]);
      expect(figure(MILLIONS[language])).toMatchObject({
        state: "supported",
        source: { check: "found" },
      });
      expect(requests.filter((system) => !system.startsWith("You sort"))).toHaveLength(3);
    },
  );

  test("the whole read is asked about the whole sentence, with its requested figures", async () => {
    const claim = "The company never disclosed the $5 million loan, and revenue rose 8% in 2025.";
    const { reads } = await checkedInNote(
      {
        claim,
        document: REVENUE.en,
        read: { verdict: "supported", absent: LOAN.en, quotes: [REVENUE.en] },
      },
      "en",
    );
    expect(reads[0]?.system).toContain("judge the whole sentence");
    expect(reads[0]?.system).toContain("everything else it says");
    expect(reads[0]?.system).toContain("Figures:");
    expect(reads[0]?.prompt).toContain(`<sentence>\n${claim}\n</sentence>`);
    expect(reads[0]?.prompt).toContain("<figures>");
    expect(reads[0]?.prompt).toContain(REVENUE.en);
  });
});
