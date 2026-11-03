/**
 * Find sources (#304): US federal regulations at the eCFR, and the US Code and
 * the CFR's official edition at GovInfo, looked up by citation. A section or a
 * part is added as a Document whose numbered paragraphs are Passages, so a
 * Citation points at "§ 240.10b-5(b)" and its quote is checked there. Through
 * the core's public interface, against a local stand-in answering with
 * responses recorded from the real services on 2026-10-12: no test reaches the
 * network.
 */
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { parseCfr, parseUsc } from "../../src/core/sources/citations";
import { identifierOf } from "../../src/core/sources/index";
import { asksForSources } from "../../src/core/sources/intent";
import { leadingMarkers, provisionSections } from "../../src/core/sources/provisions";
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
import { REJECTED_GOVINFO_KEY } from "../helpers/sourceServices";

const KEY = "k3y-govinfo-not-a-real-key-7f2c";

const UNOFFICIAL = "not an official legal edition of the CFR";

/** The headings of a Document's sections, in order, after its title. */
async function headings(core: Core, document: Document | null): Promise<string[]> {
  const text = await core.readDocumentText(document?.id ?? "");
  return text.pages.slice(1).map((unit) => String(unit.label?.path?.at(-1)));
}

/** All of a Document's text, as read. */
async function textOf(core: Core, document: Document | null): Promise<string> {
  const text = await core.readDocumentText(document?.id ?? "");
  return text.pages.map((unit) => unit.text).join("\n");
}

async function withKey() {
  const keychain = createMemoryKeychain();
  const setup = await setUp({ keychain });
  await setup.core.setSourceProviderKey("govinfo", KEY);
  return { ...setup, keychain };
}

describe("US regulations at the eCFR", () => {
  test("words search the regulations in force, each result marked as an unofficial compilation", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    const result = found(
      await core.findSources({ query: "manipulative and deceptive devices", providers: ["ecfr"] }),
    );

    expect(result.providers).toEqual([{ id: "ecfr", name: "eCFR", count: 5, failure: null }]);
    expect(work(result.works, /^17 CFR 240\.10b-5 /)).toMatchObject({
      key: "cfr:17 CFR 240.10b-5",
      foundBy: [{ id: "ecfr", name: "eCFR" }],
      unofficial: true,
      access: { kind: "open", format: "text", licence: { id: "public-domain" } },
      fields: {
        title: "17 CFR 240.10b-5 Employment of manipulative and deceptive devices",
        authors: [{ literal: "Securities and Exchange Commission" }],
        containerTitle: "Code of Federal Regulations (eCFR)",
      },
    });
    expect(searchOf(services, "ecfr").get("date")).toBe("current");
    expect(asked.map((request) => [request.flow.service.name, request.flow.sends])).toEqual([
      ["eCFR", ["search-terms", "work-ids"]],
    ]);
    for (const request of requestsTo(services, "ecfr")) {
      expect(request).toMatchObject({ method: "GET", bodyLength: 0, userAgent: USER_AGENT });
      // The versioner answers 406 to a request that doesn't accept a compressed answer.
      expect(request.headers["accept-encoding"]).toMatch(/gzip/);
    }
  });

  test("a search for papers doesn't go to the eCFR or GovInfo", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    await core.findSources({ query: "manipulative and deceptive devices" });

    expect(asked.map((request) => request.flow.service.name)).not.toContain("eCFR");
    expect(requestsTo(services, "ecfr")).toEqual([]);
    expect(requestsTo(services, "govinfo")).toEqual([]);
  });

  test("17 CFR 240.10b-5 is looked up and added with a Passage per paragraph, each cited as § 240.10b-5(b)", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    const result = found(await core.findSources({ query: "17 C.F.R. § 240.10b-5(b)" }));

    // With no key, GovInfo is off and says why: nothing is sent to it, and it asks nothing.
    expect(result.providers).toEqual([
      { id: "ecfr", name: "eCFR", count: 1, failure: null },
      {
        id: "govinfo",
        name: "GovInfo",
        count: 0,
        failure: { reason: "needs-key", message: expect.any(String) },
      },
    ]);
    expect(requestsTo(services, "govinfo")).toEqual([]);
    expect(asked.map((request) => request.flow.service.name)).toEqual(["eCFR"]);
    const rule = result.works[0];
    expect(rule).toMatchObject({ key: "cfr:17 CFR 240.10b-5", versionDate: "2026-10-08" });

    const { document } = await add(core, rule?.key ?? "");

    expect(await headings(core, document)).toEqual([
      "About this text",
      "240.10b-5 Employment of manipulative and deceptive devices",
      "240.10b-5(a)",
      "240.10b-5(b)",
      "240.10b-5(c)",
      "240.10b-5",
    ]);
    expect(document?.found).toMatchObject({
      provider: { id: "ecfr", name: "eCFR" },
      address: "https://www.ecfr.gov/on/2026-10-08/title-17/section-240.10b-5",
      versionDate: "2026-10-08",
      licence: { id: "public-domain" },
    });
    expect(document?.reference?.fields).toMatchObject({
      title: "17 CFR 240.10b-5 Employment of manipulative and deceptive devices",
      containerTitle: "Code of Federal Regulations (eCFR)",
    });
    const text = await textOf(core, document);
    expect(text).toContain("17 CFR 240.10b-5, as in force on 2026-10-08, from the eCFR");
    expect(text).toContain(UNOFFICIAL);
    // The text the eCFR has today, fetched once.
    expect(requestsTo(services, "ecfr").map((request) => request.path.split("?")[0])).toEqual([
      "/ecfr/api/versioner/v1/titles.json",
      "/ecfr/api/versioner/v1/ancestry/2026-10-08/title-17.json",
      "/ecfr/api/versioner/v1/full/2026-10-08/title-17.xml",
    ]);
  });

  test("a quote from paragraph (b) is found there, and placed there whatever paragraph a record names", async () => {
    const quote =
      "To make any untrue statement of a material fact or to omit to state a material fact";
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "untrue statement" } }] };
      }
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: "Rule 10b-5 forbids untrue statements [^1], and says so again [^2]." };
      }
      const passage = shownPassages(searches[0]?.text ?? "")[0]?.id ?? "";
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: [
                { marker: 1, passage, quote, location: "§ 240.10b-5(b)" },
                { marker: 2, passage, quote, location: "§ 240.10b-5(c)" },
              ],
            },
          },
        ],
      };
    });
    const { core } = await setUp({ createChatModel: scriptedModels(model).createChatModel });
    answerConsent(core);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const result = found(await core.findSources({ query: "17 CFR 240.10b-5" }));
    await add(core, result.works[0]?.key ?? "");
    const mind = await core.createMind({ title: "Rule 10b-5" });
    const client = await connectToMind(core, mind.id);

    const { finished } = await askAndFinish(core, client, mind.id, "What does Rule 10b-5 say?");

    expect(finished.citations.map((each) => [each.quote === quote, each.check])).toEqual([
      [true, "found"],
      [true, "found"],
    ]);
    for (const citation of finished.citations) {
      expect(citation.location).toMatchObject({ kind: "section", heading: "240.10b-5(b)" });
    }
  });

  test("a whole part is added, each section and each of its numbered paragraphs cited as it is", async () => {
    const { core } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "17 CFR Part 243" }));
    expect(result.works[0]?.fields.title).toBe("17 CFR Part 243—Regulation FD");

    const { document } = await add(core, result.works[0]?.key ?? "");

    expect(await headings(core, document)).toEqual(
      expect.arrayContaining([
        "Part 243—REGULATION FD",
        "243.100 General rule regarding selective disclosure",
        "243.100(a)(1)",
        "243.100(b)(1)(iv)",
        "243.100(b)(2)(iii)(F)",
        // "(e) Public disclosure. (1) Except…": its subject between the two markers.
        "243.101(e)(1)",
        "243.101(e)(2)",
        "243.102 No effect on antifraud liability",
        "243.103(b)",
      ]),
    );
    expect(await textOf(core, document)).toContain(
      "Authority: 15 U.S.C. 78c, 78i, 78j, 78m, 78o, 78w, 78mm, and 80a-29",
    );
  });

  test("a citation with a date is the version in force that day", async () => {
    const { core, services } = await setUp();
    answerConsent(core);

    const result = found(await core.findSources({ query: "17 CFR 240.10b-5 as of 2020-01-01" }));
    const { document } = await add(core, result.works[0]?.key ?? "");

    expect(result.works[0]?.key).toBe("cfr:17 CFR 240.10b-5@2020-01-01");
    expect(document?.found?.versionDate).toBe("2020-01-01");
    expect(requestsTo(services, "ecfr").map((request) => request.path.split("?")[0])).toEqual(
      expect.arrayContaining([
        "/ecfr/api/versioner/v1/ancestry/2020-01-01/title-17.json",
        "/ecfr/api/versioner/v1/full/2020-01-01/title-17.xml",
      ]),
    );
  });

  test("a section removed since is found as removed, with the text it had the day before", async () => {
    const { core } = await setUp();
    answerConsent(core);

    const result = found(await core.findSources({ query: "17 CFR 240.15Aj-1" }));

    expect(result.works).toHaveLength(1);
    expect(result.works[0]).toMatchObject({
      key: "cfr:17 CFR 240.15Aj-1@2025-03-23",
      versionDate: "2025-03-23",
      fields: {
        title:
          "17 CFR 240.15Aj-1 Amendments and supplements to registration statements of securities associations (removed 2025-03-24)",
      },
    });
    const { document } = await add(core, result.works[0]?.key ?? "");
    const text = await textOf(core, document);
    expect(text).toContain(
      "This section was removed on 2025-03-24. This is its text as in force on 2025-03-23.",
    );
    expect(await headings(core, document)).toEqual(
      expect.arrayContaining(["240.15Aj-1(c)(1)(ii)(B)", "240.15Aj-1(c)(2)"]),
    );
  });

  test("a section the eCFR never had finds nothing, without an error", async () => {
    const { core } = await setUp();
    answerConsent(core);

    const result = found(await core.findSources({ query: "17 CFR 240.99z-9" }));

    expect(result.works).toEqual([]);
    expect(result.providers.find((each) => each.id === "ecfr")?.failure).toBeNull();
  });

  test("requests to the eCFR are a second apart", async () => {
    const { core, waits } = await setUp();
    answerConsent(core);
    const result = found(await core.findSources({ query: "17 CFR 240.10b-5" }));

    await add(core, result.works[0]?.key ?? "");

    expect(waits).toEqual([1000, 1000]);
  });
});

describe("The US Code and the official CFR at GovInfo", () => {
  test("without a key GovInfo is off: it says where to get one, and is sent nothing", async () => {
    const { core, services } = await setUp();
    const asked = answerConsent(core);

    const listed = (await core.listSourceProviders()).find((each) => each.id === "govinfo");
    const result = found(await core.findSources({ query: "42 U.S.C. § 1983" }));

    expect(listed).toMatchObject({
      key: "unset",
      keyNeeded: true,
      keySignUp: "https://www.govinfo.gov/api-signup",
      searches: false,
    });
    expect(result.providers).toEqual([
      expect.objectContaining({
        id: "govinfo",
        failure: expect.objectContaining({ reason: "needs-key" }),
      }),
    ]);
    expect(requestsTo(services, "govinfo")).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("42 U.S.C. § 1983 resolves with the User's key, in a header only, and is added by section and notes", async () => {
    const { core, services, keychain } = await withKey();
    const asked = answerConsent(core);

    const result = found(await core.findSources({ query: "42 U.S.C. § 1983" }));

    expect(keychain.secrets.get("sources.govinfo.key")).toBe(KEY);
    // Consent says the key is sent, to GovInfo alone.
    expect(asked.map((request) => [request.flow.service.name, request.flow.sends])).toEqual([
      ["GovInfo", ["search-terms", "work-ids", "provider-key"]],
    ]);
    expect(result.works[0]).toMatchObject({
      key: "govinfo:USCODE-2024-title42-chap21-subchapI-sec1983",
      unofficial: false,
      fields: {
        title: "42 U.S.C. § 1983 Civil action for deprivation of rights",
        containerTitle: "United States Code, 2024 edition",
      },
      landingUrl:
        "https://www.govinfo.gov/app/details/USCODE-2024-title42/USCODE-2024-title42-chap21-subchapI-sec1983",
    });

    const { document } = await add(core, result.works[0]?.key ?? "");

    expect(await headings(core, document)).toEqual([
      "About this text",
      "1983 Civil action for deprivation of rights",
      "Editorial Notes",
      "Codification",
      "Amendments",
      "Statutory Notes and Related Subsidiaries",
      "Effective Date of 1979 Amendment",
    ]);
    expect(document?.found).toMatchObject({
      provider: { id: "govinfo", name: "GovInfo" },
      versionDate: "2025-01-06",
    });
    const text = await textOf(core, document);
    expect(text).toContain("United States Code, 2024 edition, current through 2025-01-06");
    expect(text).toContain("Every person who, under color of any statute");
    // The link service is asked without the key; the API with it, in a header, never in an address.
    const sent = requestsTo(services, "govinfo");
    expect(sent.map((request) => request.path.split("?")[0])).toEqual([
      "/govinfo/link/uscode/42/1983",
      "/govinfo/packages/USCODE-2024-title42/granules/USCODE-2024-title42-chap21-subchapI-sec1983/summary",
      "/govinfo/packages/USCODE-2024-title42/granules/USCODE-2024-title42-chap21-subchapI-sec1983/htm",
    ]);
    expect(sent.map((request) => request.headers["x-api-key"])).toEqual([undefined, KEY, KEY]);
    expect(sent.every((request) => !request.path.includes(KEY))).toBe(true);
    expect(JSON.stringify([result, document, await core.listSourceProviders()])).not.toContain(KEY);
    expect(text).not.toContain(KEY);
  });

  test("a section with subsections is added with one Passage per subsection and paragraph", async () => {
    const { core } = await withKey();
    answerConsent(core);
    const result = found(await core.findSources({ query: "15 USC 78j(b)" }));

    const { document } = await add(core, result.works[0]?.key ?? "");

    expect(await headings(core, document)).toEqual(
      expect.arrayContaining([
        "78j Manipulative and deceptive devices",
        "78j(a)(1)",
        "78j(a)(2)",
        "78j(b)",
        "78j(c)(2)",
        // The text after the list belongs to the whole section, as it sits at its margin.
        "78j",
      ]),
    );
    expect(await textOf(core, document)).not.toMatch(/agreement\s+1\s+any/);
  });

  test("a CFR citation finds the eCFR's text and GovInfo's official edition, as two works", async () => {
    const { core } = await withKey();
    answerConsent(core);

    const result = found(await core.findSources({ query: "17 CFR 240.10b-5" }));

    expect(result.works.map((each) => [each.key, each.unofficial])).toEqual(
      expect.arrayContaining([
        ["cfr:17 CFR 240.10b-5", true],
        ["govinfo:CFR-2025-title17-vol4-sec240-10b-5", false],
      ]),
    );
    const official = work(result.works, /^17 CFR 240\.10b-5 /);
    const fromGovinfo = result.works.find((each) => each.key.startsWith("govinfo:"));
    expect(fromGovinfo?.fields.containerTitle).toBe(
      "Code of Federal Regulations, annual edition 2025",
    );
    expect(official).toBeTruthy();

    const { document } = await add(core, fromGovinfo?.key ?? "");
    expect(await headings(core, document)).toEqual([
      "About this text",
      "240.10b-5 Employment of manipulative and deceptive devices",
      "240.10b-5(a)",
      "240.10b-5(b)",
      "240.10b-5(c)",
      "240.10b-5",
    ]);
    const text = await textOf(core, document);
    expect(text).toContain("annual edition revised as of 2025-04-01");
    expect(text).not.toContain(UNOFFICIAL);
  });

  test("a key GovInfo turns away says so, and the key appears in no message", async () => {
    const keychain = createMemoryKeychain();
    const { core } = await setUp({ keychain });
    await core.setSourceProviderKey("govinfo", REJECTED_GOVINFO_KEY);
    answerConsent(core);

    const result = found(await core.findSources({ query: "42 U.S.C. 1983" }));

    const failure = result.providers[0]?.failure;
    expect(failure?.reason).toBe("key-rejected");
    expect(JSON.stringify(result)).not.toContain(REJECTED_GOVINFO_KEY);
  });

  test("a 429 stops the lookup with one plain problem, and an add that meets one keeps nothing", async () => {
    const { core, services } = await withKey();
    answerConsent(core);
    const result = found(await core.findSources({ query: "42 U.S.C. 1983" }));
    services.fail("govinfo", 429);

    const again = found(await core.findSources({ query: "15 U.S.C. 78j" }));
    const added = await core.addFoundSource({ key: result.works[0]?.key ?? "" });

    expect(again.providers[0]?.failure?.reason).toBe("rate-limited");
    expect(added).toMatchObject({ outcome: "failed", reason: "rate-limited" });
    expect(await core.listDocuments()).toEqual([]);
    // Each was asked once, and not again: a long Retry-After isn't waited for.
    const limited = requestsTo(services, "govinfo").slice(2);
    expect(limited.map((request) => request.path.split("?")[0])).toEqual([
      "/govinfo/link/uscode/15/78j",
      "/govinfo/packages/USCODE-2024-title42/granules/USCODE-2024-title42-chap21-subchapI-sec1983/htm",
    ]);
  });
});

describe("US law: consent and local mode", () => {
  test("a provider the User declines is never sent anything", async () => {
    const { core, services } = await withKey();
    answerConsent(core, ["eCFR"]);

    const result = found(await core.findSources({ query: "17 CFR 240.10b-5" }));

    expect(result.providers.find((each) => each.id === "ecfr")?.failure?.reason).toBe("declined");
    expect(requestsTo(services, "ecfr")).toEqual([]);
    expect(result.works.map((each) => each.key)).toEqual([
      "govinfo:CFR-2025-title17-vol4-sec240-10b-5",
    ]);
  });

  test("local mode blocks both: nothing is asked, and nothing is added", async () => {
    const { core, services } = await withKey();
    const asked = answerConsent(core);
    const result = found(await core.findSources({ query: "17 CFR 240.10b-5" }));
    await core.setLocalOnly(true);
    const before = services.requests.length;

    expect(await core.findSources({ query: "42 U.S.C. 1983" })).toEqual({ outcome: "local-mode" });
    expect(await core.findSources({ query: "manipulative", providers: ["ecfr"] })).toEqual({
      outcome: "local-mode",
    });
    expect(await core.addFoundSource({ key: result.works[0]?.key ?? "" })).toMatchObject({
      outcome: "failed",
      reason: "local-mode",
    });
    expect(services.requests).toHaveLength(before);
    expect(asked.map((request) => request.flow.service.name).sort()).toEqual(["GovInfo", "eCFR"]);
  });
});

describe("Reading citations and provisions", () => {
  test("CFR and US Code citations are read however they are written", () => {
    expect(parseCfr("17 C.F.R. § 240.10b-5(b)")).toEqual({
      title: 17,
      part: "240",
      section: "240.10b-5",
      date: null,
    });
    expect(parseCfr("17 CFR Part 243")).toMatchObject({ part: "243", section: null });
    expect(parseCfr("17 cfr 240")).toMatchObject({ part: "240", section: null });
    expect(parseCfr("Title 17 CFR 240.15Aj-1 (2019-06-30)")).toMatchObject({
      section: "240.15Aj-1",
      date: "2019-06-30",
    });
    expect(parseCfr("17 CFR 240.10b-5 on 2019-02-30")).toBeNull();
    expect(parseUsc("42 U.S.C. § 1983")).toEqual({ title: 42, section: "1983" });
    expect(parseUsc("15 USC 78u–4(b)(1)")).toEqual({ title: 15, section: "78u-4" });
    expect(parseUsc("42 U.S. Code § 1983")).toEqual({ title: 42, section: "1983" });
    for (const words of ["CFR", "17 CFR", "240.10b-5", "insider trading", "Section 1983"]) {
      expect(identifierOf(words)).toBeNull();
    }
    expect(identifierOf("17 CFR 240.10b-5 as of 2019-06-30")).toEqual({
      kind: "cfr",
      id: "17 CFR 240.10b-5@2019-06-30",
    });
    expect(identifierOf("42 USC 1983")).toEqual({ kind: "usc", id: "42 U.S.C. 1983" });
  });

  test("a paragraph's depth is read from the markers around it, the CFR's order and the US Code's", () => {
    const sections = (cite: string, lines: string[]) =>
      provisionSections(
        cite,
        cite,
        1,
        lines.map((line) => ({ kind: "paragraph" as const, ...leadingMarkers(line) })),
      ).map((each) => each.heading);

    // "(i)" after "(h)" is a letter; after "(1)", a Roman numeral.
    expect(sections("1.1", ["(h) H.", "(i) I.", "(j) J."])).toEqual([
      "1.1",
      "1.1(h)",
      "1.1(i)",
      "1.1(j)",
    ]);
    expect(
      sections("1.1", ["(h) H.", "(1) One.", "(i) First.", "(ii) Second.", "(i) Next."]),
    ).toEqual(["1.1", "1.1(h)", "1.1(h)(1)", "1.1(h)(1)(i)", "1.1(h)(1)(ii)", "1.1(i)"]);
    // The US Code: (a), (1), (A), (i), (I).
    expect(
      sections("78j", ["(a)(1)(A) Text.", "(i) Clause.", "(I) Subclause.", "(B) Next."]),
    ).toEqual(["78j", "78j(a)(1)(A)", "78j(a)(1)(A)(i)", "78j(a)(1)(A)(i)(I)", "78j(a)(1)(B)"]);
    // The CFR's italic levels.
    expect(sections("1.2", ["(a)(1)(i)(A) Text.", "(1) Italic one.", "(i) Italic i."])).toEqual(
      ["1.2", "1.2(a)(1)(i)(A)", "1.2(a)(1)(i)(A)(1)", "1.2(a)(1)(i)(A)(1)(i)"],
    );
  });
});

describe("US law: the Answer's Tool", { timeout: 30_000 }, () => {
  test("asked to look a regulation up, an Answer searches the eCFR, not the paper providers", async () => {
    let result = "";
    const model = scriptedModel((call) => {
      const searched = call.results.find((each) => each.tool === "find_sources");
      if (!searched) {
        return {
          calls: [
            {
              tool: "find_sources",
              input: { query: "manipulative and deceptive devices", kind: "us_law" },
            },
          ],
        };
      }
      result = searched.text;
      return { text: "Found the regulations." };
    });
    const { core, services } = await setUp({
      createChatModel: scriptedModels(model).createChatModel,
    });
    answerConsent(core);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Regulations" });
    const client = await connectToMind(core, mind.id);

    await askAndFinish(
      core,
      client,
      mind.id,
      "Look up the federal regulations on manipulative devices",
    );

    const tool = model.doStreamCalls[0]?.tools?.find((each) => each.name === "find_sources");
    expect(JSON.stringify(tool)).toContain("us_law");
    expect(requestsTo(services, "openalex")).toEqual([]);
    expect(requestsTo(services, "ecfr")).toHaveLength(1);
    expect(result).toContain("Found 5 works on eCFR");
    expect(result).toContain("An unofficial compilation, not the official edition.");
  });

  test("a Question that cites a regulation or asks to find one is offered the Tool; one about the User's own Documents isn't", () => {
    expect(asksForSources("What does 17 CFR 240.10b-5 say about omissions?")).toBe(true);
    expect(asksForSources("Look up 42 U.S.C. § 1983")).toBe(true);
    expect(asksForSources("Find the federal regulations on insider trading")).toBe(true);
    expect(asksForSources("查找美国联邦法规中关于内幕交易的条款")).toBe(true);
    expect(asksForSources("What does section 5 of my lease say?")).toBe(false);
    expect(asksForSources("Summarise the rules in this handbook")).toBe(false);
  });
});
