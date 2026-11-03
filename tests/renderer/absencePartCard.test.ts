/**
 * A part an absence's whole read decided shows only what decided it (#1443): the pages read whole
 * when the absence holds, never a quote the check's search offered on the way.
 */
import { randomUUID } from "node:crypto";
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClaimCheckPart } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    claim: "The lease has no break clause and is governed by English law.",
    absence: "The lease has no break clause",
    rest: "is governed by English law",
    document: "This lease is governed by English law. The tenant pays rent monthly.",
    deciding: "This lease is governed by English law",
    stray: "The tenant pays rent monthly",
    absent: "break clause",
  },
  {
    language: "zh-CN",
    claim: "租约没有提前解约条款，并且适用英国法律。",
    absence: "租约没有提前解约条款",
    rest: "适用英国法律",
    document: "本租约适用英国法律。租户按月支付租金。",
    deciding: "本租约适用英国法律",
    stray: "租户按月支付租金",
    absent: "提前解约条款",
  },
] as const;

function withParts(call: ModelCall, reply: ScriptedReply, parts: readonly string[]): ScriptedReply {
  const first = !call.results.some((result) => result.tool === "search_documents");
  if (!first || !call.system.includes("Parts:")) return reply;
  const named = parts.map((text) => ({ kind: "fact", text }));
  return { ...reply, text: `Parts: ${JSON.stringify(named)}` };
}

/** The sentence checked in a Note: the absence part's search cites a line beside the point. */
async function checked(example: (typeof CASES)[number]) {
  const plans = {
    [example.absence]: { verdict: "unsupported", absence: true, quote: example.stray },
    [example.rest]: { verdict: "supported", quote: example.deciding },
  } as const;
  const model = scriptedModel(
    (call) => withParts(call, checkReply(call, plans), [example.absence, example.rest]),
    {
      generate: (call) =>
        call.system.startsWith("Read the whole Documents")
          ? {
              // As a live read did: the absence holds, and it offers a quote anyway.
              text: JSON.stringify({
                absent: example.absent,
                absence: "holds",
                citations: [{ marker: 1, passage: "P1", quote: example.stray }],
              }),
            }
          : checkGenerate(plans)(call),
    },
  );
  const { core, client, mind } = await setUpWithDocuments(model, [
    { name: "Lease.md", contents: `# Lease\n\n${example.document}\n` },
  ]);
  if (example.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
  writeMind(client, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: example.claim }] },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "one", offset: 0 },
    to: { blockId: "one", offset: example.claim.length },
  });
  await client.settled();
  const check = claimSpans(readMind(client))[0]?.check;
  if (!check?.parts) throw new Error("The sentence was not checked in parts.");
  return { check, parts: check.parts };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

/** The parts' rows as the card renders them. */
async function rows(language: string, text: string, parts: readonly ClaimCheckPart[]) {
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const container = document.createElement("div", {});
  document.body.append(container);
  const root = createRoot(container);
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const content: JSONContent[] = [{ type: "paragraph", content: [{ type: "text", text }] }];
  const editor = new Editor({
    element: document.createElement("div", {}),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  cleanup = async () => {
    await act(() => root.unmount());
    editor.destroy();
    container.remove();
  };
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
  const { ClaimPartRows }: { ClaimPartRows: ComponentType<Record<string, unknown>> } = await import(
    rowsPath
  );
  await act(() =>
    root.render(
      createElement(ClaimPartRows, {
        editor,
        id: "check",
        text,
        parts,
        onCheck: () => undefined,
        onOpen: () => undefined,
      }),
    ),
  );
  return [...container.querySelectorAll('[data-testid="claim-part"]')].map((row) => ({
    words: row.querySelector(".claim-part-words")?.textContent ?? "",
    text: row.textContent ?? "",
  }));
}

describe.each(CASES)("an absence part decided by its whole read ($language)", (example) => {
  test("shows no quote the check offered on the way, and the other part keeps its own", async () => {
    const { check, parts } = await checked(example);
    expect(check.state).toBe("supported");
    const absencePart = parts.find(
      (part) => example.claim.slice(part.span.start, part.span.end) === example.absence,
    );
    expect(absencePart?.verdict).toBe("supported");
    expect(absencePart?.readDocuments).toHaveLength(1);
    // What the mark keeps is what the card, a Citation, the export and the check record show.
    expect(absencePart?.evidence).toEqual([]);
    expect(JSON.stringify(check)).not.toContain(example.stray);

    const shown = await rows(example.language, example.claim, parts);
    const absenceRow = shown.find((row) => row.words === example.absence);
    const restRow = shown.find((row) => row.words === example.rest);
    expect(absenceRow?.text).not.toContain(example.stray);
    expect(restRow?.text).toContain(example.deciding);
  });
});
