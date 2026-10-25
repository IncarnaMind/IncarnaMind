/**
 * A web page's snapshot (#261): the readable article only, in our own XHTML
 * that keeps nothing that runs or loads, read back into sections with
 * numbered paragraphs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readWebPage, webUnits } from "../../src/core/documents/formats/web";
import { decodePage } from "../../src/core/documents/web/fetch";
import { snapshotOf } from "../../src/core/documents/web/snapshot";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/web/${name}`, import.meta.url)));
const page = (name: string) => decodePage(fixture(name), "text/html");

const ADDRESS = "https://encyclopedia.example/wiki/Tea";

describe("A web page's snapshot", () => {
  const snapshot = snapshotOf(page("article.html"), ADDRESS, ADDRESS);

  test("keeps the article, its title, site, author and date, and leaves the page's navigation, ads and footer", () => {
    expect(snapshot).toMatchObject({
      title: "Tea - The Open Encyclopedia",
      siteName: "The Open Encyclopedia",
      author: "Ann Lee",
      published: "2024-05-01T09:30:00+01:00",
    });
    const { meta, blocks } = readWebPage(snapshot.xhtml);
    expect(meta).toEqual({
      title: "Tea - The Open Encyclopedia",
      address: ADDRESS,
      siteName: "The Open Encyclopedia",
      author: "Ann Lee",
      published: "2024-05-01T09:30:00+01:00",
      language: "en",
    });
    const text = blocks.map((block) => block.text).join("\n");
    expect(text).toContain("Tea is an aromatic beverage");
    expect(text).toContain("Tea bushes are pruned to waist height for easy plucking.");
    for (const left of ["Random article", "Related articles", "free licence", "Search"]) {
      expect(text).not.toContain(left);
    }
  });

  test("keeps nothing that runs or loads: no script, style, frame, form, handler, or picture's address", () => {
    const { xhtml } = snapshot;
    for (const unsafe of [
      /<script/i,
      /<style/i,
      /<iframe/i,
      /<form/i,
      /<input/i,
      /<button/i,
      /\son\w+=/i,
      /\ssrc=/i,
      /tracker\.example|track\.example|ads\.example|images\.example/,
      /<link/i,
    ]) {
      expect(xhtml).not.toMatch(unsafe);
    }
    // A picture is its description, marked for the save to fetch; a tracking pixel isn't even that.
    expect(xhtml).toContain('<img alt="A tea plantation on a hillside" data-picture="0"/>');
    expect(xhtml.match(/<img/g)).toHaveLength(1);
    expect(snapshot.pictures).toEqual([
      { index: 0, address: "https://images.example/tea-plantation.jpg" },
    ]);
    // Links are to web addresses, made absolute; the edit link beside a heading goes.
    expect(xhtml).toContain('<a href="https://encyclopedia.example/wiki/Camellia_sinensis">');
    expect(xhtml).not.toContain("edit");
  });

  test("reads as sections, each paragraph numbered from its heading; reference marks are left out", () => {
    const units = webUnits(snapshot.xhtml);
    expect(units.map((unit) => unit.label)).toEqual([
      { path: [], beforeHeading: true, paragraphs: true },
      { path: ["History"], paragraphs: true },
      { path: ["Preparation"], paragraphs: true },
      { path: ["Preparation", "Steeping times"], paragraphs: true },
    ]);
    const [start, history, , steeping] = units;
    expect(start?.text).toBe(
      "Tea is an aromatic beverage prepared by pouring hot or boiling water over cured or fresh leaves of Camellia sinensis, an evergreen shrub native to East Asia. After plain water, tea is the most widely consumed drink in the world.\nThere are many different types of tea; some have a cooling, slightly bitter, and astringent flavour, while others have profiles that include sweet, nutty, floral, or grassy notes. Tea has a stimulating effect in humans, primarily due to its caffeine content.",
    );
    expect(start?.anchors?.map((anchor) => anchor.target)).toEqual(["p1", "p2"]);
    expect(history?.text.split("\n")[0]).toBe("History");
    expect(history?.anchors?.map((anchor) => anchor.target)).toEqual(["p1", "p2", "p3", "p4"]);
    const second = history?.anchors?.[1];
    expect(history?.text.slice(second?.start, second?.end)).toMatch(
      /^Tea was first introduced .* from China\.$/,
    );
    // A list's items are paragraphs, a table is one, its cells separated by tabs.
    expect(steeping?.text).toContain("Green tea is steeped for one to two minutes at about 80 °C.");
    expect(steeping?.text).toContain(
      "Type\tWater\tTime\nGreen\t80 °C\t1–2 min\nBlack\t98 °C\t3–5 min",
    );
    expect(steeping?.text).toContain("water = 250 ml\nleaves = 2.5 g");
  });

  test("a Chinese page in GBK is decoded, with no spaces put between its characters", () => {
    const chinese = snapshotOf(
      page("chinese-gbk.html"),
      "https://cha.example/history",
      "https://cha.example/history",
    );
    expect(chinese.siteName).toBe("茶文化网");
    const units = webUnits(chinese.xhtml);
    expect(chinese.title).toBe("茶的历史");
    expect(units.map((unit) => unit.label?.path)).toEqual([[], ["唐代的茶"], ["宋代的茶"]]);
    expect(units[1]?.text).toContain("陆羽撰写了《茶经》，这是世界上第一部关于茶的专著");
    expect(units[2]?.text).toContain("龙井茶产于浙江杭州西湖一带，属于绿茶。");
  });

  test("a sign-in page is refused as needing a sign-in; a video and an app as having too little text", () => {
    const refused = (name: string) => {
      try {
        snapshotOf(page(name), ADDRESS, ADDRESS);
        return null;
      } catch (error) {
        return (error as { reason?: string }).reason ?? null;
      }
    };
    expect(refused("login.html")).toBe("needs-sign-in");
    expect(refused("video.html")).toBe("video");
    expect(refused("app.html")).toBe("not-text");
  });

  test("a long section is split into parts at paragraph ends, its paragraphs numbered on across them", () => {
    const paragraph = (n: number) =>
      `<p>${`Paragraph ${n} says something about tea. `.repeat(40)}</p>`;
    const html = `<html><head><title>Long</title></head><body><article><h2>Long</h2>${Array.from(
      { length: 8 },
      (_, index) => paragraph(index + 1),
    ).join("")}</article></body></html>`;
    const units = webUnits(snapshotOf(html, ADDRESS, ADDRESS).xhtml);
    expect(units.length).toBeGreaterThan(1);
    expect(units.map((unit) => unit.label?.part ?? 1)).toEqual(units.map((_, index) => index + 1));
    const numbers = units.flatMap((unit) => unit.anchors?.map((anchor) => anchor.target) ?? []);
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, index) => `p${index + 1}`));
  });

  test("the site is named by the page, else by its title beside the article's, before its publisher; a link's space stays outside it", () => {
    const body = `<p>${"Tea grows on hills north of Batumi, and the leaves are picked by hand. ".repeat(6)}The station north of <a href="/wiki/Batumi">Batumi</a> weighed it.</p>`;
    const page = (head: string) =>
      `<html><head>${head}<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Tea","publisher":{"@type":"Organization","name":"Wikimedia Foundation, Inc."}}</script></head><body><article><h1>Tea</h1>${body}</article></body></html>`;
    const titled = snapshotOf(page("<title>Tea - Wikipedia</title>"), ADDRESS, ADDRESS);
    expect(titled).toMatchObject({ title: "Tea", siteName: "Wikipedia" });
    expect(titled.xhtml).toContain(
      'The station north of <a href="https://encyclopedia.example/wiki/Batumi">Batumi</a> weighed it.',
    );
    const named = snapshotOf(
      page(
        '<title>Tea - Wikipedia</title><meta property="og:site_name" content="The Free Encyclopedia">',
      ),
      ADDRESS,
      ADDRESS,
    );
    expect(named.siteName).toBe("The Free Encyclopedia");
    expect(snapshotOf(page("<title>Tea</title>"), ADDRESS, ADDRESS).siteName).toBe(
      "Wikimedia Foundation, Inc.",
    );
  });
});
