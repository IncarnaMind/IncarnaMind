import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Document, RunEstimate } from "../../src/core/api";

/** A line is rendered as the Library shows it, in a DOM with no layout: its structure is what these read. */
async function mounted<Props extends object>(
  modulePath: string,
  name: string,
  props: Props,
  before?: () => Promise<void>,
) {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  // The window's half of the core, as a bridge that answers nothing: the lines read the store, not the core.
  const bridge = new Proxy(
    { on: () => () => undefined },
    { get: (target, name) => (name === "on" ? target.on : vi.fn(async () => [])) },
  );
  const window = Object.assign(document.defaultView, { incarnamind: bridge, incarnamindFiles: {} });
  const kept = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
  for (const [key, value] of Object.entries({
    document,
    window,
    localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(key, value);
  }
  await before?.();
  const module = (await import(modulePath)) as Record<string, never>;
  const container = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(module[name] as never, props)));
  return { container, unmount: () => act(async () => root.unmount()) };
}

/** The meta line whose part holds the control with `testId`, and that part. */
function partOf(container: Element, line: string, testId: string) {
  const row = container.querySelector(`[data-testid="${line}"]`);
  const outer = row?.matches(".meta-line") ? row : row?.querySelector(".meta-line");
  if (!row || !outer) throw new Error(`No meta line for ${line}.`);
  const part = [...outer.children].find((each) => each.querySelector(`[data-testid="${testId}"]`));
  return { row, outer, part };
}

describe("A Library line's actions are one part of it (#3114)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // protects=the Library's line for a Document that couldn't be read keeps its two actions as one part of a meta line, so they never land on rows apart while the pair fits one row (#3114); fails_when=the two buttons are siblings in a wrapping row of their own, or draw a dot of their own
  test("a Document that couldn't be read: Open in default app and Open to print to PDF… share one part", async () => {
    const document = {
      id: "form",
      name: "Inspection",
      kind: "pdf",
      status: "failed",
      fileStatus: "available",
      size: 2048,
      failure: { reason: "forms-unread", message: "" },
      web: null,
      keptByApp: false,
    } as unknown as Document;
    const { container, unmount } = await mounted(
      "../../src/renderer/src/components/DocumentFix.tsx",
      "DocumentFix",
      { document },
    );
    const open = partOf(container, "library-fix", "library-fix-open");
    const print = partOf(container, "library-fix", "library-fix-print");
    expect(open.part).toBeDefined();
    expect(print.part).toBe(open.part);
    expect(open.part?.querySelector(":scope > .meta-line")?.children).toHaveLength(2);
    expect(open.row.querySelectorAll(".meta-dot")).toHaveLength(1);
    await unmount();
  });

  // protects=Organize's estimate line is a shared meta line whose two actions are one part, and it draws no dot of its own (#3114); fails_when=Organize and Not now are parts apart, or an action draws its own dot as a separate item
  test("Organize's estimate: Organize and Not now share one part, and no dot is drawn but the line's", async () => {
    const estimate = {
      billing: "per-token",
      cost: { currency: "USD", amount: 1.4 },
    } as RunEstimate;
    const { container, unmount } = await mounted(
      "../../src/renderer/src/components/library/OrganizeLines.tsx",
      "OrganizeLines",
      {},
      async () => {
        const path = "../../src/renderer/src/organizeReview.ts";
        const { useOrganizeReview } = (await import(path)) as {
          useOrganizeReview: { setState(state: object): void };
        };
        useOrganizeReview.setState({
          estimate: { estimate, input: {}, count: 40 },
          run: null,
        });
      },
    );
    const go = partOf(container, "organize-estimate", "organize-estimate-go");
    const notNow = partOf(container, "organize-estimate", "organize-estimate-not-now");
    expect(go.part).toBeDefined();
    expect(notNow.part).toBe(go.part);
    expect(go.part?.querySelector(":scope > .meta-line")?.children).toHaveLength(2);
    expect(go.row.querySelectorAll(".meta-dot")).toHaveLength(2);
    expect([...go.row.querySelectorAll("span")].filter((each) => each.textContent === "·")).toEqual(
      [],
    );
    await unmount();
  });
});
