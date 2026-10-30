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
          if (verdict === "supported") return { text: JSON.stringify(HOLDS) };
          const passage = /id="([^"]+)"/.exec(call.prompt)?.[1];
          return {
            text: JSON.stringify(contained(passage)),
          };
        }
        return checkGenerate({ [CLAIM]: { verdict: "supported", absence: true } })(call);
      },
    },
  );
}

/** A whole read that finds nothing of what the sentence says is absent, and nothing else to judge. */
const HOLDS = { absent: "break clause", absence: "holds", rest: "none", citations: [] };

/** A whole read that finds the clause the sentence says is absent, in `passage`. */
const contained = (passage: string | undefined) => ({
  absent: "break clause",
  absence: "contained",
  rest: "none",
  citations: [{ marker: 1, passage, quote: CLAUSE }],
});

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
          text: JSON.stringify(contained(passage)),
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
    let wholeReply = JSON.stringify(HOLDS);
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
            return {
              text: JSON.stringify({ ...HOLDS, absent: "the $5 million loan" }),
            };
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
              text: JSON.stringify(contained("P999")),
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

describe("The whole read of an absence sentence judges its absence and its rest apart", () => {
  interface Read {
    absent: string;
    absence: "holds" | "contained";
    rest: "none" | "supported" | "contradicted" | "unsupported";
    /** Citation 1: the words that contain what the sentence says is absent. */
    absenceQuote?: string;
    /** Citation 2: the words that state the rest, or give another value for it. */
    restQuote?: string;
    /** A figure's verdict and the number its quote writes, by the figure as the sentence shows it. */
    figures?: Record<string, { verdict: string; number: string }>;
  }
  interface Case {
    claim: string;
    document: string;
    read: Read;
  }

  /** A whole read that answers as a faithful judge of each part would. */
  function wholeRead(call: { prompt: string }, read: Read): string {
    const passages = shownPassages(call.prompt);
    const cite = (marker: number, quote: string | undefined) =>
      quote
        ? [{ marker, passage: passages.find((each) => each.text.includes(quote))?.id, quote }]
        : [];
    const citations = [...cite(1, read.absenceQuote), ...cite(2, read.restQuote)];
    const judged = JSON.stringify({
      absent: read.absent,
      absence: read.absence,
      rest: read.rest,
      citations,
    });
    const asked = requestedFigures(call as Parameters<typeof requestedFigures>[0]);
    if (asked.length === 0) return judged;
    const items = asked.map(({ id, shown }) => {
      const own = read.figures?.[shown];
      const inAbsent = !own && read.absent.includes(shown);
      return {
        id,
        verdict:
          own?.verdict ?? (inAbsent && read.absence === "holds" ? "supported" : "unsupported"),
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        reading: null,
        relation: "equals",
        source: own ? { citation: 2, number: own.number, reading: null, unitQuote: null } : null,
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
      : ({ verdict: "supported", absence: false, quote: each.read.restQuote } as const);
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
    const checkRequests = requests.filter((system) => !system.startsWith("You sort")).length;
    return { check, figure, reads, checkRequests };
  }

  const languages = ["en", "zh-CN"] as const;
  const LOAN = { en: "the $5 million loan", "zh-CN": "这笔 500 万元的贷款" };
  const MILLIONS = { en: "$5 million", "zh-CN": "500 万元" };
  const REVENUE = { en: "Revenue rose 8% in 2025.", "zh-CN": "2025 年收入增长了 8%。" };
  const LOAN_GIVEN = {
    en: "The company disclosed a $5 million loan on 14 May 2026.",
    "zh-CN": "公司于 2026 年 5 月 14 日披露了一笔 500 万元的贷款。",
  };
  const loanAnd = (language: "en" | "zh-CN", revenue: string) =>
    language === "en"
      ? `The company never disclosed the $5 million loan, and revenue rose ${revenue} in 2025.`
      : `公司从未披露这笔 500 万元的贷款，且 2025 年收入增长了 ${revenue}。`;
  const LEASE = {
    en: {
      pure: "The lease has no break clause.",
      law: (law: string) => `The lease has no break clause and is governed by ${law} law.`,
      laws: ["English", "French"],
      document: "This lease is governed by English law.",
      absent: "break clause",
    },
    "zh-CN": {
      pure: "租约没有提前解约条款。",
      law: (law: string) => `租约没有提前解约条款，并受${law}法律管辖。`,
      laws: ["英国", "法国"],
      document: "本租约受英国法律管辖。",
      absent: "提前解约条款",
    },
  };

  test.each(languages)(
    "%s: a figure inside a true absence keeps the absence's own result, never another part's quote",
    async (language) => {
      const { check, figure, reads } = await checkedInNote(
        {
          claim: loanAnd(language, "12%"),
          document: REVENUE[language],
          read: {
            absent: LOAN[language],
            absence: "holds",
            rest: "contradicted",
            restQuote: REVENUE[language],
            figures: { "12%": { verdict: "contradicted", number: "8%" } },
          },
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check).toMatchObject({
        state: "contradicted",
        evidence: { quote: REVENUE[language] },
      });
      expect(figure("12%")).toMatchObject({
        state: "contradicted",
        source: { quote: REVENUE[language], check: "found" },
      });
      expect(figure(MILLIONS[language])).toMatchObject({
        state: "supported",
        evidence: null,
        source: null,
      });
    },
  );

  test.each(languages)(
    "%s: the rest of the sentence is Supported only with a Citation, else Unsupported",
    async (language) => {
      const lease = LEASE[language];
      const [english, french] = lease.laws;
      const uncited = await checkedInNote(
        {
          claim: lease.law(english ?? ""),
          document: lease.document,
          read: { absent: lease.absent, absence: "holds", rest: "supported" },
        },
        language,
      );
      expect(uncited.check).toMatchObject({ state: "unsupported", evidence: null });

      const cited = await checkedInNote(
        {
          claim: lease.law(english ?? ""),
          document: lease.document,
          read: {
            absent: lease.absent,
            absence: "holds",
            rest: "supported",
            restQuote: lease.document,
          },
        },
        language,
      );
      expect(cited.check).toMatchObject({
        state: "supported",
        evidence: { quote: lease.document, check: "found" },
      });

      const wrong = await checkedInNote(
        {
          claim: lease.law(french ?? ""),
          document: lease.document,
          read: {
            absent: lease.absent,
            absence: "holds",
            rest: "contradicted",
            restQuote: lease.document,
          },
        },
        language,
      );
      expect(wrong.check).toMatchObject({
        state: "contradicted",
        evidence: { quote: lease.document, check: "found" },
      });
    },
  );

  test.each(languages)(
    "%s: beside a figure inside a true absence, an uncited rest leaves the sentence Unsupported",
    async (language) => {
      const claim =
        language === "en"
          ? "The company never disclosed the $5 million loan and is based in London."
          : "公司从未披露这笔 500 万元的贷款，且总部位于伦敦。";
      const { check, figure } = await checkedInNote(
        {
          claim,
          document: REVENUE[language],
          read: { absent: LOAN[language], absence: "holds", rest: "supported" },
        },
        language,
      );
      expect(check?.state).toBe("unsupported");
      expect(check?.remainder).toMatchObject({ state: "unsupported", evidence: null });
      expect(figure(MILLIONS[language])).toMatchObject({ state: "supported", evidence: null });
    },
  );

  test.each(languages)(
    "%s: a sentence that says only its absence is Supported with no Citation when it holds",
    async (language) => {
      const lease = LEASE[language];
      const { check, reads, checkRequests } = await checkedInNote(
        {
          claim: lease.pure,
          document: lease.document,
          read: { absent: lease.absent, absence: "holds", rest: "none" },
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check).toMatchObject({ state: "supported", evidence: null });
      expect(check?.readDocuments).toHaveLength(1);
      // The check's own three requests, then the one whole read.
      expect(checkRequests).toBe(4);
    },
  );

  test.each(languages)(
    "%s: a false absence is Contradicted with the quote that contains it, its figure too",
    async (language) => {
      const claim =
        language === "en"
          ? "The company never disclosed the $5 million loan."
          : "公司从未披露这笔 500 万元的贷款。";
      const { check, figure } = await checkedInNote(
        {
          claim,
          document: LOAN_GIVEN[language],
          read: {
            absent: LOAN[language],
            absence: "contained",
            rest: "none",
            absenceQuote: LOAN_GIVEN[language],
          },
        },
        language,
      );
      expect(check).toMatchObject({
        state: "contradicted",
        evidence: { quote: LOAN_GIVEN[language] },
      });
      expect(figure(MILLIONS[language])).toMatchObject({
        state: "contradicted",
        evidence: { quote: LOAN_GIVEN[language] },
      });
    },
  );

  test.each(languages)(
    "%s: a true absence with a right figure is Supported, the figure on its own source",
    async (language) => {
      const { check, figure, checkRequests } = await checkedInNote(
        {
          claim: loanAnd(language, "8%"),
          document: REVENUE[language],
          read: {
            absent: LOAN[language],
            absence: "holds",
            rest: "supported",
            restQuote: REVENUE[language],
            figures: { "8%": { verdict: "supported", number: "8%" } },
          },
        },
        language,
      );
      expect(check?.state).toBe("supported");
      // The rest of the sentence rests on its own Citation.
      expect(check?.remainder).toMatchObject({
        state: "supported",
        evidence: { quote: REVENUE[language], check: "found" },
      });
      expect(figure("8%")).toMatchObject({ state: "supported", source: { check: "found" } });
      expect(figure(MILLIONS[language])).toMatchObject({ state: "supported", evidence: null });
      expect(checkRequests).toBe(4);
    },
  );

  test.each(languages)(
    "%s: a reply with no readable rest is Not checked, never Supported",
    async (language) => {
      const lease = LEASE[language];
      const { check } = await checkedInNote(
        {
          claim: lease.law(lease.laws[0] ?? ""),
          document: lease.document,
          read: {
            absent: lease.absent,
            absence: "holds",
            rest: "maybe" as Read["rest"],
            restQuote: lease.document,
          },
        },
        language,
      );
      expect(check).toMatchObject({ state: "not-checked", reason: "malformed" });
    },
  );

  test.each(languages)(
    "%s: without the absence answer, each figure keeps its own result from the search",
    async (language) => {
      const claim =
        language === "en"
          ? "The company disclosed the $5 million loan."
          : "公司披露了这笔 500 万元的贷款。";
      const { check, figure, reads, checkRequests } = await checkedInNote(
        {
          claim,
          document: LOAN_GIVEN[language],
          read: { absent: "", absence: "holds", rest: "none", restQuote: LOAN_GIVEN[language] },
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
      expect(checkRequests).toBe(3);
    },
  );

  test("the whole read asks for the absence and the rest of the sentence apart, each with its own quote", async () => {
    const claim = loanAnd("en", "8%");
    const { reads } = await checkedInNote(
      {
        claim,
        document: REVENUE.en,
        read: { absent: LOAN.en, absence: "holds", rest: "supported", restQuote: REVENUE.en },
      },
      "en",
    );
    const system = reads[0]?.system ?? "";
    expect(system).toContain("in two parts: what it says is absent, and the rest of what it says");
    expect(system).toContain('"absence"');
    expect(system).toContain('"rest"');
    expect(system).toContain("citation 1");
    expect(system).toContain("citation 2");
    expect(system).toContain("Figures:");
    expect(reads[0]?.prompt).toContain(`<sentence>\n${claim}\n</sentence>`);
    expect(reads[0]?.prompt).toContain("<figures>");
  });
});
