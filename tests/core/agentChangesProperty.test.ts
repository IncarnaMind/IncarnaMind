/**
 * Whatever an outside agent writes, its change cites only with the tokens IncarnaMind gave it
 * and keeps only the User's own by their handles (#352): seeded random texts of brackets,
 * digits, emphasis, links, word joiners, tables and footnote lines, on both paths (a rewrite
 * and new paragraphs), each accepted and its Citations, footnotes and figures counted.
 */
import { describe, expect, it } from "vitest";
import { FOOTNOTE_NODE } from "../../src/core/api";
import { pendingProposals } from "../../src/shared/proposals";
import { CITABLE, type Citable, citingIn, propose, QUOTES, SPRING } from "../helpers/agentChanges";

/** A seeded generator (mulberry32): the same texts on every machine. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  return { next, pick };
}

const WORDS = [
  "Tides",
  "rise",
  "the",
  "moon",
  "is",
  "cheese",
  "harbour",
  "walls",
  "大潮",
  "每月",
  "2023",
];

/** What reads as a marker, a source or a format somewhere, and none of it is a token. */
const NOISE = [
  "[1]",
  "[2]",
  "[^1]",
  "[^2]",
  "[=1]",
  "[**1**]",
  "[*1*]",
  "[_1_]",
  "[__1__]",
  "[~~1~~]",
  "[_^1_]",
  "[**^1**]",
  "[=**1**]",
  "**[1]**",
  "*[^1]*",
  "\\[1]",
  "\\[^1]",
  "[\\^1]",
  "[\\*1\\*]",
  "[sic]",
  "[Tides]",
  "[Tides.md]",
  "[Tides, p. 1]",
  "[Moon]",
  "[\u20601]",
  "[\u2060^1]",
  "\u2060",
  "[ 1 ]",
  "**bold**",
  "*it*",
  "_under_",
  "~~gone~~",
  "`[1]`",
  "$x$",
  "[link](https://example.com)",
  "[[1]](https://example.com)",
  "[see](https://example.com/[1])",
  "[kept:2]",
  "[note:2]",
  "\\[kept:1]",
  "\\[note:1]",
  "[cite:zzzz9999]",
  "[cite:BAD]",
  "[cite:ownwork1]",
  "【1】",
  "［1］",
  "<removed>",
  "42",
  "3.5%",
  "(1)",
  "^1",
  "=1",
];

/**
 * One random agent text and what it cites: how often each token it may cite stands in it, and
 * whether it keeps the User's Citation ("[kept:1]") and footnote ("[note:1]") by their handles.
 */
function agentText(rng: ReturnType<typeof random>) {
  const tokens: Record<string, number> = {};
  let keepsCitation = false;
  let keepsNote = false;
  const piece = (): string => {
    const roll = rng.next();
    if (roll < 0.12) {
      const token = rng.pick(CITABLE);
      tokens[token] = (tokens[token] ?? 0) + 1;
      return `[cite:${token}]`;
    }
    if (roll < 0.16) {
      keepsCitation = true;
      return "[kept:1]";
    }
    if (roll < 0.2) {
      keepsNote = true;
      return "[note:1]";
    }
    if (roll < 0.6) return rng.pick(NOISE);
    return rng.pick(WORDS);
  };
  const words = (min: number, spread: number) =>
    Array.from({ length: min + Math.floor(rng.next() * spread) }, piece).join(" ");
  const plainWords = () =>
    Array.from({ length: 2 + Math.floor(rng.next() * 3) }, () => rng.pick(WORDS)).join(" ");
  const block = (): string => {
    const roll = rng.next();
    if (roll < 0.15) {
      const rows = Array.from(
        { length: 1 + Math.floor(rng.next() * 3) },
        () => `| ${words(1, 3)} | ${words(1, 2)} |`,
      );
      return ["| Claim | Source |", "| --- | --- |", ...rows].join("\n");
    }
    if (roll < 0.22) return `## ${words(1, 4)}`;
    if (roll < 0.3) return `- ${words(2, 5)}`;
    // A footnote's definition, as Markdown writes one: never where a token goes.
    if (roll < 0.35) return `[^1]: ${plainWords()}`;
    return `${words(3, 8)}.`;
  };
  const text = Array.from({ length: 1 + Math.floor(rng.next() * 3) }, block).join("\n\n");
  return { text, tokens, keepsCitation, keepsNote };
}

const CASES = 2000;

describe("an outside agent's change, whatever it writes (#352)", () => {
  for (const path of ["rewrite", "add"] as const) {
    it(`cites only with its tokens, and keeps only by its handles: ${CASES} seeded texts, ${path}`, () => {
      const rng = random(path === "rewrite" ? 352 : 2387);
      const outcomes: Record<string, number> = {};
      for (let index = 0; index < CASES; index++) {
        const written = agentText(rng);
        const { blocks, outcome } = propose(path, written.text);
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        const expected: Record<string, number> = {};
        const add = (key: string, n = 1) => {
          if (n > 0) expected[key] = (expected[key] ?? 0) + n;
        };
        // A rewrite replaces the User's paragraph: what it keeps of it, it keeps by handle.
        const accepted = outcome === "accepted";
        const keepsAll = path === "add" || !accepted;
        add(`tides: ${SPRING}`, keepsAll || written.keepsCitation ? 1 : 0);
        add(FOOTNOTE_NODE, keepsAll || written.keepsNote ? 1 : 0);
        if (accepted) {
          for (const [token, n] of Object.entries(written.tokens)) {
            add(`moon: ${QUOTES[token as Citable]}`, n);
          }
        }
        expect(citingIn(blocks), `${path} #${index}: ${JSON.stringify(written.text)}`).toEqual(
          expected,
        );
        expect(pendingProposals(blocks)).toEqual([]);
      }
      // Most texts are proposed: a refusal is only for a change IncarnaMind can't write as it is.
      expect(outcomes.accepted ?? 0).toBeGreaterThan(CASES * 0.8);
      expect(outcomes["agents.propose.unplaced"] ?? 0).toBe(0);
    });
  }
});
