import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fitsWholeRead, WHOLE_READ } from "../../src/core/answers/checks/absence";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readFigures } from "../../src/shared/figures";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
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

/**
 * A first turn that names the sentence's parts, as the check asks before its first search: a
 * sentence of one part goes on as its own check, with no request to sort it.
 */
function withParts(call: ModelCall, reply: ScriptedReply, parts: readonly string[]): ScriptedReply {
  const first = !call.results.some((result) => result.tool === "search_documents");
  if (!first || !call.system.includes("Parts:")) return reply;
  const named = parts.map((text) => ({ kind: "fact", text }));
  return { ...reply, text: `Parts: ${JSON.stringify(named)}` };
}

/** A whole read that finds nothing of what the sentence says is absent. */
const HOLDS = { absent: "break clause", absence: "holds" };

/** A whole read that finds the clause the sentence says is absent, in `passage`. */
const contained = (passage: string | undefined) => ({
  absent: "break clause",
  absence: "contained",
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
      if (!("text" in scripted)) return withParts(call, scripted, [claim]);
      return { text: fields.startsWith("{") ? fields : `Verdict: supported\n${fields}` };
    },
    {
      generate: (call) => {
        requests.push(call.system);
        // Its two looks at the clause the whole read quotes find it contradicts the sentence.
        if (call.system.startsWith("Compare a sentence")) return { text: "Judgement: conflict" };
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
    expect(claimSpans(readMind(client))[0]?.check.readDocuments ?? []).toEqual([]);
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

  test.each([
    {
      language: "en" as const,
      claim: "The lease has no parking.",
      garden: "The tenant keeps the garden tidy.",
      parking: "The tenant may park one car in the yard.",
    },
    {
      language: "zh-CN" as const,
      claim: "租约中没有停车位。",
      garden: "租户应保持花园整洁。",
      parking: "租户可在院内停放一辆车。",
    },
  ])(
    "a quote the whole read says holds the absent thing but that is about something else doesn't Contradict; the thing itself does ($language)",
    async (example) => {
      const read = async (quote: string) => {
        const looks: string[] = [];
        const plan = { [example.claim]: { verdict: "unsupported" as const, absence: true } };
        const model = scriptedModel((call) => checkReply(call, plan), {
          generate: (call) => {
            if (call.system.startsWith("Compare a sentence")) {
              looks.push(call.system);
              return {
                text: `Judgement: ${call.prompt.includes(example.parking) ? "conflict" : "neither"}`,
              };
            }
            if (!call.system.startsWith("Read the whole Documents"))
              return checkGenerate(plan)(call);
            const passage = shownPassages(call.prompt).find((each) => each.text.includes(quote));
            return {
              text: JSON.stringify({
                absent: "parking",
                absence: "contained",
                citations: [{ marker: 1, passage: passage?.id, quote }],
              }),
            };
          },
        });
        const lines = [example.garden, ...(quote === example.parking ? [example.parking] : [])];
        const { core } = await setUpWithDocuments(model, [
          {
            name: "Lease.pdf",
            contents: buildPdf([
              example.language === "zh-CN" ? { chineseLines: lines } : { lines },
            ]),
          },
        ]);
        await core.updateSettings({ user: { language: example.language } });
        return { result: await core.checkClaim({ claim: example.claim }), looks };
      };

      const garden = await read(example.garden);
      expect(garden.result).toMatchObject({ verdict: "supported", evidence: null });
      expect(garden.looks).toHaveLength(1);

      const parking = await read(example.parking);
      expect(parking.result).toMatchObject({
        verdict: "contradicted",
        evidence: { quote: example.parking, check: "found" },
      });
      expect(parking.looks).toHaveLength(2);
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

  test.each([
    { pages: 2, searches: 1, wholeReads: 1 },
    { pages: 41, searches: 2, wholeReads: 0 },
  ])(
    "an absence on $pages pages searches again only when the scope is too long to read whole",
    async ({ pages, searches, wholeReads }) => {
      const reads: number[] = [];
      const queries: string[] = [];
      // The first search misses the clause; only a search in other words finds it.
      const plan = {
        verdict: "unsupported",
        absence: true,
        again: {
          query: "Either party may end this lease",
          plan: { verdict: "contradicted", absence: true, quote: CLAUSE },
        },
      } as const;
      const model = scriptedModel(
        (call) => {
          const reply = checkReply(call, { [CLAIM]: plan });
          for (const each of "calls" in reply ? (reply.calls ?? []) : []) {
            if (each.tool === "search_documents") queries.push(each.tool);
          }
          return reply;
        },
        {
          generate: (call) => {
            if (call.system.startsWith("Read the whole Documents")) {
              reads.push(1);
              const passage = /id="([^"]+)"/.exec(call.prompt)?.[1];
              return { text: JSON.stringify(contained(passage)) };
            }
            return checkGenerate({ [CLAIM]: plan.again.plan })(call);
          },
        },
      );
      const { core } = await setUpWithDocuments(model, [
        {
          name: "Lease.pdf",
          contents: buildPdf([
            { lines: ["Term", "The lease runs for three years."] },
            { lines: ["Break clause", CLAUSE] },
            ...Array.from({ length: pages - 2 }, (_, index) => ({
              lines: [`Schedule ${index + 1}`, "Rent schedule"],
            })),
          ]),
        },
      ]);

      const result = await core.checkClaim({ claim: CLAIM });

      expect(result).toMatchObject({
        verdict: "contradicted",
        evidence: { quote: CLAUSE, check: "found" },
      });
      expect(queries).toHaveLength(searches);
      expect(reads).toHaveLength(wholeReads);
    },
  );

  test.each([
    { units: [2], fits: true },
    { units: [40], fits: true },
    { units: [41], fits: false },
    { units: [30, 11], fits: false },
    { units: [5000, 5000, 5000], fits: false },
    { units: [], fits: false },
  ])(
    "a scope of $units Units is judged from stored counts, with no page text loaded: fits $fits",
    ({ units, fits }) => {
      const ids = units.map((_, index) => `doc-${index}`);
      const loaded = () => {
        throw new Error("The scope check loaded page text.");
      };
      const documents = {
        searchableBySize: () => ids.map((id) => ({ id, name: id })),
        unitCounts: (asked: readonly string[]) =>
          new Map(asked.map((id) => [id, units[ids.indexOf(id)] ?? 0])),
        pageTexts: loaded,
        passagesBetween: loaded,
      };
      expect(fitsWholeRead(null, documents)).toBe(fits);
    },
  );

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

describe("An absence is one part of its sentence, judged by the whole read alone", () => {
  type Plan = Parameters<typeof checkReply>[1][string];
  interface Case {
    claim: string;
    document: string;
    /** Each part's words, in order, and how the check of that part goes. */
    parts: [string, Plan][];
    /** The whole read's reply for the absence part. */
    read?: Record<string, unknown> | string;
  }

  async function checkedInNote(each: Case, language: "en" | "zh-CN") {
    const reads: { system: string; prompt: string }[] = [];
    const requests: string[] = [];
    const plans = Object.fromEntries(each.parts);
    const model = scriptedModel(
      (call) => {
        requests.push(call.system);
        return withParts(
          call,
          checkReply(call, plans),
          each.parts.map(([text]) => text),
        );
      },
      {
        generate: (call) => {
          requests.push(call.system);
          if (call.system.startsWith("Read the whole Documents")) {
            reads.push({ system: call.system, prompt: call.prompt });
            const passage = shownPassages(call.prompt)[0]?.id;
            return {
              text:
                typeof each.read === "string"
                  ? each.read
                  : JSON.stringify(each.read ?? {}).replaceAll(
                      '"$PASSAGE"',
                      JSON.stringify(passage),
                    ),
            };
          }
          return checkGenerate(plans)(call);
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
    const part = (text: string) =>
      check?.parts?.find((one) => each.claim.slice(one.span.start, one.span.end) === text);
    const figure = (shown: string) => check?.figures?.find((each) => each.reading.chars === shown);
    const checkRequests = requests.filter((system) => !system.startsWith("You sort Documents"));
    return { check, part, figure, reads, checkRequests };
  }

  /** The check of an absence part: the search finds nothing, and its judge says Absence: yes. */
  const absent = (): Plan => ({ verdict: "unsupported", absence: true });
  const holds = (words: string) => ({ absent: words, absence: "holds" });
  const languages = ["en", "zh-CN"] as const;

  const WAREHOUSE = {
    en: {
      claim:
        "The company never disclosed a second warehouse, and the landlord is Harbour Estates Ltd., which also owns the warehouse.",
      absence: "The company never disclosed a second warehouse",
      landlord: "the landlord is Harbour Estates Ltd.",
      owns: "which also owns the warehouse",
      document: "The landlord is Harbour Estates Ltd.",
      quote: "The landlord is Harbour Estates Ltd",
      absent: "a second warehouse",
    },
    "zh-CN": {
      claim: "公司从未披露第二个仓库，并且出租人为港湾地产有限公司，该公司也拥有这个仓库。",
      absence: "公司从未披露第二个仓库",
      landlord: "出租人为港湾地产有限公司",
      owns: "该公司也拥有这个仓库",
      document: "出租人为港湾地产有限公司。",
      quote: "出租人为港湾地产有限公司",
      absent: "第二个仓库",
    },
  };

  test.each(languages)(
    "%s: a quote the read offers for the rest can't make another part Supported: that part has its own check",
    async (language) => {
      const each = WAREHOUSE[language];
      const { check, part, reads } = await checkedInNote(
        {
          claim: each.claim,
          document: each.document,
          parts: [
            [each.absence, absent()],
            [each.landlord, { verdict: "supported", quote: each.quote }],
            [each.owns, { verdict: "unsupported" }],
          ],
          // As the live reply was: the absence holds, and the rest "supported" on an off-topic quote.
          read: {
            absent: each.absent,
            absence: "holds",
            rest: "supported",
            citations: [
              { marker: 1, passage: "$PASSAGE", quote: "" },
              { marker: 2, passage: "$PASSAGE", quote: each.quote },
            ],
          },
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check?.state).not.toBe("supported");
      expect(check?.state).toBe("unsupported");
      expect(part(each.absence)).toMatchObject({ verdict: "supported", evidence: [] });
      expect(part(each.absence)?.readDocuments).toHaveLength(1);
      expect(part(each.landlord)).toMatchObject({ verdict: "supported" });
      expect(part(each.owns)).toMatchObject({ verdict: "unsupported" });
    },
  );

  const LAW = {
    en: {
      absence: "The lease has no break clause",
      law: (law: string) => `is governed by ${law} law`,
      claim: (law: string) => `The lease has no break clause and is governed by ${law} law.`,
      laws: ["English", "French"] as const,
      document: "This lease is governed by English law.",
      quote: "This lease is governed by English law",
      absent: "break clause",
    },
    "zh-CN": {
      absence: "租约没有提前解约条款",
      law: (law: string) => `适用${law}法律`,
      claim: (law: string) => `租约没有提前解约条款，并且适用${law}法律。`,
      laws: ["英国", "法国"] as const,
      document: "本租约适用英国法律。",
      quote: "本租约适用英国法律",
      absent: "提前解约条款",
    },
  };

  test.each(languages)(
    "%s: a true absence beside a right fact is Supported, each part on what backs it",
    async (language) => {
      const each = LAW[language];
      const [right] = each.laws;
      const { check, part, checkRequests } = await checkedInNote(
        {
          claim: each.claim(right),
          document: each.document,
          parts: [
            [each.absence, absent()],
            [each.law(right), { verdict: "supported", quote: each.quote }],
          ],
          read: holds(each.absent),
        },
        language,
      );
      expect(check?.state).toBe("supported");
      expect(part(each.absence)?.readDocuments).toHaveLength(1);
      expect(part(each.law(right))).toMatchObject({
        verdict: "supported",
        evidence: [{ quote: each.quote, check: "found" }],
      });
      // The first turn names the two parts and stops; the absence part's search and verdict, its
      // one whole read, and the other part's search, cite and verdict.
      expect(checkRequests).toHaveLength(7);
      expect(checkRequests.filter((system) => system.startsWith("Read the whole"))).toHaveLength(1);
    },
  );

  test.each(languages)(
    "%s: a wrong fact beside a true absence is never Supported",
    async (language) => {
      const each = LAW[language];
      const [, wrong] = each.laws;
      const { check, part } = await checkedInNote(
        {
          claim: each.claim(wrong),
          document: each.document,
          parts: [
            [each.absence, absent()],
            [
              each.law(wrong),
              { verdict: "contradicted", quote: each.quote, confirm: "conflict" } as Plan,
            ],
          ],
          read: holds(each.absent),
        },
        language,
      );
      expect(check?.state).not.toBe("supported");
      expect(part(each.law(wrong))?.verdict).not.toBe("supported");
    },
  );

  const LOAN = {
    en: {
      absence: "The company never disclosed the $5 million loan",
      revenue: (figure: string) => `revenue rose ${figure} in 2025`,
      claim: (figure: string) =>
        `The company never disclosed the $5 million loan, and revenue rose ${figure} in 2025.`,
      document: "Revenue rose 8% in 2025.",
      quote: "Revenue rose 8% in 2025",
      absent: "the $5 million loan",
      millions: "$5 million",
      pure: "The company never disclosed the $5 million loan.",
      given: "The company disclosed a $5 million loan on 14 May 2026.",
    },
    "zh-CN": {
      absence: "公司从未披露这笔 500 万元的贷款",
      revenue: (figure: string) => `2025 年收入增长了 ${figure}`,
      claim: (figure: string) =>
        `公司从未披露这笔 500 万元的贷款，且 2025 年收入增长了 ${figure}。`,
      document: "2025 年收入增长了 8%。",
      quote: "2025 年收入增长了 8%",
      absent: "这笔 500 万元的贷款",
      millions: "500 万元",
      pure: "公司从未披露这笔 500 万元的贷款。",
      given: "公司于 2026 年 5 月 14 日披露了一笔 500 万元的贷款。",
    },
  };

  test.each(languages)(
    "%s: a wrong figure beside a true absence is never Supported, and the absence's figure keeps its own result",
    async (language) => {
      const each = LOAN[language];
      const { check, figure } = await checkedInNote(
        {
          claim: each.claim("12%"),
          document: each.document,
          parts: [
            [each.absence, absent()],
            [each.revenue("12%"), { verdict: "contradicted", quote: each.quote }],
          ],
          read: holds(each.absent),
        },
        language,
      );
      expect(check?.state).not.toBe("supported");
      expect(figure("12%")?.state).not.toBe("supported");
      expect(figure(each.millions)).toMatchObject({ state: "supported", evidence: null });
    },
  );

  test.each(languages)(
    "%s: a sentence that is only its absence is Supported with no Citation when it holds",
    async (language) => {
      const each = LAW[language];
      const claim = language === "en" ? `${each.absence}.` : `${each.absence}。`;
      const { check, reads, checkRequests } = await checkedInNote(
        {
          claim,
          document: each.document,
          parts: [[claim, absent()]],
          read: holds(each.absent),
        },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check).toMatchObject({ state: "supported", evidence: null });
      expect(check?.readDocuments).toHaveLength(1);
      // Its search and verdict, then the one whole read: no second search, which can't decide it.
      expect(checkRequests).toHaveLength(3);
    },
  );

  test.each(languages)(
    "%s: a figure inside a true absence is Supported with the absence, no quote borrowed",
    async (language) => {
      const each = LOAN[language];
      const { check, figure } = await checkedInNote(
        {
          claim: each.pure,
          document: each.document,
          parts: [[each.pure, absent()]],
          read: holds(each.absent),
        },
        language,
      );
      expect(check?.state).toBe("supported");
      expect(figure(each.millions)).toMatchObject({ state: "supported", evidence: null });
    },
  );

  test.each(languages)(
    "%s: a false absence is Contradicted with the quote that contains it, its figure too",
    async (language) => {
      const each = LOAN[language];
      const quote = each.given.replace(/[.。]$/u, "");
      const { check, figure } = await checkedInNote(
        {
          claim: each.pure,
          document: each.given,
          parts: [[each.pure, absent()]],
          read: {
            absent: each.absent,
            absence: "contained",
            citations: [{ marker: 1, passage: "$PASSAGE", quote }],
          },
        },
        language,
      );
      expect(check).toMatchObject({ state: "contradicted", evidence: { quote } });
      expect(figure(each.millions)).toMatchObject({
        state: "contradicted",
        evidence: { quote },
      });
    },
  );

  test.each(languages)(
    "%s: an absence answer that can't be read is Not checked, never Supported",
    async (language) => {
      const each = LAW[language];
      const claim = language === "en" ? `${each.absence}.` : `${each.absence}。`;
      const { check } = await checkedInNote(
        {
          claim,
          document: each.document,
          parts: [[claim, absent()]],
          read: { absent: each.absent, absence: "probably" },
        },
        language,
      );
      expect(check).toMatchObject({ state: "not-checked", reason: "malformed" });
    },
  );

  test.each([
    { language: "en" as const, reply: "I'm sorry, I can't help with that.", reason: "refused" },
    { language: "zh-CN" as const, reply: "抱歉，无法核对这句话。", reason: "refused" },
    {
      language: "en" as const,
      reply: "The text doesn't seem to mention one.",
      reason: "malformed",
    },
    { language: "zh-CN" as const, reply: "文中似乎没有提到。", reason: "malformed" },
  ])(
    "$language: a whole read that declines or gives no answer to read is Not checked ($reason)",
    async ({ language, reply, reason }) => {
      const each = LAW[language];
      const claim = language === "en" ? `${each.absence}.` : `${each.absence}。`;
      const { check, reads } = await checkedInNote(
        { claim, document: each.document, parts: [[claim, absent()]], read: reply },
        language,
      );
      expect(reads).toHaveLength(1);
      expect(check).toMatchObject({ state: "not-checked", reason });
    },
  );

  test.each(languages)(
    "%s: a check that declines stays Not checked, with no whole read",
    async (language) => {
      const each = LAW[language];
      const claim = language === "en" ? `${each.absence}.` : `${each.absence}。`;
      const { check, reads } = await checkedInNote(
        {
          claim,
          document: each.document,
          parts: [
            [
              claim,
              { verdict: "unsupported", reply: { text: "I'm sorry, I can't help with that." } },
            ],
          ],
          read: holds(each.absent),
        },
        language,
      );
      expect(reads).toHaveLength(0);
      expect(check).toMatchObject({ state: "not-checked", reason: "refused" });
    },
  );

  test.each([
    "The witness never mentioned a second contract (Smith Dep. 45:3–12).",
    "证人从未提到第二份合同 (Smith Dep. 45:3–12)。",
  ])(
    "an absence with a record cite keeps both: the pages read whole and the cite's own result (%s)",
    async (claim) => {
      const reads: number[] = [];
      const plans = { [claim]: { ...absent(), judgement: "same" } as Plan };
      const model = scriptedModel((call) => withParts(call, checkReply(call, plans), [claim]), {
        generate: (call) => {
          if (call.system.startsWith("Read the whole Documents")) {
            reads.push(1);
            return { text: JSON.stringify({ absent: "a second contract", absence: "holds" }) };
          }
          return checkGenerate(plans)(call);
        },
      });
      const setup = await setUpWithDocuments(model, [
        {
          name: "Smith Deposition.pdf",
          contents: buildPdf([
            {
              lines: [
                "Page 45",
                "1 Q. First question?",
                "2 A. First answer.",
                "3 The witness denied it",
                ...Array.from({ length: 9 }, (_, index) => `${index + 4} Later line ${index + 4}`),
              ],
            },
          ]),
        },
      ]);
      const document = setup.documents[0];
      if (!document) throw new Error("The deposition Document is missing.");
      const folder = await setup.core.createLibraryGroup({ name: "Record", description: "" });
      await setup.core.moveToFolder({ documentIds: [document.id], folderId: folder.id });
      const mind = await setup.core.createMind({ title: "Record", folderId: folder.id });
      const client = await connectToMind(setup.core, mind.id);
      writeMind(client, [
        { type: "paragraph", attrs: { id: "cited" }, content: [{ type: "text", text: claim }] },
      ]);
      await client.settled();
      await setup.core.checkSentences({
        requestId: randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId: "cited", offset: 0 },
        to: { blockId: "cited", offset: claim.length },
      });
      await client.settled();
      const check = claimSpans(readMind(client))[0]?.check;
      expect(reads).toHaveLength(1);
      expect(check?.state).toBe("supported");
      expect(check?.readDocuments).toHaveLength(1);
      expect(check?.recordCites).toHaveLength(1);
      expect(check?.recordCites?.[0]).toMatchObject({
        raw: "Smith Dep. 45:3–12",
        documentId: document.id,
      });
      expect(check?.versions.map((version) => version.documentId)).toContain(document.id);
    },
  );

  test.each(["ends", "is stopped", "fails"] as const)(
    "a Check of the Note keeps its hold while an absence's whole read %s, and frees it after",
    async (exit) => {
      const claim = "The lease has no break clause.";
      const plans = { [claim]: absent() };
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const model = scriptedModel((call) => withParts(call, checkReply(call, plans), [claim]), {
        generate: (call) =>
          call.system.startsWith("Read the whole Documents")
            ? { text: JSON.stringify(HOLDS) }
            : checkGenerate(plans)(call),
      });
      const generate = model.doGenerate.bind(model);
      model.doGenerate = async (options) => {
        const system = options.prompt.find((message) => message.role === "system");
        if (system?.role === "system" && system.content.startsWith("Read the whole Documents")) {
          started.resolve();
          await new Promise<void>((resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () =>
              reject(new DOMException("Stopped", "AbortError")),
            );
            void gate.promise.then(resolve);
          });
          if (exit === "fails") throw new Error("The read broke off.");
        }
        return generate(options);
      };
      const { core, client, mind } = await setUpWithDocuments(model, [LEASE]);
      writeMind(client, [
        { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: claim }] },
      ]);
      await client.settled();

      const running = core.checkMind({ requestId: "first", mindId: mind.id, mode: "all" });
      await started.promise;
      // A second window can't check the Note while its read runs.
      expect(
        await core.holdMindCheck({ requestId: "second", mindId: mind.id, clientId: "other" }),
      ).toBe(false);
      expect(await core.checkMind({ requestId: "again", mindId: mind.id, mode: "all" })).toEqual({
        kind: "running",
      });
      if (exit === "is stopped") await core.cancelCheck("first");
      gate.resolve();
      await running;

      expect(
        await core.holdMindCheck({ requestId: "second", mindId: mind.id, clientId: "other" }),
      ).toBe(true);
    },
  );

  test("the whole read asks only about the absence", () => {
    expect(WHOLE_READ).toContain(
      "decide only whether they contain what the sentence says is absent",
    );
    expect(WHOLE_READ).toContain('"absence":"holds"');
    expect(WHOLE_READ).toContain('"absence":"contained"');
    expect(WHOLE_READ).not.toContain("rest");
    expect(WHOLE_READ).not.toContain('"marker":2');
    expect(WHOLE_READ).not.toContain("Figures:");
  });
});
