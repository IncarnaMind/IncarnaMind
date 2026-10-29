import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import fixture from "../../eval/attribution/cases.json";

const sources = new Map(fixture.sources.map((source) => [source.id, source]));
const profiles = new Map(fixture.profiles.map((profile) => [profile.id, profile]));

test("the paired set has one English and one Chinese assertion in each isolated profile", () => {
  expect(fixture.cases).toHaveLength(40);
  expect(fixture.sources).toHaveLength(48);
  expect(new Set(fixture.cases.map((each) => each.id)).size).toBe(40);
  expect(new Set(fixture.sources.map((each) => each.id)).size).toBe(48);
  const pairs = new Set(fixture.cases.map((each) => each.pairId));
  expect(pairs.size).toBe(20);
  for (const pair of pairs) {
    expect(
      fixture.cases
        .filter((each) => each.pairId === pair)
        .map((each) => each.language)
        .sort(),
    ).toEqual(["en", "zh-CN"]);
  }
  expect(new Set(fixture.cases.map((each) => each.profileId)).size).toBe(40);
});

test("the immutable Source bytes and profile membership retain the intended scope", () => {
  for (const source of fixture.sources) {
    expect(createHash("sha256").update(source.text).digest("hex"), source.id).toBe(source.sha256);
  }
  for (const profile of fixture.profiles) {
    const inside = new Set(profile.inScopeSourceIds);
    expect(inside.size, profile.id).toBe(profile.inScopeSourceIds.length);
    expect(
      profile.outsideScopeSourceIds.some((id) => inside.has(id)),
      profile.id,
    ).toBe(false);
    for (const id of [...inside, ...profile.outsideScopeSourceIds]) {
      expect(sources.has(id), `${profile.id}: ${id}`).toBe(true);
    }
  }
});

test("every gold quote belongs to its exact scoped Source, never the outside decoy", () => {
  let references = 0;
  for (const each of fixture.cases) {
    const profile = profiles.get(each.profileId);
    if (!profile) throw new Error(`Missing profile: ${each.profileId}`);
    for (const proof of each.gold.sourceEvidence) {
      const source = sources.get(proof.sourceId);
      if (!source) throw new Error(`Missing Source: ${proof.sourceId}`);
      expect(profile.inScopeSourceIds, each.id).toContain(source.id);
      expect(
        source.text.slice(proof.rangeUTF16.start, proof.rangeUTF16.end),
        `${each.id}: ${source.id}`,
      ).toBe(proof.quote);
      references++;
    }
  }
  expect(references).toBe(54);
});

test("facet and native figure targets keep literal occurrences in the original assertion", () => {
  let facets = 0;
  for (const each of fixture.cases) {
    const targets = [...each.gold.facetTargets, ...each.gold.nativeFigureAnchors];
    for (const target of targets) {
      const { start, end } = target.span;
      expect(start, each.id).toBeGreaterThanOrEqual(0);
      expect(end, each.id).toBeGreaterThan(start);
      expect(end, each.id).toBeLessThanOrEqual(each.text.length);
      expect(each.text.slice(start, end), each.id).toBe(target.literal);
      for (const boundary of [start, end]) {
        const before = each.text.charCodeAt(boundary - 1);
        const after = each.text.charCodeAt(boundary);
        expect(
          before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff,
          each.id,
        ).toBe(false);
      }
    }
    facets += each.gold.facetTargets.length;
    expect(
      new Set(each.gold.nativeFigureAnchors.map(({ span }) => `${span.start}:${span.end}`)).size,
      each.id,
    ).toBe(each.gold.nativeFigureAnchors.length);
  }
  expect(facets).toBe(28);
});

test("the gold bars include supported controls rather than rewarding blanket rejection", () => {
  const count = (verdict: string) =>
    fixture.cases.filter((each) => each.gold.nativeVerdict === verdict).length;
  expect([count("supported"), count("unsupported"), count("contradicted")]).toEqual([12, 16, 12]);
  expect(
    fixture.cases.filter(
      (each) => each.family === "out-of-context" && each.gold.nativeVerdict === "contradicted",
    ),
  ).toHaveLength(10);
  expect(fixture.checkAtISO).toBe("2026-10-29T12:00:00.000Z");
  for (const each of fixture.cases) {
    if (["N04", "S03", "T03", "T05", "T06"].includes(each.pairId)) {
      expect(each.gold.nativeVerdict, each.id).toBe("unsupported");
    }
    if (["T01", "T04", "T07"].includes(each.pairId)) {
      expect(each.gold.nativeVerdict, each.id).toBe("supported");
    }
  }
});
