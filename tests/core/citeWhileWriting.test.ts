import { describe, expect, test } from "vitest";
import type { Reranker } from "../../src/core";
import { bestQuote } from "../../src/core/answers/citing";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

/** The model isn't asked anything: Cite… searches and cites without it. */
const unusedModel = () => scriptedModel(() => ({ text: "Not asked." }));

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "The Moon raises two bulges of water on the Earth.",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year.",
  ].join("\n"),
};

const BREAD = {
  name: "Bread.md",
  contents: "# Bread\n\nSourdough bread needs a starter fed with flour and water every day.",
};

const CHAOZHOU = {
  name: "潮汐.md",
  contents: [
    "# 潮汐",
    "",
    "大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
    "",
    "港口每年公布高潮时刻表。",
  ].join("\n"),
};

function countingReranker() {
  const reranked: string[] = [];
  const reranker: Reranker = async (query, candidates) => {
    reranked.push(query);
    return [...candidates];
  };
  return { reranked, reranker };
}

describe("Cite… in a Note (#281): the Passages a sentence is about", () => {
  test("finds the Passage of the sentence, with its Document, Location and the words that match", async () => {
    const { core, mind } = await setUpWithDocuments(unusedModel(), [TIDES]);

    const found = await core.findPassages({
      text: "When do spring tides happen?",
      mindId: mind.id,
      scope: null,
    });

    expect(found.length).toBeGreaterThan(0);
    const best = found[0];
    expect(best?.documentName).toBe("Tides");
    expect(best?.documentKind).toBe("markdown");
    expect(best?.text).toContain("Spring tides happen at new moon");
    expect(best?.matches).toEqual(expect.arrayContaining(["spring", "tides"]));
    expect(best?.quote).toBe(
      "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    );
    expect(best?.location).not.toBeNull();
  });

  test("searches the Search scope it is given, and every Document with none", async () => {
    const { core, mind, documents } = await setUpWithDocuments(unusedModel(), [TIDES, BREAD]);
    const bread = documents.find((document) => document.name === "Bread");
    if (!bread) throw new Error("Bread wasn't added.");

    const onlyBread = {
      folderIds: [],
      tagIds: [],
      documentIds: [bread.id],
    };
    const breadFound = await core.findPassages({
      text: "sourdough starter",
      mindId: mind.id,
      scope: onlyBread,
    });
    expect(breadFound.map((passage) => passage.documentName)).toEqual(["Bread"]);

    // Out of the scope, the same words find nothing.
    const tidesOnly = await core.findPassages({
      text: "spring tides",
      mindId: mind.id,
      scope: onlyBread,
    });
    expect(tidesOnly).toEqual([]);

    // With no scope, every Document is searched.
    const everyDocument = await core.findPassages({
      text: "spring tides",
      mindId: mind.id,
      scope: null,
    });
    expect(everyDocument[0]?.documentName).toBe("Tides");
  });

  test("a Chinese sentence finds Chinese Passages", async () => {
    const { core, mind } = await setUpWithDocuments(unusedModel(), [CHAOZHOU]);

    const found = await core.findPassages({
      text: "大潮什么时候出现？",
      mindId: mind.id,
      scope: null,
    });

    expect(found[0]?.documentName).toBe("潮汐");
    expect(found[0]?.text).toContain("大潮出现在新月和满月前后");
    expect(found[0]?.matches).toEqual(expect.arrayContaining(["大潮"]));
  });

  test("the search reranks, as an Answer's does", async () => {
    const { reranked, reranker } = countingReranker();
    const { core, mind } = await setUpWithDocuments(unusedModel(), [TIDES], { reranker });

    await core.findPassages({ text: "spring tides", mindId: mind.id, scope: null });

    expect(reranked).toEqual(["spring tides"]);
  });

  test("cites the Passage's sentence holding most of the words, checked at once", async () => {
    const { core, mind } = await setUpWithDocuments(unusedModel(), [TIDES]);
    const [passage] = await core.findPassages({
      text: "When do spring tides happen at new moon?",
      mindId: mind.id,
      scope: null,
    });
    if (!passage) throw new Error("No Passage was found.");

    const cited = await core.citePassage({
      passageId: passage.passageId,
      text: "When do spring tides happen at new moon?",
    });

    expect(cited?.check).toBe("found");
    expect(cited?.checkReason).toBeNull();
    expect(cited?.quote).toBe(
      "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    );
    expect(cited?.documentName).toBe("Tides");
    expect(cited?.location).not.toBeNull();
  });

  test("a Passage of a Document deleted between the search and the choice cites nothing", async () => {
    const { core, mind } = await setUpWithDocuments(unusedModel(), [TIDES]);
    const [passage] = await core.findPassages({
      text: "spring tides",
      mindId: mind.id,
      scope: null,
    });
    if (!passage) throw new Error("No Passage was found.");

    await core.deleteDocuments([passage.documentId]);

    expect(
      await core.citePassage({ passageId: passage.passageId, text: "spring tides" }),
    ).toBeNull();
    expect(
      await core.citePassage({ passageId: "no-such-passage", text: "spring tides" }),
    ).toBeNull();
  });

  test("a Document the User keeps as their own workings is never offered nor cited", async () => {
    const { core, mind, documents } = await setUpWithDocuments(unusedModel(), [TIDES, BREAD]);
    const workings = documents.find((document) => document.name === "Bread");
    if (!workings) throw new Error("Bread wasn't added.");
    const [offered] = await core.findPassages({
      text: "sourdough starter",
      mindId: mind.id,
      scope: null,
    });
    if (!offered) throw new Error("Bread wasn't found before it was marked.");

    await core.setNotCited(workings.id, true);

    const after = await core.findPassages({
      text: "sourdough starter",
      mindId: mind.id,
      scope: null,
    });
    expect(after).toEqual([]);
    expect(
      await core.citePassage({ passageId: offered.passageId, text: "sourdough starter" }),
    ).toBeNull();
  });

  test("a Mind inside a Folder wall searches only its Folder", async () => {
    const { core, documents } = await setUpWithDocuments(unusedModel(), [TIDES, BREAD]);
    const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
    const inside = await core.createMind({ title: "Chapter", folderId: folder.id });
    const tides = documents.find((document) => document.name === "Tides");
    if (!tides) throw new Error("Tides wasn't added.");
    await core.assignDocumentGroup(tides.id, folder.id);
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });

    // Bread is outside the wall: the Mind inside it never finds it.
    expect(
      await core.findPassages({ text: "sourdough starter", mindId: inside.id, scope: null }),
    ).toEqual([]);
    const found = await core.findPassages({ text: "spring tides", mindId: inside.id, scope: null });
    expect(found[0]?.documentName).toBe("Tides");
  });
});

describe("The quote Cite… stores", () => {
  test("is the sentence holding most of the searched words", () => {
    expect(
      bestQuote(
        "The Moon raises two bulges of water. Spring tides happen at new moon and at full moon.",
        "when do spring tides happen",
      ),
    ).toBe("Spring tides happen at new moon and at full moon.");
  });

  test("is the shorter of two sentences holding as many of them, whichever comes first", () => {
    expect(bestQuote("High tides flood the marsh twice a day. The tides rise.", "tides")).toBe(
      "The tides rise.",
    );
  });

  test("is the Passage's own text when no sentence holds a word of the search", () => {
    expect(bestQuote("Harbours publish the times of high water.", "penguins")).toBe(
      "Harbours publish the times of high water.",
    );
  });

  test("finds the words of a Chinese sentence", () => {
    expect(
      bestQuote(
        "太阳和月亮一起拉动海水。大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
        "大潮什么时候出现",
      ),
    ).toBe("大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。");
  });
});
