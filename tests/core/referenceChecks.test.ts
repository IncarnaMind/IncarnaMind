import { describe, expect, onTestFinished, test } from "vitest";
import type { CheckReferencesResult, Core, CoreEvents } from "../../src/core";
import { createLookupCache } from "../../src/core/referenceChecks/cache";
import type { Lookups } from "../../src/core/referenceChecks/lookups";
import {
  citedReference,
  differences,
  holdsTitle,
  titleCoverage,
  titleOf,
  type WorkRecord,
} from "../../src/core/referenceChecks/match";
import { migrate, openDatabase } from "../../src/core/storage";
import { checkableReferences } from "../../src/shared/referenceList";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { unusedLocalUrl } from "../helpers/ollama";
import {
  type CrossrefWork,
  type OpenAlexWork,
  type ReferenceServices,
  recordedAnswer,
  startReferenceServices,
} from "../helpers/referenceServices";

/*
 * Checking a reference list: each entry looked up in Crossref, by DOI
 * or as written, then in OpenAlex, and an arXiv number on arXiv, and marked
 * found, doesn't match, not found, not listed or not checked. A local
 * stand-in answers for all three: no test reaches the real ones.
 */

const LSTM: CrossrefWork = {
  DOI: "10.1162/neco.1997.9.8.1735",
  title: ["Long Short-Term Memory"],
  author: [
    { family: "Hochreiter", given: "Sepp" },
    { family: "Schmidhuber", given: "Jürgen" },
  ],
  issued: { "date-parts": [[1997, 11, 1]] },
  "container-title": ["Neural Computation"],
  type: "journal-article",
};
const DEEP: CrossrefWork = {
  DOI: "10.1038/nature14539",
  title: ["Deep learning"],
  author: [
    { family: "LeCun", given: "Yann" },
    { family: "Bengio", given: "Yoshua" },
    { family: "Hinton", given: "Geoffrey" },
  ],
  issued: { "date-parts": [[2015, 5, 27]] },
  "container-title": ["Nature"],
  type: "journal-article",
};

const REAL =
  "Hochreiter, S., & Schmidhuber, J. (1997). Long short-term memory. Neural Computation, 9(8), 1735–1780.";
const BY_DOI =
  "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521, 436–444. doi:10.1038/nature14539";
const INVENTED =
  "Marlowe, T. (2019). Quantum gradient folding in recurrent attention lattices. Journal of Imagined Results, 4, 1–9.";
const WRONG_YEAR =
  "Hochreiter, S., & Schmidhuber, J. (2003). Long short-term memory. Neural Computation.";
const WRONG_AUTHOR = "Smith, A. (2015). Deep learning. Nature. doi:10.1038/nature14539";
const DEAD_DOI = "Doe, J. (2020). A study of nothing much at all. doi:10.9999/nowhere.42";
const PREPRINT =
  "Kingma, D. P., & Ba, J. (2014). Adam: A method for stochastic optimization. arXiv preprint arXiv:1412.6980.";
const INVENTED_PREPRINT =
  "Ray, S. (2023). Recursive gradient lattices for sparse memory. arXiv preprint arXiv:2399.00001.";
const WEB_PAGE = "OpenAI. (2022). Introducing ChatGPT. https://openai.com/blog/chatgpt";
const CONFERENCE =
  "Brown, T., Mann, B., et al. (2020). Language models are few-shot learners. Advances in Neural Information Processing Systems, 33.";
const ON_ARXIV =
  "Vaswani, A., et al. (2017). Attention is all you need. arXiv preprint arXiv:1706.03762.";
const DATASET =
  "Doe, A. (2021). Measurements of widgets in coastal towns. Zenodo. doi:10.5281/zenodo.123456";

/** OpenAlex's records: a conference paper Crossref lacks, and an arXiv preprint by its DOI. */
const OPENALEX_WORKS: OpenAlexWork[] = [
  {
    id: "https://openalex.org/W3030163527",
    doi: "https://doi.org/10.48550/arxiv.2005.14165",
    display_name: "Language Models are Few-Shot Learners",
    publication_date: "2020-05-28",
    authorships: [{ author: { display_name: "Tom B. Brown" } }],
  },
  {
    id: "https://openalex.org/W1522301498",
    doi: "https://doi.org/10.48550/arxiv.1412.6980",
    display_name: "Adam: A Method for Stochastic Optimization",
    publication_date: "2014-12-22",
    authorships: [{ author: { display_name: "Diederik P. Kingma" } }],
  },
];

/** A core whose Crossref is the stand-in, with a Mind whose reference list holds `entries`. */
async function setUp(
  entries: readonly string[],
  {
    localOnly = false,
    works = [LSTM, DEEP],
    openalex = OPENALEX_WORKS,
    reuse,
    now,
  }: {
    localOnly?: boolean;
    works?: CrossrefWork[];
    openalex?: OpenAlexWork[];
    /** The data folder and stand-in of an earlier core, as after a restart. */
    reuse?: { dataDir: string; services: ReferenceServices };
    now?: () => Date;
  } = {},
) {
  const services =
    reuse?.services ??
    (await startReferenceServices({
      works,
      registered: {
        "10.48550/arXiv.1412.6980": "datacite",
        "10.48550/arXiv.1706.03762": "datacite",
        "10.5281/zenodo.123456": "datacite",
      },
      openalex,
      arxiv: { "1706.03762": recordedAnswer("arxiv-attention.xml") },
    }));
  if (!reuse) onTestFinished(() => services.close());
  const dataDir = reuse?.dataDir ?? (await createTempDataFolder());
  const core: Core = startCore(dataDir, {
    ...(now && { now }),
    referenceLookup: { crossref: services.url, arxiv: services.url, openalex: services.url },
  });
  if (localOnly) await core.setLocalOnly(true);
  const mind = await core.createMind({ title: "Draft" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    note("Recurrent networks remember (Hochreiter & Schmidhuber, 1997)."),
    heading(2, "References"),
    ...entries.map((entry) => note(entry)),
  ]);
  await client.settled();
  return { core, services, dataDir, mindId: mind.id };
}

const marksOf = (result: CheckReferencesResult) => {
  if (result.kind !== "checked") throw new Error(`Not checked: ${result.kind}`);
  return result.references.map(({ mark }) => mark);
};

/** Starts a check, lets its Crossref answer through, and holds its OpenAlex answer: in flight, with that answer kept. */
async function checkUpToOpenAlex(core: Core, services: ReferenceServices, mindId: string) {
  const first = services.pause();
  const checking = core.checkReferences(mindId);
  await first.reached;
  first.release();
  const openalex = services.pause("openalex");
  await openalex.reached;
  return { checking, openalex };
}

/** Another Mind with the same entries, so a second check of the same lookups can be in flight at once. */
async function otherList(core: Core, entries: readonly string[]): Promise<string> {
  const mind = await core.createMind({ title: "Draft" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(2, "References"), ...entries.map((entry) => note(entry))]);
  await client.settled();
  return mind.id;
}

describe("Checking a reference list", { timeout: 30_000 }, () => {
  // protects=each mark and the service that gave it: found in Crossref by search and by DOI, in OpenAlex by title (a conference paper) and by DOI (an arXiv preprint), on arXiv; not listed (in neither Crossref nor OpenAlex); not found (a DOI or arXiv number leading nowhere); doesn't match (year, author); not checked when another agency holds a DOI neither has; a web page isn't looked up; only the reference is sent; checking again asks nothing twice; fails_when=a mark is wrong, a search miss reads as an invented reference, a preprint reads as not found, more than the reference goes, or a reference is asked about again; no_claim=Crossref's real matching (the evaluation, eval/references).
  test("every entry gets its mark, and only the reference is sent", async () => {
    const entries = [
      REAL,
      BY_DOI,
      INVENTED,
      WRONG_YEAR,
      WRONG_AUTHOR,
      DEAD_DOI,
      WEB_PAGE,
      PREPRINT,
      INVENTED_PREPRINT,
      CONFERENCE,
      ON_ARXIV,
      DATASET,
    ];
    const { core, services, mindId } = await setUp(entries);
    const progress: CoreEvents["referenceCheck.progress"][] = [];
    core.on("referenceCheck.progress", (event) => progress.push(event));

    const result = await core.checkReferences(mindId);

    if (result.kind !== "checked") throw new Error(`Not checked: ${result.kind}`);
    expect(result.references.map(({ mark, service, reason }) => [mark, service, reason])).toEqual([
      ["found", "crossref", null],
      ["found", "crossref", null],
      ["not-listed", null, null],
      ["mismatch", "crossref", null],
      ["mismatch", "crossref", null],
      ["not-found", "crossref", null],
      ["found", "openalex", null],
      ["not-found", "crossref", null],
      ["found", "openalex", null],
      ["found", "arxiv", null],
      ["not-checked", null, "registered-elsewhere"],
    ]);
    const [real, byDoi, , wrongYear, wrongAuthor] = result.references;
    expect(real?.record).toEqual({
      title: "Long Short-Term Memory",
      authors: [
        { family: "Hochreiter", given: "Sepp" },
        { family: "Schmidhuber", given: "Jürgen" },
      ],
      year: 1997,
      doi: "10.1162/neco.1997.9.8.1735",
    });
    expect(byDoi?.record?.doi).toBe("10.1038/nature14539");
    expect(wrongYear?.differences).toEqual([{ field: "year", found: "1997", cited: "2003" }]);
    expect(wrongAuthor?.differences).toEqual([
      { field: "authors", found: "LeCun, Bengio, Hinton", cited: null },
    ]);
    // The paragraph before the list isn't a reference; each request carries one reference.
    for (const request of services.requests) {
      expect(request.bodyLength).toBe(0);
      expect(decodeURIComponent(request.path)).not.toContain("Recurrent networks remember");
    }
    expect(services.requests.some(({ path }) => path.toLowerCase().includes("openai"))).toBe(false);
    expect(progress.at(-1)).toEqual({ mindId, done: 11, total: 11 });

    // Checked again, nothing is asked twice.
    const asked = services.requests.length;
    expect(await core.checkReferences(mindId)).toEqual(result);
    expect(services.requests).toHaveLength(asked);
  });

  // protects=a work with several records (a later reprint first) is found by the one it matches; fails_when=the reprint's year reads as a mismatch; no_claim=none beyond protects.
  test("of a work's several records, the one it matches is taken", async () => {
    const reprint: CrossrefWork = {
      ...LSTM,
      DOI: "10.5555/reprint.2020",
      issued: { "date-parts": [[2020]] },
    };
    const { core, mindId } = await setUp([REAL], { works: [reprint, LSTM] });

    expect(await core.checkReferences(mindId)).toMatchObject({
      kind: "checked",
      references: [{ mark: "found", record: { doi: "10.1162/neco.1997.9.8.1735", year: 1997 } }],
    });
  });

  // protects=a list checked once is checked again, after a restart too, without asking any service, so re-checks never spend OpenAlex's free daily allowance, and each mark still names the service its record came from; fails_when=a re-check sends a request, or a kept answer loses its service or changes a mark; no_claim=a failure, which isn't kept.
  test("checking the same list again, after a restart, asks no service and names the same sources", async () => {
    const entries = [REAL, BY_DOI, CONFERENCE, PREPRINT, INVENTED, WRONG_YEAR];
    const first = await setUp(entries);
    const before = await first.core.checkReferences(first.mindId);
    const asked = first.services.requests.length;
    first.core.close();

    const again = await setUp(entries, { reuse: first });
    const after = await again.core.checkReferences(again.mindId);

    expect(first.services.requests).toHaveLength(asked);
    const marks = (result: CheckReferencesResult) =>
      result.kind === "checked"
        ? result.references.map(({ mark, service, record, differences, reason }) => ({
            mark,
            service,
            record,
            differences,
            reason,
          }))
        : [];
    expect(marks(after)).toEqual(marks(before));
    expect(marks(after).map((check) => check.service)).toEqual([
      "crossref",
      "crossref",
      "openalex",
      "openalex",
      null,
      "crossref",
    ]);
  });

  // protects=a miss (a DOI no agency has registered yet, a work no service lists yet) is kept, so checking the list again sends nothing, however long after; Check again, the User asking for a fresh look, asks about misses at once; a found record is kept even then; fails_when=a re-check sends a request, Check again serves a kept miss, or a found record is asked about again; no_claim=none beyond protects.
  test("checking again sends nothing once sent; Check again asks about misses again", async () => {
    const clock = manualClock();
    const { core, services, mindId } = await setUp([REAL, INVENTED, DEAD_DOI], { now: clock.now });
    const newRequests = async (again: boolean) => {
      const before = services.requests.length;
      await core.checkReferences(mindId, { again });
      return services.requests
        .slice(before)
        .map(({ path }) => decodeURIComponent(path.replaceAll("+", " ")));
    };

    expect(await newRequests(false)).not.toEqual([]);
    expect(await newRequests(false)).toEqual([]);

    const askedAgain = await newRequests(true);
    expect(askedAgain.some((path) => path.includes("Quantum gradient folding"))).toBe(true);
    expect(askedAgain.some((path) => path.includes("10.9999/nowhere.42"))).toBe(true);
    expect(askedAgain.some((path) => path.includes("Long short-term memory"))).toBe(false);

    // Kept for good: a year later, checking again still sends nothing.
    clock.advance(366 * 24 * 60 * 60_000);
    expect(await newRequests(false)).toEqual([]);
  });

  // protects=a failure racing a successful lookup neither replaces that answer nor becomes kept: an ordinary check and Check again still replay the answer; fails_when=the failure replaces the answer and is kept, so a later check reads a service failure; no_claim=none beyond protects.
  test("a failure racing a successful lookup neither replaces it nor is kept", async () => {
    const { core, services, mindId } = await setUp([WRONG_YEAR]);
    const other = await otherList(core, [WRONG_YEAR]);
    const { checking, openalex } = await checkUpToOpenAlex(core, services, mindId);

    // A Check again of the same entries fails while the first check is in flight, after its Crossref answer was stored.
    services.fail(500);
    await core.checkReferences(other, { again: true });
    services.fail(null);
    openalex.release();
    expect(marksOf(await checking)).toEqual(["mismatch"]);

    // The answer is kept: neither an ordinary check nor Check again asks or reads a failure.
    const asked = services.requests.length;
    expect(marksOf(await core.checkReferences(mindId))).toEqual(["mismatch"]);
    expect(marksOf(await core.checkReferences(mindId, { again: true }))).toEqual(["mismatch"]);
    expect(services.requests).toHaveLength(asked);
  });

  // protects=a settled answer stays when a request that began before it settled then fails; fails_when=the later failure replaces the settled answer, so a later check reads a service failure; no_claim=none beyond protects.
  test("a failure doesn't replace a settled answer", async () => {
    const { core, services, mindId } = await setUp([WRONG_YEAR]);
    const other = await otherList(core, [WRONG_YEAR]);
    const { checking, openalex } = await checkUpToOpenAlex(core, services, mindId);

    // A Check again of the same entries is under way when the first check settles; its Crossref answer, asked before, fails after.
    const later = services.pause();
    const retried = core.checkReferences(other, { again: true });
    await later.reached;
    openalex.release();
    expect(marksOf(await checking)).toEqual(["mismatch"]);
    services.fail(500);
    later.release();
    await retried;
    services.fail(null);

    const asked = services.requests.length;
    expect(marksOf(await core.checkReferences(mindId))).toEqual(["mismatch"]);
    expect(marksOf(await core.checkReferences(mindId, { again: true }))).toEqual(["mismatch"]);
    expect(services.requests).toHaveLength(asked);
  });

  // protects=a settled answer stays when a request that began before it settled then answers otherwise (here, with nothing): an ordinary check and Check again still replay it and send nothing; fails_when=the later answer replaces the settled one, so the reference reads not listed; no_claim=none beyond protects.
  test("a later answer doesn't replace a settled one", async () => {
    const works = [LSTM];
    const { core, services, mindId } = await setUp([WRONG_YEAR], { works });
    const other = await otherList(core, [WRONG_YEAR]);
    const { checking, openalex } = await checkUpToOpenAlex(core, services, mindId);

    // A Check again of the same entries is under way when the first check settles; by the time Crossref answers it, Crossref no longer lists the work.
    const later = services.pause();
    const retried = core.checkReferences(other, { again: true });
    await later.reached;
    openalex.release();
    expect(marksOf(await checking)).toEqual(["mismatch"]);
    works.splice(0);
    later.release();
    expect(marksOf(await retried)).toEqual(["not-listed"]);

    const asked = services.requests.length;
    expect(marksOf(await core.checkReferences(mindId))).toEqual(["mismatch"]);
    expect(marksOf(await core.checkReferences(mindId, { again: true }))).toEqual(["mismatch"]);
    expect(services.requests).toHaveLength(asked);
  });

  // protects=Crossref is sent the whole entry, so a same-titled entry by other authors is asked about on its own; fails_when=it reuses another entry's candidates; no_claim=none beyond protects.
  test("a same-titled entry by other authors is asked about on its own", async () => {
    const { core, services, mindId } = await setUp([
      REAL,
      "Smith, A. (1997). Long short-term memory. Neural Computation.",
    ]);

    await core.checkReferences(mindId);

    const searches = services.requests.filter(({ path }) => path.includes("query.bibliographic"));
    expect(searches).toHaveLength(2);
  });

  // protects=no request to Crossref, OpenAlex or arXiv carries an e-mail address: no mailto parameter, and nothing but IncarnaMind's name and address in the User-Agent; fails_when=a contact address is added to a request; no_claim=none beyond protects.
  test("no request carries an e-mail address", async () => {
    const { core, services, mindId } = await setUp([REAL, BY_DOI, CONFERENCE, PREPRINT, INVENTED]);

    await core.checkReferences(mindId);

    expect(services.requests.length).toBeGreaterThan(0);
    for (const request of services.requests) {
      expect(decodeURIComponent(request.path)).not.toMatch(/mailto|@/i);
      expect(request.userAgent).not.toMatch(/mailto|@/i);
    }
  });

  // protects=starting the check is the consent (ADR-0022): no dialog, and Settings › Privacy lists it as chosen for each of Crossref, OpenAlex and arXiv; fails_when=a dialog opens, or a service a reference may go to isn't listed; no_claim=the line by the action, which the e2e covers.
  test("starting it is the consent: nothing asks, and Privacy lists every service", async () => {
    const { core, mindId } = await setUp([REAL]);
    const asked: string[] = [];
    core.on("consent.requested", (request) => asked.push(request.flow.id));

    await core.checkReferences(mindId);

    expect(asked).toEqual([]);
    const listed = (await core.listDataFlows()).filter(
      (status) => status.flow.id === "reference-check",
    );
    expect(listed.map((status) => status.flow.service.name).sort()).toEqual([
      "Crossref",
      "OpenAlex",
      "arXiv",
    ]);
    for (const status of listed) {
      expect(status).toMatchObject({
        flow: { sends: ["references"] },
        consent: "accepted",
        chosen: true,
      });
    }
  });

  // protects=local mode sends nothing and says so for each entry; fails_when=a request is made; no_claim=none beyond protects.
  test("in local mode nothing is sent, and every entry says why it wasn't checked", async () => {
    const { core, services, mindId } = await setUp([REAL, INVENTED], { localOnly: true });

    const result = await core.checkReferences(mindId);

    expect(result).toMatchObject({
      kind: "checked",
      references: [
        { mark: "not-checked", reason: "local-mode" },
        { mark: "not-checked", reason: "local-mode" },
      ],
    });
    expect(services.requests).toEqual([]);
  });

  // protects=a failing or unreachable Crossref leaves entries not checked with the reason, never "not found"; offline, one request fails and the rest aren't sent; fails_when=a failure reads as not found, or every entry is tried offline; no_claim=none beyond protects.
  test("when Crossref fails or can't be reached, entries are not checked, never not found", async () => {
    const failing = await setUp([REAL, INVENTED]);
    failing.services.fail(500);
    expect(await failing.core.checkReferences(failing.mindId)).toMatchObject({
      kind: "checked",
      references: [
        { mark: "not-checked", reason: "service-error" },
        { mark: "not-checked", reason: "service-error" },
      ],
    });

    const dropped = await setUp([REAL, INVENTED, WRONG_YEAR, DEAD_DOI]);
    dropped.services.fail("unreachable");
    expect(await dropped.core.checkReferences(dropped.mindId)).toMatchObject({
      kind: "checked",
      references: Array.from({ length: 4 }, () => ({ mark: "not-checked", reason: "unreachable" })),
    });
    expect(dropped.services.requests).toHaveLength(1);
    // A kept failure: checking again sends nothing...
    expect(await dropped.core.checkReferences(dropped.mindId)).toMatchObject({
      kind: "checked",
      references: Array.from({ length: 4 }, () => ({ mark: "not-checked", reason: "unreachable" })),
    });
    expect(dropped.services.requests).toHaveLength(1);
    // ...and Try again, the User asking for a fresh look, checks them all.
    dropped.services.fail(null);
    expect(await dropped.core.checkReferences(dropped.mindId, { again: true })).toMatchObject({
      kind: "checked",
      references: [
        { mark: "found" },
        { mark: "not-listed" },
        { mark: "mismatch" },
        { mark: "not-found" },
      ],
    });

    const offline = startCore(await createTempDataFolder(), {
      referenceLookup: {
        crossref: await unusedLocalUrl(),
        arxiv: await unusedLocalUrl(),
        openalex: await unusedLocalUrl(),
      },
    });
    const mind = await offline.createMind({ title: "Offline" });
    const client = await connectToMind(offline, mind.id);
    writeMind(client, [heading(2, "参考文献"), note(REAL)]);
    await client.settled();
    expect(await offline.checkReferences(mind.id)).toMatchObject({
      kind: "checked",
      references: [{ mark: "not-checked", reason: "unreachable" }],
    });
  });

  // protects=a Crossref record of another edition (a later year) gives way to OpenAlex's record of the one cited, while a year OpenAlex doesn't confirm stays a mismatch; fails_when=Crossref's other edition makes a real reference "doesn't match", or a wrong year is let through; no_claim=none beyond protects.
  test("when Crossref's record differs, OpenAlex's closer record is kept", async () => {
    const reprint: CrossrefWork = {
      DOI: "10.5555/attention.2025",
      title: ["Attention Is All You Need"],
      author: [{ family: "Vaswani", given: "Ashish" }],
      issued: { "date-parts": [[2025]] },
    };
    const original: OpenAlexWork = {
      id: "https://openalex.org/W2963403868",
      doi: "https://doi.org/10.48550/arxiv.1706.03762",
      display_name: "Attention Is All You Need",
      publication_date: "2017-06-12",
      authorships: [{ author: { display_name: "Ashish Vaswani" } }],
    };
    const cited =
      "Vaswani, A., et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30.";
    const wrongYear =
      "Vaswani, A., et al. (2019). Attention is all you need. Advances in Neural Information Processing Systems, 30.";
    const { core, mindId } = await setUp([cited, wrongYear], {
      works: [reprint],
      openalex: [original],
    });

    expect(await core.checkReferences(mindId)).toMatchObject({
      kind: "checked",
      references: [
        { mark: "found", service: "openalex", record: { year: 2017 } },
        { mark: "mismatch", service: "crossref", differences: [{ field: "year" }] },
      ],
    });
  });

  // protects=by an arXiv number, an OpenAlex record dated otherwise gives way to arXiv's record of the preprint, as OpenAlex dates "Attention is all you need" 2025; fails_when=the real preprint reads "doesn't match"; no_claim=none beyond protects.
  test("by an arXiv number, OpenAlex's record that differs gives way to arXiv's", async () => {
    const redated: OpenAlexWork = {
      id: "https://openalex.org/W2626778328",
      doi: "https://doi.org/10.48550/arxiv.1706.03762",
      display_name: "Attention Is All You Need",
      publication_date: "2025-08-23",
      authorships: [{ author: { display_name: "Ashish Vaswani" } }],
    };
    const { core, mindId } = await setUp([ON_ARXIV], { openalex: [redated] });

    expect(await core.checkReferences(mindId)).toMatchObject({
      kind: "checked",
      references: [{ mark: "found", service: "arxiv", record: { year: 2017 } }],
    });
  });

  // protects=OpenAlex offline: Crossref's answers stand, the first miss isn't checked with OpenAlex named, and OpenAlex isn't asked again; fails_when=a miss reads as not listed when OpenAlex wasn't asked, or each miss tries OpenAlex; no_claim=none beyond protects.
  // protects=a record that differs is no verdict while the service that might hold the cited edition can't be asked: the reference isn't checked, with the service named, so the line shows the problem; fails_when=an outage reads as "doesn't match"; no_claim=none beyond protects.
  test("when OpenAlex can't be reached after Crossref's record differs, the reference isn't checked", async () => {
    const { core, services, mindId } = await setUp([WRONG_YEAR]);
    services.fail("unreachable", "openalex");

    expect(await core.checkReferences(mindId)).toMatchObject({
      kind: "checked",
      references: [{ mark: "not-checked", service: "openalex", reason: "unreachable" }],
    });
  });

  // protects=OpenAlex asking to slow down (429) stops it being asked for the rest of the list, each miss not checked with the reason; fails_when=a 429 reads as a miss or a mismatch, or OpenAlex is asked again; no_claim=none beyond protects.
  test("when OpenAlex asks to slow down, it isn't asked again and the misses say why", async () => {
    const { core, services, mindId } = await setUp([REAL, CONFERENCE, INVENTED]);
    services.fail(429, "openalex");

    const result = await core.checkReferences(mindId);

    expect(result).toMatchObject({
      kind: "checked",
      references: [
        { mark: "found", service: "crossref" },
        { mark: "not-checked", service: "openalex", reason: "rate-limited" },
        { mark: "not-checked", service: "openalex", reason: "rate-limited" },
      ],
    });
    expect(services.requests.filter(({ path }) => path.includes("search="))).toHaveLength(1);
    // It says when its free searches come back: an hour from now.
    const resetsAt = result.kind === "checked" ? result.references[1]?.resetsAt : undefined;
    expect(Date.parse(resetsAt ?? "") - Date.now()).toBeGreaterThan(3_500_000);
  });

  // protects=while OpenAlex can't be asked, a reference with an arXiv number is still looked up on arXiv; OpenAlex's failure isn't kept with the record arXiv found, so checking again sends nothing and Check again, OpenAlex back, asks it again; fails_when=an arXiv preprint reads "not checked" though arXiv answers, or the failure is kept for good, so Check again doesn't ask OpenAlex; no_claim=none beyond protects.
  test("while OpenAlex can't be reached, an arXiv number is still looked up on arXiv; Check again asks OpenAlex again", async () => {
    const { core, services, mindId } = await setUp([ON_ARXIV]);
    services.fail("unreachable", "openalex");
    const onArxiv = { kind: "checked", references: [{ mark: "found", service: "arxiv" }] };
    const toOpenAlex = () => services.requests.filter(({ path }) => path.startsWith("/works/doi:"));

    expect(await core.checkReferences(mindId)).toMatchObject(onArxiv);
    expect(toOpenAlex()).toHaveLength(1);

    services.fail(null);
    const asked = services.requests.length;
    expect(await core.checkReferences(mindId)).toMatchObject(onArxiv);
    expect(services.requests).toHaveLength(asked);
    expect(await core.checkReferences(mindId, { again: true })).toMatchObject(onArxiv);
    expect(toOpenAlex()).toHaveLength(2);
  });

  test("when OpenAlex can't be reached, Crossref's answers stand and OpenAlex is asked once", async () => {
    const { core, services, mindId } = await setUp([REAL, INVENTED, CONFERENCE]);
    services.fail("unreachable", "openalex");

    expect(await core.checkReferences(mindId)).toMatchObject({
      kind: "checked",
      references: [
        { mark: "found", service: "crossref" },
        { mark: "not-checked", service: "openalex", reason: "unreachable" },
        { mark: "not-checked", service: "openalex", reason: "unreachable" },
      ],
    });
    expect(services.requests.filter(({ path }) => path.includes("search="))).toHaveLength(1);
  });

  // protects=a Mind with no reference list says so and sends nothing; Stop gives "cancelled" and nothing more is sent; fails_when=either sends, hangs, or a stopped check goes on asking; no_claim=none beyond protects.
  test("no reference list sends nothing; Stop cancels a check under way", async () => {
    const services = await startReferenceServices({ works: [LSTM] });
    onTestFinished(() => services.close());
    const core = startCore(await createTempDataFolder(), {
      referenceLookup: { crossref: services.url, arxiv: services.url, openalex: services.url },
    });
    const mind = await core.createMind({ title: "No list" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note(REAL)]);
    await client.settled();
    expect(await core.checkReferences(mind.id)).toEqual({ kind: "no-references" });
    expect(services.requests).toEqual([]);

    const busy = await setUp([REAL, INVENTED, WRONG_YEAR, DEAD_DOI]);
    const slow = busy.services.pause();
    const checking = busy.core.checkReferences(busy.mindId);
    await slow.reached;
    await busy.core.stopReferenceCheck(busy.mindId);
    expect(await checking).toEqual({ kind: "cancelled" });
    slow.release();
    expect(busy.services.requests).toHaveLength(1);
  });
});

describe("Keeping the services' answers", () => {
  // Through the core, a second check's OpenAlex request waits behind the first's (the Pace sends a
  // service's requests one at a time), so nothing shows when its Crossref answer is stored: the cache is driven here.
  // protects=a check settles only the answer it used: when a Check again stored another answer meanwhile (here, nothing), the first check's verdict doesn't keep it, so the next Check again asks Crossref again and gets the record; fails_when=the other answer is kept, so Check again replays it and doesn't ask Crossref; no_claim=the checks' order through the core, which the Pace decides.
  test("a check settles only the answer it used", async () => {
    const db = openDatabase(":memory:");
    onTestFinished(() => db.close());
    migrate(db);
    const record: WorkRecord = {
      fields: {
        title: "Long Short-Term Memory",
        authors: [{ family: "Hochreiter", given: "Sepp" }],
      },
      years: [1997],
    };
    let listed = [record];
    const searched: string[] = [];
    const lookups: Lookups = {
      crossref: {
        byDoi: async () => null,
        agency: async () => null,
        search: async (reference) => {
          searched.push(reference);
          return listed;
        },
      },
      openalex: { byDoi: async () => null, search: async () => [] },
      arxiv: { byId: async () => null },
    };
    const cache = createLookupCache(lookups, db, () => "2026-11-07T09:00:00.000Z");
    const { signal } = new AbortController();

    const first = cache.forReference(false);
    expect(await first.lookups.crossref.search(WRONG_YEAR, signal)).toEqual([record]);
    // Before the first check settles, a Check again of the same entry stores Crossref's answer once it no longer lists the work.
    listed = [];
    expect(await cache.forReference(true).lookups.crossref.search(WRONG_YEAR, signal)).toEqual([]);
    first.settle(true);

    listed = [record];
    const again = await cache.forReference(true).lookups.crossref.search(WRONG_YEAR, signal);
    expect(again).toEqual([record]);
    expect(searched).toHaveLength(3);
  });
});

describe("Reading a reference as written", () => {
  // protects=the DOI, arXiv number and year are read from the text, and neither identifier's digits taken for a year; fails_when=a DOI's or arXiv number's digits read as the year, or trailing punctuation stays in the DOI; no_claim=none beyond protects.
  test("its DOI and year", () => {
    expect(citedReference(`${BY_DOI}.`)).toMatchObject({ doi: "10.1038/nature14539", year: 2015 });
    expect(
      citedReference("Vaswani, A. Attention is all you need. arXiv:1706.03762v5 (2017)."),
    ).toMatchObject({ doi: null, arxiv: "1706.03762", year: 2017 });
    expect(
      citedReference("Wu, L. (2021). 深度学习综述. 计算机学报. https://doi.org/10.1234/2019.5"),
    ).toMatchObject({ doi: "10.1234/2019.5", year: 2021 });
  });

  // protects=a year is read past pages, CoRR numbers and broken DOIs, and as a date or a range of years; a year's gap is allowed only beside a preprint, so Part II of 2011 isn't Part I of 2010; fails_when=a real paper's entry reads "doesn't match" for any of these, or a year off by one goes unflagged between two published works; no_claim=none beyond protects.
  test("its year: past pages and numbers, and a year's gap only beside a preprint", () => {
    expect(
      citedReference(
        "Sepp Hochreiter. Long short-term memory. Neural computation, 9(8):1735–1780, 1997.",
      ),
    ).toMatchObject({ year: 1997 });
    expect(
      citedReference(
        "Denny Britz. Massive exploration of NMT architectures. CoRR, abs/1703.03906, 2017.",
      ),
    ).toMatchObject({ arxiv: "1703.03906", year: 2017, preprint: true });
    expect(citedReference("Doe, J. (2019-06-12). A note on widgets. Widget News.")).toMatchObject({
      year: 2019,
    });
    expect(citedReference("Doe, J. (2017–2018). Widget surveys. Widget Letters.")).toMatchObject({
      year: 2017,
    });
    for (const [text, year] of [
      ["Hochreiter, S. Long short-term memory. Neural Comput., pp. 1735-1780, 1997.", 1997],
      ["Hochreiter, S. Long short-term memory. Neural Comput. 9(8), 1735-1780 (1997).", 1997],
      ["Doe, J. Widget surveys. Widget Letters, 1999–2003 (2019).", 2019],
    ] as const) {
      expect(citedReference(text).year, text).toBe(year);
    }
    expect(
      citedReference(
        "Graves, A. (2014). Neural Turing machines. Neural Netw. doi:10.1016/j.neunet. 2014.09.003",
      ),
    ).toMatchObject({ doi: "10.1016/j.neunet.2014.09.003", year: 2014 });

    const adam = citedReference(
      "Diederik Kingma and Jimmy Ba. Adam: A method for stochastic optimization. In ICLR, 2015.",
    );
    const record = {
      fields: {
        title: "Adam: A Method for Stochastic Optimization",
        authors: [{ family: "Kingma", given: "Diederik P." }],
      },
    };
    expect(differences(adam, { ...record, years: [2014], preprint: true })).toEqual([]);
    expect(differences(adam, { ...record, years: [2014] }).map((each) => each.field)).toEqual([
      "year",
    ]);
    const partTwo = citedReference("Doe, J. (2011). A theory of widgets. Widget Letters, 3.");
    const partOne = {
      fields: { title: "A theory of widgets", authors: [{ family: "Doe", given: "J." }] },
      years: [2010],
    };
    expect(differences(partTwo, partOne).map((each) => each.field)).toEqual(["year"]);
    expect(
      titleCoverage(
        "Luong. Effective approaches to attentionbased neural machine translation, 2015.",
        "Effective Approaches to Attention-based Neural Machine Translation",
      ),
    ).toBe(1);
  });

  // protects=the title is read as each common style sets it apart (APA, numbered with quotes, GB/T 7714, Vancouver), for OpenAlex's search by title; fails_when=an author list or venue is taken for the title; no_claim=styles beyond these.
  test("its title, in the common styles", () => {
    expect(titleOf(CONFERENCE)).toBe("Language models are few-shot learners");
    expect(
      titleOf('[3] A. Vaswani et al., "Attention is all you need," in Proc. NeurIPS, 2017.'),
    ).toBe("Attention is all you need");
    expect(titleOf("周志华. 机器学习[M]. 北京: 清华大学出版社, 2016.")).toBe("机器学习");
    expect(titleOf("1. Smith J, Doe K. Widgets in coastal towns. J Widgets. 2020;12:3-4.")).toBe(
      "Widgets in coastal towns",
    );
    expect(titleOf("A. Vaswani, N. Shazeer. Attention is all you need. NeurIPS 2017.")).toBe(
      "Attention is all you need",
    );
    expect(
      titleOf(
        "Tieleman, T. and Hinton, G. Lecture 6.5 - RMSProp, COURSERA. Technical report, 2012.",
      ),
    ).toBe("Lecture 6.5 - RMSProp, COURSERA");
    expect(
      titleOf(
        "Hochreiter, S., Schmidhuber, J.: Long short-term memory. Neural Comput. 9(8) (1997)",
      ),
    ).toBe("Long short-term memory");
    expect(titleOf("Smith J, Doe K. Widgets in coastal towns. J Widgets. 2020;12:3-4.")).toBe(
      "Widgets in coastal towns",
    );
  });

  // protects=a list ends at the first paragraph that isn't a reference, so an appendix after it isn't looked up; fails_when=the appendix's text is taken for a reference; no_claim=none beyond protects.
  test("its list ends where the references do", () => {
    const blocks = [
      { id: "a", heading: false, text: "Recurrent networks remember (1997)." },
      { id: "b", heading: true, text: "参考文献" },
      { id: "c", heading: false, text: REAL },
      { id: "d", heading: false, text: `[2] ${BY_DOI}` },
      {
        id: "e",
        heading: false,
        text: "The survey asked forty people about their reading habits.",
      },
      { id: "f", heading: false, text: INVENTED },
    ];
    expect(checkableReferences(blocks).map((entry) => entry.blockId)).toEqual(["c", "d"]);
  });

  // protects=an entry a PDF broke into paragraphs is read whole: a numbered one until the next number, one whose authors stand alone into the paragraph with its year; the list still ends after its last number and at prose; fails_when=a broken entry ends the list, is read as two, or an appendix after the last number is read as a reference; no_claim=entries broken any other way.
  test("an entry a PDF broke into paragraphs is read whole", () => {
    const block = (id: string, text: string, isHeading = false) => ({
      id,
      heading: isHeading,
      text,
    });
    const numbered = [
      block("h", "References", true),
      block("a", "[1] Christian Szegedy and Zbigniew Wojna."),
      block(
        "b",
        "Rethinking the inception architecture for computer vision. CoRR, abs/1512.00567, 2015.",
      ),
      block("c", "[2] Yoon Kim and Alexander M. Rush. Structured attention networks, 2017."),
      block(
        "d",
        "Attention Visualizations It is in this spirit that laws passed since 2009 matter.",
      ),
    ];
    expect(checkableReferences(numbered)).toEqual([
      {
        blockId: "a",
        text: "[1] Christian Szegedy and Zbigniew Wojna. Rethinking the inception architecture for computer vision. CoRR, abs/1512.00567, 2015.",
      },
      {
        blockId: "c",
        text: "[2] Yoon Kim and Alexander M. Rush. Structured attention networks, 2017.",
      },
    ]);
    const authorsFirst = [
      block("h", "REFERENCES", true),
      block(
        "a",
        "Amari, Shun-Ichi. Natural gradient works efficiently in learning. Neural computation, 10(2):251–276, 1998.",
      ),
      block("b", "Maas, Andrew L, Daly, Raymond E, and Potts, Christopher."),
      block(
        "c",
        "Learning word vectors for sentiment analysis. In Proceedings of ACL, pp. 142–150, 2011.",
      ),
      block(
        "d",
        "Zeiler, Matthew D. Adadelta: An adaptive learning rate method. arXiv preprint arXiv:1212.5701, 2012.",
      ),
    ];
    expect(checkableReferences(authorsFirst).map((entry) => entry.blockId)).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  // protects=entries whose year is written otherwise stay apart, a DOI broken into its own paragraph stays with its entry, a numbered entry without a year or with its last part on a second paragraph is read whole, and prose after the list isn't sent; fails_when=two entries are read as one, a list ends early, or prose is looked up; no_claim=none beyond protects.
  test("a list's entries, however their years are written, and where it ends", () => {
    const block = (id: string, text: string, isHeading = false) => ({
      id,
      heading: isHeading,
      text,
    });
    const authorYear = [
      block("h", "References", true),
      block("a", "Abel, K. (in press). Widgets at the coast. Widget Letters."),
      block("b", "Baker, L. (n.d.). A field guide to widgets. Widget Society."),
      block("c", "Cole, M. (2019-06-12). Widgets and the tide. Coast News."),
      block("d", "Dunn, P. (2017–2018). A survey of coastal widgets. Widget Reports."),
      block("e", "王五. 海岸小部件研究[N]. 海岸日报, 2020-05-01(3)."),
      block(
        "f",
        "Ellis, R. (2014). Widget memory. Neural Netw., 61, 85–117. doi:10.1016/j.neunet.",
      ),
      block("g", "2014.09.003"),
      block("p", "However, the widgets above were measured at low tide only."),
      block("q", "Some studies since 2019 measure them at high tide."),
    ];
    const read = checkableReferences(authorYear);
    expect(read.map((entry) => entry.blockId)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(read.at(-1)?.text).toContain("doi:10.1016/j.neunet. 2014.09.003");

    const numbered = [
      block("h", "References", true),
      block("a", "1. Smith J, Doe K. Widgets in coastal towns. Widget Press."),
      block("b", "2. Moore T. Tides and widgets. J Widgets. 2020;12:3-4."),
      block("c", "3. Zhu M, Chen W. Fast and accurate widget counting. In Proceedings of the"),
      block("d", "51st Annual Meeting of the Widget Society, pages 434–443, August 2013."),
    ];
    expect(checkableReferences(numbered).map((entry) => entry.text)).toEqual([
      "1. Smith J, Doe K. Widgets in coastal towns. Widget Press.",
      "2. Moore T. Tides and widgets. J Widgets. 2020;12:3-4.",
      "3. Zhu M, Chen W. Fast and accurate widget counting. In Proceedings of the 51st Annual Meeting of the Widget Society, pages 434–443, August 2013.",
    ]);
  });

  // protects=a numbered marker always starts an entry, with or without a space (CNKI writes none); an author-first entry without a year stays apart from the next; a lowercase particle starts an entry; the list ends at prose, an acknowledgement, or a short paragraph after the last numbered entry; fails_when=entries merge, a list ends early, or prose is looked up; no_claim=none beyond protects.
  test("where entries start and where the list ends, in more styles", () => {
    const block = (id: string, text: string, isHeading = false) => ({
      id,
      heading: isHeading,
      text,
    });
    const blockIds = (blocks: ReturnType<typeof block>[]) =>
      checkableReferences(blocks).map((entry) => entry.blockId);

    expect(
      blockIds([
        block("h", "参考文献", true),
        block("a", "[1]张三,李四.海岸小部件的分布研究[J].海洋科学,2019,12(3):1-10."),
        block("b", "[2]王五.小部件与潮汐[M].北京:海洋出版社,2020."),
        block(
          "c",
          "[3]赵六.潮间带小部件调查[J].地理学报,2018,7(1):2-9.[4]钱七.小部件图谱[M].上海:科学出版社,2017.",
        ),
      ]),
    ).toEqual(["a", "b", "c", "c"]);

    expect(
      blockIds([
        block("h", "References", true),
        block("a", "Baker, L. A field guide to coastal widgets. Widget Society."),
        block("b", "Cole, M. (2019). Widgets and the tide. Coast News."),
        block("c", "van der Maaten, L. (2008). Visualizing data using t-SNE. JMLR, 9, 2579–2605."),
        block("p", "We thank Jane Doe for reading the 2019 draft of this survey."),
        block("q", "Doe, J. (2020). A later study of widgets. Widget Letters."),
      ]),
    ).toEqual(["a", "b", "c"]);

    expect(
      blockIds([
        block("h", "References", true),
        block("a", "Cole, M. (2019). Widgets and the tide. Coast News."),
        block("b", "Acknowledgements"),
        block("c", "Doe, J. (2020). A later study of widgets. Widget Letters."),
      ]),
    ).toEqual(["a"]);

    expect(
      checkableReferences([
        block("h", "References", true),
        block("a", "[1] Ann Abel. Widgets at the coast of the northern sea. Widget Press"),
        block("b", "Thanks to the reviewers."),
        block("c", "Their notes since 2019 helped."),
      ]).map((entry) => entry.text),
    ).toEqual(["[1] Ann Abel. Widgets at the coast of the northern sea. Widget Press"]);
  });

  // protects=an undated last entry doesn't take a dated sentence after it, a sentence naming people isn't an entry, and a GB/T entry by an institution starts its own entry; fails_when=prose is looked up, or two entries are read as one; no_claim=none beyond protects.
  test("prose after a list, and institutions as authors", () => {
    const block = (id: string, text: string, isHeading = false) => ({
      id,
      heading: isHeading,
      text,
    });
    const blockIds = (blocks: ReturnType<typeof block>[]) =>
      checkableReferences(blocks).map((entry) => entry.blockId);

    expect(
      blockIds([
        block("h", "References", true),
        block("a", "Cole, M. (2019). Widgets and the tide. Coast News."),
        block("b", "Doe, J. A field guide to the widgets of the coast."),
        block("p", "Most of the participants were enrolled in 2019."),
      ]),
    ).toEqual(["a", "b"]);
    expect(
      blockIds([
        block("h", "References", true),
        block("a", "Cole, M. (2019). Widgets and the tide. Coast News."),
        block("p", "Jane Doe and her colleagues counted the widgets in 2019."),
      ]),
    ).toEqual(["a"]);
    expect(
      blockIds([
        block("h", "参考文献", true),
        block("a", "张三,李四.海岸小部件的分布研究[J].海洋科学,2019,12(3):1-10."),
        block("b", "中华人民共和国国家统计局.中国统计年鉴[M].北京:中国统计出版社,2020."),
      ]),
    ).toEqual(["a", "b"]);
  });

  // protects=a short title must stand alone in the reference, so a record titled "Introduction" isn't a longer title's work; a short real title still is; fails_when=either is wrong; no_claim=none beyond protects.
  test("a short title stands alone", () => {
    const longer = "Smith, J. (2020). Introduction to quantum widgets. Widget Letters, 3.";
    expect(holdsTitle(longer, "Introduction")).toBe(false);
    expect(holdsTitle(longer, "Introduction to Quantum Widgets")).toBe(true);
    expect(holdsTitle(BY_DOI, "Deep learning")).toBe(true);
    expect(holdsTitle(REAL, "Deep learning")).toBe(false);
  });

  // protects=a title matches in any case, with accents and in Chinese; another title doesn't; fails_when=either is wrong; no_claim=none beyond protects.
  test("a title's words, in any case, with accents and in Chinese", () => {
    expect(titleCoverage(REAL, "Long Short-Term Memory")).toBe(1);
    expect(titleCoverage("Müller, K. (2020). Über Lernen.", "Uber lernen")).toBe(1);
    expect(titleCoverage("王五 (2020). 深度学习综述. 计算机学报.", "深度学习综述")).toBe(1);
    expect(titleCoverage(INVENTED, "Long Short-Term Memory")).toBe(0);
    expect(
      differences(citedReference(REAL), {
        fields: { title: "Deep learning", authors: [{ family: "LeCun", given: "Yann" }] },
        years: [2015],
      }).map((each) => each.field),
    ).toEqual(["title", "year", "authors"]);
  });
});
