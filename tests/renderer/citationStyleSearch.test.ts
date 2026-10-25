/**
 * Finding a citation style (#910): the picker's search over the common list and every style of
 * the pack, in either interface language, a style's whole name first (#1497).
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createCatalogue } from "../../src/core/citationStyles/catalogue";
import {
  commonEntries,
  keepShown,
  type StyleEntry,
  type StyleMatches,
  searchStyles,
  styleEntries,
} from "../../src/renderer/src/citationStyleSearch";
import { CITATION_STYLES as COMMON_STYLES } from "../../src/shared/citationStyles";
import { translate } from "../../src/shared/i18n";
import { CITATION_STYLES } from "../helpers/core";

const catalogue = createCatalogue(join(CITATION_STYLES, "styles.pack")).catalogue();

const listed = (found: StyleMatches) =>
  (found.journalsFirst
    ? [...found.journals, ...found.styles]
    : [...found.styles, ...found.journals]
  ).map((entry) => entry.id);

describe.each(["en", "zh-CN"] as const)("searching the styles, in the %s interface", (language) => {
  const entries = styleEntries(language, catalogue);
  const common = styleEntries(language, null);
  const first = (query: string, among: readonly StyleEntry[] = entries) =>
    listed(searchStyles(among, query))[0];

  test.each([
    ["Nature", "nature"],
    ["nature", "nature"],
    ["The Lancet", "the-lancet"],
    ["物理学报", "acta-physica-sinica"],
    ["国标", "gb-t-7714-2015-numeric"],
    ["APA", "apa"],
    ["Cite Them Right", "harvard"],
    ["Nature Genetics", "nature-genetics"],
    ["Science", "science"],
    ["Medicine", "medicine"],
    ["Engineering", "engineering"],
  ])("“%s” puts %s first", (query, id) => {
    expect(first(query)).toBe(id);
  });

  test("a common style's whole name, in either language, or another name of it puts it first before every style has arrived and after", () => {
    const aliasesOf = (id: string | undefined) =>
      COMMON_STYLES.find((style) => style.id === id)?.aliases ?? [];
    for (const style of COMMON_STYLES) {
      for (const name of [translate("en", style.label), translate("zh-CN", style.label)]) {
        expect(first(name, common), name).toBe(style.id);
        expect(first(name), name).toBe(style.id);
      }
      for (const alias of style.aliases) {
        expect(aliasesOf(first(alias, common)), alias).toContain(alias);
        expect(aliasesOf(first(alias)), alias).toContain(alias);
      }
    }
  });

  test("“American Psychological Association” puts APA 7 first, before the Basque APA whose short title it is", () => {
    expect(listed(searchStyles(entries, "American Psychological Association")).slice(0, 2)).toEqual(
      ["apa", "apa-eu"],
    );
  });

  test("“medicine”, a field and not a name of Vancouver's, puts the journal Medicine first and Vancouver first among the styles", () => {
    const found = searchStyles(entries, "medicine");
    expect(listed(found)[0]).toBe("medicine");
    expect(found.journalsFirst).toBe(true);
    expect(found.styles[0]?.id).toBe("vancouver");
  });

  test("what a query showed before every style arrived keeps its place, and the rest follow", () => {
    const arrived = (query: string) =>
      listed(keepShown(searchStyles(common, query), searchStyles(entries, query)));
    expect(first("chi", common)).toBe("chicago-notes");
    expect(first("chi")).toBe("childhood-obesity");
    expect(arrived("chi").slice(0, 2)).toEqual(["chicago-notes", "chicago-author-date"]);
    expect(arrived("chi")).toContain("childhood-obesity");
    expect(arrived("Medicine")[0]).toBe("vancouver");
    expect(arrived("ieee")).toEqual(listed(searchStyles(entries, "ieee")));
    expect(arrived("Nature")).toEqual(listed(searchStyles(entries, "Nature")));
  });

  test("a journal's style is found among the journals, a style among the styles", () => {
    const found = searchStyles(entries, "Nature");
    expect(found.styles[0]?.id).toBe("nature");
    expect(found.journals.map((entry) => entry.id)).toContain("nature-genetics");
    expect(found.journals.find((entry) => entry.id === "nature-genetics")?.follows).toBe("Nature");
    expect(found.styles.some((entry) => entry.follows !== undefined)).toBe(false);
  });

  test("words in any order find a style, and nothing finds nothing", () => {
    expect(searchStyles(entries, "lancet the").styles.map((entry) => entry.id)).toContain(
      "the-lancet",
    );
    const none = searchStyles(entries, "qqqzzzxxx");
    expect([...none.styles, ...none.journals]).toEqual([]);
  });

  test("the common list holds every common style, GB/T 7714 first only in Chinese", () => {
    const common = commonEntries(entries, language).map((entry) => entry.id);
    expect(common).toHaveLength(12);
    expect(common[0]).toBe(language === "zh-CN" ? "gb-t-7714-2015-numeric" : "numbered");
  });
});

test("every style the pack lists is offered once, with the common ones", () => {
  const entries = styleEntries("en", catalogue);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  // Each common style stands for one of the pack's, so the count says how many there are.
  expect(entries.length).toBe(catalogue.count + 1);
});
