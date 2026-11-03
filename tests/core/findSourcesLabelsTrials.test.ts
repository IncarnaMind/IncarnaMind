/**
 * Find sources (#305): drug labels (openFDA and DailyMed) and clinical trials
 * (ClinicalTrials.gov). A label or a record is added as a Document whose
 * sections are Passages, so a Citation points at "5.1 Lactic acidosis" or
 * "Eligibility criteria" and its quote is checked there. Through the core's
 * public interface, against a local stand-in answering with responses
 * recorded from the real services on 2026-10-11, trimmed: no test reaches
 * the network.
 */
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { asksForSources } from "../../src/core/sources/intent";
import { companyName } from "../../src/core/sources/providers/common";
import { isoDate } from "../../src/core/sources/providers/dailymed";
import { numberedHeading } from "../../src/core/sources/providers/openfda";
import { askAndFinish, shownPassages } from "../helpers/citations";
import { createMemoryKeychain } from "../helpers/core";
import {
  add,
  answerConsent,
  found,
  requestsTo,
  searchOf,
  setUp,
  USER_AGENT,
  work,
} from "../helpers/findSourcesTesting";
import { connectToMind } from "../helpers/mindClient";
import { scriptedModel, scriptedModels } from "../helpers/models";

const DISCLAIMER = "Do not rely on openFDA to make decisions regarding medical care.";

/** The headings of a Document's sections, in order, after its title. */
async function headings(core: Core, document: Document | null): Promise<string[]> {
  const text = await core.readDocumentText(document?.id ?? "");
  return text.pages.slice(1).map((unit) => String(unit.label?.path?.at(-1)));
}

const LABELS = ["openfda", "dailymed"];

describe("Drug labels: searching", () => {
  test("a drug search returns labels from openFDA and DailyMed, merged by set id, with openFDA's disclaimer", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    const result = found(await core.findSources({ query: "metformin", providers: LABELS }));

    // openFDA names one by drug; DailyMed lists three, one of them a label openFDA has no drug name for.
    expect(result.providers).toEqual([
      { id: "openfda", name: "openFDA", count: 1, failure: null },
      { id: "dailymed", name: "DailyMed", count: 3, failure: null },
    ]);
    expect(result.works).toHaveLength(3);
    // Found by both, and first in each: ranked above the labels only DailyMed lists.
    const [first, second] = result.works;
    expect(first).toMatchObject({
      key: "setid:0098dec4-f0e5-45d5-8aa4-5d0faf9ab142",
      foundBy: [
        { id: "openfda", name: "openFDA" },
        { id: "dailymed", name: "DailyMed" },
      ],
      versionDate: "2026-08-12",
      notice: expect.stringContaining(DISCLAIMER),
      // DailyMed's copy first; its page states no licence, openFDA's says CC0.
      access: { kind: "open", format: "text", licence: null },
    });
    expect(first?.fields).toMatchObject({
      type: "document",
      title: "Zituvimet (sitagliptin and metformin hydrochloride) tablet, film coated",
      authors: [{ literal: "Zydus Lifesciences Limited" }],
    });
    // The disclaimer is openFDA's: a label only DailyMed lists carries none, and IncarnaMind adds none.
    expect(second).toMatchObject({ foundBy: [{ id: "dailymed" }], notice: null });

    // One consent per provider, before its first request, saying what is sent.
    expect(asked.map((request) => [request.flow.service.name, request.flow.sends])).toEqual([
      ["openFDA", ["search-terms", "work-ids"]],
      ["DailyMed", ["search-terms", "work-ids"]],
    ]);
    const openfda = searchOf(services, "openfda");
    expect(openfda.get("search")).toBe(
      'openfda.generic_name:"metformin" OR openfda.brand_name:"metformin" OR openfda.substance_name:"metformin"',
    );
    expect(searchOf(services, "dailymed").get("drug_name")).toBe("metformin");
    for (const request of services.requests) {
      expect(request).toMatchObject({ method: "GET", bodyLength: 0, userAgent: USER_AGENT });
    }
  });

  test("a search of papers doesn't go to the drug-label or trial providers, and asks no consent for them", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    await core.findSources({ query: "metformin" });

    expect(asked.map((request) => request.flow.service.name)).toEqual([
      "OpenAlex",
      "arXiv",
      "PubMed",
    ]);
    for (const provider of ["openfda", "dailymed", "clinicaltrials"]) {
      expect(requestsTo(services, provider)).toEqual([]);
    }
  });

  test("a set id is looked up at both label providers; a drug no label names finds nothing, without an error", async () => {
    const { core } = await setUp();
    answerConsent(core);

    const byId = found(await core.findSources({ query: "0098DEC4-F0E5-45D5-8AA4-5D0FAF9AB142" }));
    expect(byId.providers.map((each) => each.id)).toEqual(["openfda", "dailymed"]);
    expect(byId.works).toHaveLength(1);
    expect(byId.works[0]?.foundBy).toHaveLength(2);

    const none = found(await core.findSources({ query: "zzzzqq", providers: LABELS }));
    expect(none.works).toEqual([]);
    expect(none.providers.map((each) => each.failure)).toEqual([null, null]);
  });
});

describe("Drug labels: adding", () => {
  test("a label is added as DailyMed's structured label, each section and subsection a Passage with its number", async () => {
    const { core, services } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "metformin", providers: LABELS }));

    const { document } = await add(
      core,
      work(result.works, /^Metformin hydrochloride solution/).key,
    );

    // One label, one request.
    expect(requestsTo(services, "dailymed").map((request) => request.path)).toEqual([
      expect.stringMatching(/^\/dailymed\/spls\.json\?/),
      "/dailymed/spls/e087ce3b-8d7f-43a3-8d20-54513da7617d.xml",
    ]);
    expect(document?.found).toMatchObject({
      provider: { id: "dailymed", name: "DailyMed" },
      versionDate: "2026-06-30",
    });
    expect(document?.reference?.fields).toMatchObject({
      title: "Metformin hydrochloride solution",
      authors: [{ literal: "Vistapharm, LLC" }],
      containerTitle: "DailyMed",
    });
    expect(await headings(core, document)).toEqual(
      expect.arrayContaining([
        "About this label",
        "Boxed warning",
        "1 Indications and usage",
        "4 Contraindications",
        "5 Warnings and precautions",
        "5.1 Lactic Acidosis",
        "6 Adverse reactions",
        "6.1 Clinical Studies Experience",
      ]),
    );
    const text = await core.readDocumentText(document?.id ?? "");
    const about = text.pages.find((unit) => unit.label?.path?.at(-1) === "About this label");
    expect(about?.text).toContain("Set ID e087ce3b-8d7f-43a3-8d20-54513da7617d, version 9");
    expect(about?.text).toContain("effective 2026-06-30");
    // The highlights repeat the sections: they aren't kept.
    expect(text.pages.map((unit) => unit.text).join("\n")).not.toContain("See boxed warning");
  });

  test("with DailyMed not allowed, the label is read from openFDA's sections, numbered as the label numbers them", async () => {
    const { core, services } = await setUp();
    answerConsent(core, ["DailyMed"]);
    const result = found(await core.findSources({ query: "metformin", providers: LABELS }));

    const { document } = await add(core, work(result.works, /^Zituvimet/).key);

    expect(requestsTo(services, "dailymed")).toEqual([]);
    expect(document?.found?.provider).toMatchObject({ id: "openfda", name: "openFDA" });
    expect(document?.found?.licence).toMatchObject({ id: "cc0" });
    expect(await headings(core, document)).toEqual([
      "About this label",
      "Boxed warning",
      "1 Indications and usage",
      "4 Contraindications",
      "5 Warnings and precautions",
      "6 Adverse reactions",
    ]);
    const text = await core.readDocumentText(document?.id ?? "");
    // The source's own disclaimer is kept with the label; IncarnaMind adds none of its own.
    expect(text.pages[1]?.text).toContain(DISCLAIMER);
  });

  test("a label with no numbered sections is added without an error, under the headings it has", async () => {
    const { core } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "aspirin", providers: LABELS }));
    expect(result.works).toHaveLength(1);

    const { document } = await add(core, result.works[0]?.key ?? "");

    const names = await headings(core, document);
    expect(names).toEqual(expect.arrayContaining(["About this label", "Uses", "Warnings"]));
    expect(names.every((name) => !/^\d/.test(name))).toBe(true);
  });

  test("a quote from Warnings and precautions is found there, and not found in Adverse reactions", async () => {
    const quote = "There have been postmarketing cases of metformin-associated lactic acidosis";
    // It reads the section on lactic acidosis, then the one on adverse reactions, and cites the same words from each.
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "lactic acidosis" } }] };
      }
      if (searches.length === 1) {
        const query = "adverse reaction rates observed in clinical trials";
        return { calls: [{ tool: "search_documents", input: { query } }] };
      }
      if (call.results.some((result) => result.tool === "cite")) {
        return {
          text: "Metformin can cause lactic acidosis [^1], and the adverse reactions say so too [^2].",
        };
      }
      const under = (result: string, location: string) => {
        const passage = shownPassages(result).find(
          (each) => each.location === location || each.text.includes(`[${location}]`),
        );
        if (!passage) throw new Error(`No Passage under ${location}.`);
        return { passage: passage.id, location };
      };
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  ...under(searches[0]?.text ?? "", "§ 5.1 Lactic Acidosis"),
                  quote,
                },
                {
                  marker: 2,
                  ...under(searches[1]?.text ?? "", "§ 6 Adverse reactions"),
                  quote,
                },
              ],
            },
          },
        ],
      };
    });
    const { core } = await setUp({ createChatModel: scriptedModels(model).createChatModel });
    answerConsent(core);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const result = found(await core.findSources({ query: "metformin", providers: LABELS }));
    await add(core, work(result.works, /^Metformin hydrochloride solution/).key);
    const mind = await core.createMind({ title: "Labels" });
    const client = await connectToMind(core, mind.id);

    const { finished } = await askAndFinish(core, client, mind.id, "What does the label say?");

    expect(finished.citations.map((each) => [each.quote === quote, each.check])).toEqual([
      [true, "found"],
      [true, "not-found"],
    ]);
    expect(finished.citations.map((each) => each.location)).toEqual([
      { kind: "section", heading: "5.1 Lactic Acidosis" },
      { kind: "section", heading: "6 Adverse reactions" },
    ]);
  });
});

describe("Clinical trials", () => {
  test("a search by condition lists studies; an NCT number is looked up, whichever providers are chosen", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    const listed = found(
      await core.findSources({ query: "metformin covid", providers: ["clinicaltrials"] }),
    );
    expect(listed.works.map((each) => each.key)).toEqual([
      "nct:NCT04412746",
      "nct:NCT04625985",
      "nct:NCT04626089",
    ]);
    expect(listed.works[1]).toMatchObject({
      versionDate: "2021-04-08",
      access: { kind: "open", format: "text" },
    });
    expect(listed.works[1]?.fields.title).toMatch(/^Metformin Glycinate, Treatment of Patients/);
    expect(searchOf(services, "clinicaltrials").get("query.term")).toBe("metformin covid");

    const byNumber = found(
      await core.findSources({ query: "nct04368728", providers: ["openfda"] }),
    );
    expect(byNumber.providers.map((each) => each.id)).toEqual(["clinicaltrials"]);
    expect(byNumber.works).toHaveLength(1);
    // Consent was asked once for the service, though it was used twice.
    expect(asked.map((request) => request.flow.service.name)).toEqual(["ClinicalTrials.gov"]);
  });

  test("a study with posted results is added with each part of its record as a section", async () => {
    const { core } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "NCT04368728" }));

    const { document } = await add(core, result.works[0]?.key ?? "");

    expect(document?.found).toMatchObject({
      provider: { id: "clinicaltrials", name: "ClinicalTrials.gov" },
      versionDate: "2026-03-25",
    });
    expect(document?.reference?.fields).toMatchObject({
      authors: [{ literal: "BioNTech SE" }],
      issued: "2026-03-25",
      containerTitle: "ClinicalTrials.gov",
    });
    expect(await headings(core, document)).toEqual([
      "Overview",
      "Conditions and design",
      "Arms and interventions",
      "Primary outcome",
      "Secondary outcomes",
      "Eligibility criteria",
      "Results: participant flow",
      "Results: outcome measures",
      "Results: adverse events",
    ]);
    const text = await core.readDocumentText(document?.id ?? "");
    const part = (heading: string) =>
      text.pages.find((unit) => unit.label?.path?.at(-1) === heading)?.text ?? "";
    expect(part("Overview")).toContain("NCT number: NCT04368728");
    expect(part("Overview")).toContain("Record last updated: 2026-03-25");
    expect(part("Eligibility criteria")).toContain("Inclusion Criteria:");
    expect(part("Results: adverse events")).toContain("Other adverse event: Tachycardia");
    expect(part("Primary outcome")).not.toContain("Inclusion Criteria");
  });

  test("a study with no posted results is added without an error, and without results sections", async () => {
    const { core } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "NCT04625985" }));

    const { document } = await add(core, result.works[0]?.key ?? "");

    const names = await headings(core, document);
    expect(names).toEqual(expect.arrayContaining(["Overview", "Eligibility criteria"]));
    expect(names.some((name) => name.startsWith("Results"))).toBe(false);
  });

  test("a number no study has finds nothing, without an error", async () => {
    const { core } = await setUp();
    answerConsent(core);

    const result = found(await core.findSources({ query: "NCT00000000" }));

    expect(result.works).toEqual([]);
    expect(result.providers).toEqual([
      { id: "clinicaltrials", name: "ClinicalTrials.gov", count: 0, failure: null },
    ]);
  });

  test("requests to ClinicalTrials.gov are a second apart", async () => {
    const { core, waits } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "NCT04625985" }));

    await add(core, result.works[0]?.key ?? "");

    expect(waits).toEqual([1000]);
  });
});

describe("Drug labels and trials: consent, local mode and the openFDA key", () => {
  test("a provider the User declines is never sent anything, and the others still answer", async () => {
    const { core, services } = await setUp();
    answerConsent(core, ["openFDA"]);

    const result = found(await core.findSources({ query: "metformin", providers: LABELS }));

    expect(result.providers[0]).toMatchObject({
      id: "openfda",
      failure: { reason: "declined" },
    });
    expect(requestsTo(services, "openfda")).toEqual([]);
    expect(result.works.length).toBeGreaterThan(0);
  });

  test("local mode blocks all three: nothing is asked, and nothing is added", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);
    const result = found(await core.findSources({ query: "NCT04625985" }));
    await core.setLocalOnly(true);
    const before = services.requests.length;

    expect(await core.findSources({ query: "metformin", providers: LABELS })).toEqual({
      outcome: "local-mode",
    });
    expect(await core.findSources({ query: "NCT04625985" })).toEqual({ outcome: "local-mode" });
    expect(await core.addFoundSource({ key: result.works[0]?.key ?? "" })).toMatchObject({
      outcome: "failed",
      reason: "local-mode",
    });

    expect(services.requests).toHaveLength(before);
    expect(asked.map((request) => request.flow.service.name)).toEqual(["ClinicalTrials.gov"]);
  });

  test("an openFDA key is kept in the keychain, sent in a header and never in an address, a result or an error", async () => {
    const key = "k3y-9f2c1d7a-not-a-real-key";
    const keychain = createMemoryKeychain();
    const { core, services } = await setUp({ keychain });
    answerConsent(core);
    expect((await core.listSourceProviders()).find((each) => each.id === "openfda")?.key).toBe(
      "unset",
    );

    await core.setSourceProviderKey("openfda", `  ${key} `);

    expect(keychain.secrets.get("sources.openfda.key")).toBe(key);
    const listed = await core.listSourceProviders();
    expect(listed.find((each) => each.id === "openfda")?.key).toBe("set");
    expect(JSON.stringify(listed)).not.toContain(key);
    const result = found(await core.findSources({ query: "metformin", providers: ["openfda"] }));
    services.fail("openfda", 403);
    const failed = found(await core.findSources({ query: "aspirin", providers: ["openfda"] }));

    const sent = requestsTo(services, "openfda");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers["x-api-key"]).toBe(key);
    expect(sent.every((request) => !request.path.includes(key))).toBe(true);
    expect(JSON.stringify([result, failed])).not.toContain(key);
    expect(failed.providers[0]?.failure?.message).toBeTruthy();
    // DailyMed and ClinicalTrials.gov are never sent it.
    await core.findSources({ query: "metformin", providers: ["dailymed"] });
    expect(
      requestsTo(services, "dailymed").every(
        (request) => request.headers["x-api-key"] === undefined,
      ),
    ).toBe(true);

    await core.setSourceProviderKey("openfda", null);
    expect(keychain.secrets.has("sources.openfda.key")).toBe(false);
  });

  test("a key for a provider that takes none, or one that isn't a single token, is refused without echoing it", async () => {
    const { core } = await setUp();

    await expect(core.setSourceProviderKey("dailymed", "abc")).rejects.toThrow(/takes no key/);
    const error = await core.setSourceProviderKey("openfda", "two words").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("two words");
  });
});

describe("Reading what the services write", () => {
  test("a label's section number is read from its text however the heading is written; a company's capitals are tamed", () => {
    expect(
      numberedHeading("Dosage and administration", "2 DOSAGE & ADMINISTRATION 2.1 Adults"),
    ).toBe("2 Dosage and administration");
    expect(numberedHeading("Warnings", "WARNINGS Do not use")).toBe("Warnings");
    expect(numberedHeading("Uses", "12 months of age")).toBe("Uses");
    expect(companyName("ZYDUS LIFESCIENCES LIMITED")).toBe("Zydus Lifesciences Limited");
    expect(companyName("VISTAPHARM, LLC")).toBe("Vistapharm, LLC");
    expect(companyName("P & L Development, LLC")).toBe("P & L Development, LLC");
    expect(isoDate("Oct 08, 2026")).toBe("2026-10-08");
    expect(isoDate("sometime")).toBeNull();
  });
});

describe("Drug labels and trials: the Answer's Tool", { timeout: 30_000 }, () => {
  test("asked to find a drug label, an Answer searches the label providers only, and is told the source's disclaimer", async () => {
    let result = "";
    const model = scriptedModel((call) => {
      const searched = call.results.find((each) => each.tool === "find_sources");
      if (!searched) {
        return {
          calls: [{ tool: "find_sources", input: { query: "metformin", kind: "drug_labels" } }],
        };
      }
      result = searched.text;
      return { text: "Found the labels." };
    });
    const { core, services } = await setUp({
      createChatModel: scriptedModels(model).createChatModel,
    });
    answerConsent(core);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Labels" });
    const client = await connectToMind(core, mind.id);

    await askAndFinish(core, client, mind.id, "Find the drug label for metformin");

    const tool = model.doStreamCalls[0]?.tools?.find((each) => each.name === "find_sources");
    expect(JSON.stringify(tool)).toContain("drug_labels");
    expect(requestsTo(services, "openalex")).toEqual([]);
    expect(requestsTo(services, "openfda")).toHaveLength(1);
    expect(result).toContain("Found 3 works on openFDA and DailyMed");
    expect(result).toContain(`The source says: ${DISCLAIMER}`);
  });

  test("a Question that asks for drug labels or trials is offered the Tool, one about the User's own Documents isn't", () => {
    expect(asksForSources("Find the drug label for metformin")).toBe(true);
    expect(asksForSources("Search for clinical trials of metformin in covid")).toBe(true);
    expect(asksForSources("What is NCT04368728?")).toBe(true);
    expect(asksForSources("查找二甲双胍的药品说明书")).toBe(true);
    expect(asksForSources("What does the clinical trial in my report say about dosing?")).toBe(
      false,
    );
    expect(asksForSources("What is the label on the box?")).toBe(false);
  });
});
