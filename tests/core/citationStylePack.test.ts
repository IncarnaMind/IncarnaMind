/**
 * Every CSL style through the core (#910): the pack read only when a style needs it, a journal's
 * style formatted with the one it follows, a style with no language of its own in the Mind's, a
 * style this version doesn't have formatted as Numbered, and Recently used.
 */
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Core } from "../../src/core";
import { createCatalogue } from "../../src/core/citationStyles/catalogue";
import { readPackIndex } from "../../src/core/citationStyles/pack";
import { createPackStyles } from "../../src/core/citationStyles/packStyles";
import { CITATION_STYLES as COMMON_STYLES } from "../../src/shared/citationStyles";
import { fixtureCitations, fixtureReferences, formatHere } from "../helpers/citationStyles";
import { CITATION_STYLES, createTempDataFolder, startCore } from "../helpers/core";

const PACK = join(CITATION_STYLES, "styles.pack");
const NO_LOCALE = "american-sociological-association";
const plain = (runs: readonly { text: string }[] | null | undefined) =>
  (runs ?? []).map((run) => run.text).join("");
/** A work cited by its name alone, as a deleted Document's Citation is. */
const named = (name: string) => ({ documentId: null, documentName: name, location: null });

async function coreWith(change?: (folder: string) => Promise<void>) {
  const dataDir = await createTempDataFolder();
  const folder = await createTempDataFolder();
  await cp(CITATION_STYLES, folder, { recursive: true });
  await change?.(folder);
  const opened: string[] = [];
  const core = startCore(dataDir, {
    paths: {
      dataDir,
      documents: join(dataDir, "Documents"),
      citationStyles: folder,
      tempDir: dataDir,
    },
    shell: {
      openPath: async (path: string) => {
        opened.push(path);
      },
      showItemInFolder: () => undefined,
    },
  });
  onTestFinished(() => core.close());
  return { core, opened };
}

const formatNamed = (core: Core, style: string, language?: "en" | "zh-CN") =>
  core.formatCitations({
    style,
    clusters: [{ works: [named("A report")] }],
    ...(language ? { language } : {}),
  });

describe("the style pack", () => {
  // protects=a common style's edition, which "Chicago 18" or "APA 7th edition" is found by, is the edition its pack file's title gives, so a new pack can't leave a name on the wrong edition (#2252); fails_when=a pack title's edition differs from the style's, or one is missing; no_claim=styles outside the common list.
  test("each common style's edition is its pack title's", () => {
    const titles = new Map(readPackIndex(PACK).styles.map((style) => [style.id, style.title]));
    for (const style of COMMON_STYLES.filter((each) => each.packId !== null)) {
      const title = titles.get(style.packId ?? "") ?? "";
      const edition = /(\d+)(?:st|nd|rd|th) edition/.exec(title)?.[1];
      expect([style.id, style.edition]).toEqual([
        style.id,
        edition === undefined ? undefined : Number(edition),
      ]);
    }
    expect(COMMON_STYLES.find((each) => each.id === "chicago-notes")?.edition).toBe(18);
  });

  test("switching between two styles a second time decompresses nothing again", () => {
    const pack = createPackStyles(CITATION_STYLES);
    const index = readPackIndex(PACK);
    const chunk = (id: string) => index.styles.find((style) => style.id === id)?.at?.[0];
    expect(chunk("nature")).not.toBe(chunk("the-lancet"));
    pack.style({ packId: "nature" });
    pack.style({ packId: "the-lancet" });
    const first = pack.decompressions();
    pack.style({ packId: "nature" });
    pack.style({ packId: "the-lancet" });
    expect(pack.decompressions()).toBe(first);
  });

  test("a first run, and a Mind in Numbered or a common style's choice, read nothing from it", async () => {
    const { core } = await coreWith((folder) =>
      writeFile(join(folder, "styles.pack"), "not a pack"),
    );
    const mind = await core.createMind({ title: "Notes" });
    expect((await core.getMindCitationStyle(mind.id)).style).toBe("numbered");
    expect((await formatNamed(core, "numbered")).form).toBe("numbered");
    await core.setMindCitationStyle(mind.id, "apa");
    await core.setMindCitationStyle(mind.id, "numbered");
    await core.exportMind(mind.id, { format: "markdown" });
    // A style the pack holds is the first thing to read it.
    await expect(formatNamed(core, "apa")).rejects.toThrow();
    await expect(core.listCitationStyles()).rejects.toThrow();
  });

  test("lists every style but the common ones, journals with the style they follow", async () => {
    const { core } = await coreWith();
    const { count, styles } = await core.listCitationStyles();
    expect(count).toBe(readPackIndex(PACK).styles.length);
    const byId = new Map(styles.map((style) => [style.id, style]));
    expect(byId.get("nature-genetics")).toMatchObject({
      title: "Nature Genetics",
      follows: "Nature",
    });
    expect(byId.get("nature")).toMatchObject({ format: "numeric", note: false });
    // The common list's own are its entries, under the ids Minds have kept.
    expect(byId.has("apa")).toBe(false);
    expect(byId.has("china-national-standard-gb-t-7714-2015-numeric")).toBe(false);
    // The repository's "chicago-notes" isn't the common "chicago-notes" (notes and bibliography).
    expect(byId.get("csl-chicago-notes")?.note).toBe(true);
  });

  test("its licence notice opens from the app, as a text file", async () => {
    const { core, opened } = await coreWith();
    await core.openCitationStyleLicences();
    expect(opened).toHaveLength(1);
    const text = await readFile(opened[0] as string, "utf8");
    expect(text).toContain("https://citationstyles.org/");
    expect(text).toContain("- Nature Genetics (nature-genetics");
    expect(text).toContain("Attribution-ShareAlike 3.0 Unported");
  });
});

describe("a Mind in a style of the pack", () => {
  test("a journal's style formats with the style it follows, and the Mind keeps the journal's name", async () => {
    const { core } = await coreWith();
    const mind = await core.createMind({ title: "Paper" });
    await core.setMindCitationStyle(mind.id, "nature-genetics");
    expect((await core.getMindCitationStyle(mind.id)).style).toBe("nature-genetics");
    const journal = await formatNamed(core, "nature-genetics");
    const parent = await formatNamed(core, "nature");
    expect(journal.style).toBe("nature-genetics");
    expect(journal.form).toBe("in-text");
    expect(plain(journal.clusters[0]?.runs)).toBe(plain(parent.clusters[0]?.runs));
    expect(plain(journal.bibliography[0]?.runs)).toBe(plain(parent.bibliography[0]?.runs));
  });

  test("a style with no language of its own formats in the Mind's", () => {
    // The ASA's style names no locale; a Chinese work cited in it, in each Mind.
    const items = fixtureReferences().filter((item) => item.id === "zh-liu-2016");
    const citations = [{ items: [{ id: "zh-liu-2016" }], noteIndex: 1 }];
    const cited = (language: "en" | "zh-CN") =>
      plain(formatHere(NO_LOCALE, { items, citations }, language).citations[0]);
    expect(cited("en")).toContain("et al.");
    expect(cited("zh-CN")).toContain("等");
    expect(cited("zh-CN")).not.toContain("et al");
  });

  test("a style this version doesn't have is formatted as Numbered, and the Mind keeps it", async () => {
    const { core } = await coreWith();
    const mind = await core.createMind({ title: "From a later version" });
    await core.setMindCitationStyle(mind.id, "a-style-from-a-later-pack");
    expect((await core.getMindCitationStyle(mind.id)).style).toBe("a-style-from-a-later-pack");
    const formatted = await formatNamed(core, "a-style-from-a-later-pack");
    expect(formatted).toMatchObject({
      style: "a-style-from-a-later-pack",
      form: "numbered",
      unavailable: true,
    });
    expect(plain(formatted.bibliography[0]?.runs)).toBe("A report");
  });

  test("a request's language is the Mind's, English or Chinese", async () => {
    const { core } = await coreWith();
    await expect(
      core.formatCitations({
        style: "apa",
        clusters: [{ works: [named("A report")] }],
        language: "fr" as unknown as "en",
      }),
    ).rejects.toMatchObject({ wording: { key: "error.citationStyle.language" } });
  });

  test("a sample of the pack's styles each formats the 30 references", () => {
    const index = readPackIndex(PACK);
    const independent = index.styles.filter((style) => style.at !== undefined);
    const sample = independent.filter((_, at) => at % 150 === 0);
    expect(sample.length).toBeGreaterThan(15);
    for (const style of sample) {
      const output = formatHere(style.id, {
        items: fixtureReferences(),
        citations: fixtureCitations(),
      });
      expect(output.citations, style.id).toHaveLength(34);
      expect(output.bibliography.length, style.id).toBeGreaterThan(0);
    }
  });

  test("resolves a common style as before, and a journal to the style it follows in its locale", () => {
    const catalogue = createCatalogue(PACK);
    expect(catalogue.resolve("apa", "zh-CN")).toMatchObject({
      language: "en",
      engine: { packId: "apa" },
    });
    expect(catalogue.resolve("nature-genetics", "zh-CN")).toMatchObject({
      form: "in-text",
      language: "en",
      engine: { packId: "nature", locale: "en-GB" },
    });
    expect(catalogue.resolve("acta-physica-sinica", "en")).toMatchObject({
      language: "zh-CN",
      heading: "参考文献",
    });
  });
});

describe("Recently used", () => {
  test("lists the styles last chosen in any Mind, newest first, up to five; Undo adds none", async () => {
    const { core } = await coreWith();
    const one = await core.createMind({ title: "One" });
    const two = await core.createMind({ title: "Two" });
    const recent = async () => (await core.getSettings()).user.recentCitationStyles;
    expect(await recent()).toEqual([]);
    await core.setMindCitationStyle(one.id, "apa");
    await core.setMindCitationStyle(two.id, "nature");
    await core.setMindCitationStyle(one.id, "ieee");
    await core.setMindCitationStyle(two.id, "apa");
    expect(await recent()).toEqual(["apa", "ieee", "nature"]);
    for (const style of ["mla", "harvard", "vancouver"])
      await core.setMindCitationStyle(one.id, style);
    expect(await recent()).toEqual(["vancouver", "harvard", "mla", "apa", "ieee"]);
    // Undo puts back the style before, with the Folder's: not a choice of the User's.
    await core.setMindCitationStyle(one.id, "the-lancet", { folderDefault: null });
    await core.setMindCitationStyle(one.id, null);
    expect(await recent()).toEqual(["vancouver", "harvard", "mla", "apa", "ieee"]);
  });
});
