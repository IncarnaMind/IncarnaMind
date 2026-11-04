import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ClaimCheckAttributes,
  ClaimCheckPart,
  FigureCheckAttributes,
} from "../../src/core/api";
import type { Language } from "../../src/core/language";
import type { ClaimCheckShown } from "../../src/shared/claimChecks";
import { formatDateTime } from "../../src/shared/dates";
import { readFigures } from "../../src/shared/figures";

/*
 * A verdict card's last line names the models whose verdicts it shows, and when (#1667). A card that
 * needs a re-check keeps its last check's line; parts judged on different models name each model
 * once, in the order used, with the latest time. A card with no verdict, or no model known, has no
 * such line.
 */

let root: Root | null = null;
let container: HTMLElement;
let CheckedByLine: ComponentType<Record<string, unknown>>;
let setLanguage: (language: Language) => void;

const EARLIER = "2026-10-23T14:03:00.000Z";
const LATER = "2026-10-23T14:25:00.000Z";
const LATEST = "2026-10-23T14:40:00.000Z";

const HAIKU = { providerId: null, modelId: "claude-haiku-5-5" };
const SONNET = { providerId: null, modelId: "claude-sonnet-5-5" };
const OPUS = { providerId: null, modelId: "claude-opus-5-5" };

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (each, name) => (name === "on" ? each.on : () => Promise.resolve(undefined)) },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  setLanguage = (language) =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, language } as never,
    });
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const linePath = "../../src/renderer/src/editor/CheckedByLine.tsx";
  ({ CheckedByLine } = await import(linePath));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const SENTENCE = "Rent is due monthly and the tenant may keep a cat.";

function verdict(extra: Partial<ClaimCheckAttributes> = {}): ClaimCheckAttributes {
  return {
    id: "check-1",
    request: "request-1",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    ...HAIKU,
    text: SENTENCE,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: EARLIER,
    ...extra,
  };
}

function part(
  start: number,
  end: number,
  by: { providerId: string | null; modelId: string },
  checkedAt: string,
  state: ClaimCheckPart["verdict"] = "supported",
): ClaimCheckPart {
  return {
    span: { start, end },
    kind: "fact",
    verdict: state,
    evidence: [],
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
    ...by,
    checkedAt,
  };
}

function figure(
  id: string,
  by: { providerId: string | null; modelId: string },
  checkedAt: string,
): FigureCheckAttributes {
  const reading = readFigures("10", { language: "en" })[0];
  if (!reading) throw new Error("No fixture figure.");
  return {
    ...verdict({ id, ...by, checkedAt }),
    locator: {
      kind: "text",
      from: { blockId: "block", offset: 0 },
      to: { blockId: "block", offset: 2 },
    },
    reading,
    calculated: null,
    sourceInput: null,
    roundedFrom: null,
    difference: null,
    footing: [],
  };
}

async function lineOf(
  check: ClaimCheckAttributes,
  shown: ClaimCheckShown["state"] = check.state,
  language: Language = "en",
) {
  setLanguage(language);
  await act(() => root?.render(createElement(CheckedByLine, { check, shown })));
  return container.querySelector('[data-testid="claim-checked-by"]')?.textContent ?? null;
}

describe("the line that names what checked a sentence", () => {
  // protects=a verdict's card names its model by its menu name, with the time, in English and Chinese (#1667); fails_when=the line is gone or names the model by its id; no_claim=the time's own format, which src/shared/dates.ts owns.
  test.each([
    ["en", (when: string) => `Checked with Claude Haiku 5.5, ${when}`],
    ["zh-CN", (when: string) => `由 Claude Haiku 5.5 核对，${when}`],
  ] as const)("names the model that checked it (%s)", async (language, said) => {
    expect(await lineOf(verdict(), "supported", language)).toBe(
      said(formatDateTime(EARLIER, language)),
    );
  });

  // protects=a card that needs a re-check keeps its last check's line exactly as it was (#1667); fails_when=the line goes when the sentence is edited, or takes a new time; no_claim=what the card's heading says about the re-check.
  test.each([
    ["en", (when: string) => `Checked with Claude Haiku 5.5, ${when}`],
    ["zh-CN", (when: string) => `由 Claude Haiku 5.5 核对，${when}`],
  ] as const)(
    "keeps the last check's line on a card that needs a re-check (%s)",
    async (language, said) => {
      expect(await lineOf(verdict(), "needs-recheck", language)).toBe(
        said(formatDateTime(EARLIER, language)),
      );
    },
  );

  // protects=parts judged on two models name both, in the order used, with the latest time (#1667); fails_when=the line names only the newer model, orders them as stored, or takes the older time; no_claim=how parts come to differ, which the core's tests check.
  test.each([
    ["en", (when: string) => `Checked with Claude Haiku 5.5 and Claude Sonnet 5.5, ${when}`],
    ["zh-CN", (when: string) => `由 Claude Haiku 5.5 和 Claude Sonnet 5.5 核对，${when}`],
  ] as const)("names each part's model, in the order used (%s)", async (language, said) => {
    const check = verdict({
      ...SONNET,
      checkedAt: LATER,
      parts: [part(0, 19, SONNET, LATER), part(24, 50, HAIKU, EARLIER, "unsupported")],
      state: "unsupported",
    });
    expect(await lineOf(check, "unsupported", language)).toBe(
      said(formatDateTime(LATER, language)),
    );
  });

  // protects=three or more models read "A, B and C" and "A、B 和 C", each once (#1667); fails_when=a model is named twice or the list is joined another way; no_claim=none beyond protects.
  test.each([
    [
      "en",
      (when: string) =>
        `Checked with Claude Haiku 5.5, Claude Sonnet 5.5 and Claude Opus 5.5, ${when}`,
    ],
    [
      "zh-CN",
      (when: string) => `由 Claude Haiku 5.5、Claude Sonnet 5.5 和 Claude Opus 5.5 核对，${when}`,
    ],
  ] as const)("lists three models (%s)", async (language, said) => {
    const check = verdict({
      ...OPUS,
      checkedAt: LATEST,
      parts: [
        part(0, 4, HAIKU, EARLIER),
        part(5, 11, SONNET, LATER),
        part(12, 19, OPUS, LATEST),
        part(24, 50, HAIKU, LATER),
      ],
    });
    expect(await lineOf(check, "supported", language)).toBe(said(formatDateTime(LATEST, language)));
  });

  // protects=only parts whose verdict shows are named: a part not checked or kept as the User's view names no model (#1667); fails_when=a part with no verdict adds its model; no_claim=none beyond protects.
  test("names no model for a part whose verdict doesn't show", async () => {
    const check = verdict({
      parts: [
        part(0, 19, HAIKU, EARLIER),
        part(24, 50, SONNET, LATER, "not-checked"),
        { ...part(24, 50, OPUS, LATEST), kept: true },
      ],
    });
    expect(await lineOf(check)).toBe(
      `Checked with Claude Haiku 5.5, ${formatDateTime(EARLIER, "en")}`,
    );
  });

  // protects=a sentence's figures, each checked with its own source, name their models too (#1667); fails_when=the figures' models are left out for the sentence's; no_claim=none beyond protects.
  test("names the models of a sentence's figures", async () => {
    const check = verdict({
      ...OPUS,
      checkedAt: LATEST,
      figures: [figure("figure-1", HAIKU, EARLIER)],
      remainder: verdict({ id: "check-1:remainder", ...SONNET, checkedAt: LATER }),
    });
    expect(await lineOf(check)).toBe(
      `Checked with Claude Haiku 5.5 and Claude Sonnet 5.5, ${formatDateTime(LATER, "en")}`,
    );
  });

  // protects=a card with no verdict, or whose model isn't known, has no line (#1667); fails_when=a not-checked, checking or kept card names a model, or a re-check of a sentence never checked does; no_claim=none beyond protects.
  test("a card with no verdict, or no model known, has no line", async () => {
    expect(await lineOf(verdict(), "not-checked")).toBeNull();
    expect(await lineOf(verdict(), "checking")).toBeNull();
    expect(await lineOf(verdict(), "kept")).toBeNull();
    expect(
      await lineOf(verdict({ state: "not-checked", reason: "refused" }), "needs-recheck"),
    ).toBeNull();
    expect(await lineOf(verdict({ modelId: null }))).toBeNull();
    expect(await lineOf(verdict({ checkedAt: "" }))).toBeNull();
  });
});
