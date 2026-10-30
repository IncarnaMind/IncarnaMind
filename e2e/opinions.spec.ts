import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor, JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckPart,
  CoreBridge,
} from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { writeMindCheck } from "../src/shared/mindCheck";
import { writeOpinionSentences } from "../src/shared/opinions";
import { writeVerification } from "../src/shared/verification";
import { wordFile, paragraph as wordParagraph } from "../tests/helpers/word";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  focusSettled,
  launchApp,
  linkFolderFromSidebar,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  slideSelect,
} from "./app";

import { opinionSource, OPINION_WORDS as WORDS } from "./fixtures/opinions";

const part = (
  start: number,
  end: number,
  kind: ClaimCheckPart["kind"],
  evidence: CitationAttributes[] = [],
): ClaimCheckPart => ({
  span: { start, end },
  kind,
  verdict: kind === "opinion" ? null : "supported",
  evidence,
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});
const paragraph = (id: string, text: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text, ...(check && { marks: [{ type: "claimCheck", attrs: check }] }) },
  ],
});
const checked = (id: string, text: string, parts: ClaimCheckPart[]): ClaimCheckAttributes => ({
  id,
  text,
  parts,
  request: "parts-smoke",
  action: "check-against-documents",
  state: "supported",
  reason: null,
  detail: null,
  providerId: null,
  modelId: null,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-28T20:00:00.000Z",
});

async function setContent(window: Page, content: JSONContent[]) {
  await window.getByTestId("mind-editor").evaluate((dom, blocks) => {
    const editor = (dom as unknown as { editor: Editor }).editor;
    editor.commands.setContent(blocks);
    editor.commands.setTextSelection(1);
  }, content);
}

async function applySettings(window: Page, update: number[]) {
  const mindId = await window.getByTestId("mind-pane").last().getAttribute("data-mind-id");
  if (!mindId) throw new Error("The test Note is not open.");
  const state = await window.evaluate(
    async (id) =>
      Array.from(
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.openMind(id))
          .state,
      ),
    mindId,
  );
  const current = new Y.Doc();
  Y.applyUpdate(current, new Uint8Array(state));
  const vector = Y.encodeStateVector(current);
  const patch = new Y.Doc();
  Y.applyUpdate(patch, new Uint8Array(update));
  current.transact(() => {
    for (const [key, value] of patch.getMap("settings")) current.getMap("settings").set(key, value);
  });
  const change = Array.from(Y.encodeStateAsUpdate(current, vector));
  await window.evaluate(
    async ({ id, update }) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
        id,
        new Uint8Array(update),
      );
    },
    { id: mindId, update: change },
  );
}

async function partsOfCheck(window: Page, id: string) {
  return window.getByTestId("mind-editor").evaluate((dom, id): ClaimCheckPart[] | null => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    let parts: ClaimCheckPart[] | null = null;
    state.doc.descendants((node) => {
      const mark = node.marks.find(
        (mark) => mark.type.name === "claimCheck" && mark.attrs.id === id,
      );
      if (Array.isArray(mark?.attrs.parts)) parts = mark.attrs.parts as ClaimCheckPart[];
    });
    return parts;
  }, id);
}

async function rightClickWords(window: Page, blockId: string, words: string) {
  const point = await window.getByTestId("mind-editor").evaluate(
    (dom, { blockId, words }): { x: number; y: number } | null => {
      const editor = (dom as unknown as { editor: Editor }).editor;
      let point: { x: number; y: number } | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (!node.isTextblock || node.attrs.id !== blockId) return;
        const index = node.textContent.indexOf(words);
        if (index < 0) return;
        const caret = editor.view.coordsAtPos(pos + 1 + index + Math.floor(words.length / 2));
        point = { x: caret.left + 2, y: (caret.top + caret.bottom) / 2 };
      });
      return point;
    },
    { blockId, words },
  );
  if (!point) throw new Error("The test words are not in the Note.");
  await window.mouse.move(point.x, point.y);
  await window.mouse.click(point.x, point.y, { button: "right" });
}

async function terminalPart(window: Page, id: string, index: number) {
  await expect
    .poll(async () => (await partsOfCheck(window, id))?.[index]?.verdict ?? "omitted")
    .toMatch(/^(supported|unsupported|contradicted|not-checked)$/);
}

async function allRowsVisible(window: Page, count: number) {
  const rows = window.getByTestId("claim-card").getByTestId("claim-part");
  await expect(rows).toHaveCount(count);
  for (let index = 0; index < count; index++)
    await expect(rows.nth(index)).toBeInViewport({ ratio: 1 });
}

async function selectedWords(window: Page) {
  return window.getByTestId("mind-editor").evaluate((dom) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    return state.doc.textBetween(state.selection.from, state.selection.to);
  });
}

async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await motionSettled(window);
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`opinions have exact Show targets, a part-only menu and palette action, and ordered sources (${language})`, async () => {
    test.setTimeout(180_000);
    const data = await createDataFolder();
    const sources = await createDataFolder();
    const words = WORDS[language];
    await writeFile(join(sources, "Results.txt"), opinionSource(language));
    await writeFile(
      join(sources, "Analyst memo.txt"),
      `${words.attributed}\n${words.verifyOpinion}`,
    );
    const { app, window } = await launchApp(data, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await setLocalChatModel(window);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, "Results.txt"), join(sources, "Analyst memo.txt")]);
      const documents = await window.evaluate(() =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
      );
      const document = documents.find((each) => each.name === "Results");
      const verified = documents.find((each) => each.name === "Analyst memo");
      if (!document || !verified) throw new Error("The source and Verify document were not added.");
      const citation: CitationAttributes = {
        passageId: "part-source",
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        quote: words.fact.trim(),
        pageFrom: null,
        pageTo: null,
        location: null,
        check: "found",
        checkReason: null,
      };
      for (const width of [900, 1600]) {
        await newMind(window);
        await setWindowSize(app, window, width, 900);
        const mixed = words.fact + words.opinion;
        if (width === 900) {
          const legacy = checked("legacy-check", words.fact.trim(), []);
          delete legacy.parts;
          legacy.evidence = citation;
          await setContent(window, [paragraph("legacy", words.fact.trim(), legacy)]);
          await expect(window.getByTestId("claim-mark")).toContainText("+");
          await window.getByTestId("claim-mark").click();
          await expect(window.getByTestId("claim-add-citation")).toBeVisible();
          await window.keyboard.press("Escape");
          await setContent(window, [
            paragraph(
              "multisource",
              words.fact.trim(),
              checked("multisource-check", words.fact.trim(), [
                part(0, words.fact.trim().length, "fact", [
                  { ...citation, id: "receipt-first" },
                  {
                    ...citation,
                    id: "receipt-second",
                    passageId: "second-source",
                    documentId: verified.id,
                    documentName: verified.name,
                    contentHash: verified.contentHash,
                    quote: words.attributed,
                  },
                ]),
              ]),
            ),
          ]);
          await expect(window.getByTestId("claim-mark")).toContainText("+");
          const sourceParts = await partsOfCheck(window, "multisource-check");
          await pointAndClick(window, window.getByTestId("claim-mark"));
          const sourceCard = window.getByTestId("claim-card");
          const receipts = sourceCard.getByTestId("claim-part-receipt");
          const firstToggle = receipts.nth(0).getByTestId("sign-off-toggle");
          const secondToggle = receipts.nth(1).getByTestId("sign-off-toggle");
          await expect(firstToggle).toHaveText(translate(language, "signOff.action"));
          await pointAndClick(window, firstToggle);
          await expect(firstToggle).toHaveAttribute("aria-pressed", "true");
          await expect(secondToggle).toHaveAttribute("aria-pressed", "false");
          await expect(receipts.nth(0).getByTestId("sign-off-line")).toHaveAttribute(
            "data-state",
            "checked",
          );
          await screenshot(window, `opinions-part-signoff-${language}-${width}`);
          await pointAndClick(window, window.getByTestId("undo-action"));
          await expect(sourceCard).toHaveCount(0);
          await pointAndClick(window, window.getByTestId("claim-mark"));
          await expect(firstToggle).toHaveAttribute("aria-pressed", "false");
          await pointAndClick(window, receipts.nth(0), { button: "right" });
          const humanMark = window.getByRole("menuitemcheckbox", {
            name: translate(language, "signOff.action"),
          });
          await expect(humanMark).toHaveAttribute("aria-checked", "false");
          await pointAndClick(window, humanMark);
          await expect(firstToggle).toHaveAttribute("aria-pressed", "true");
          await firstToggle.focus();
          await runCommand(window, "citation.signOffRemove", translate(language, "signOff.action"));
          await window.keyboard.press("Escape");
          await expect(sourceCard).toHaveCount(0);
          await pointAndClick(window, window.getByTestId("claim-mark"));
          await expect(firstToggle).toHaveAttribute("aria-pressed", "false");
          await expect(secondToggle).toHaveAttribute("aria-pressed", "false");
          expect(await partsOfCheck(window, "multisource-check")).toEqual(sourceParts);
          await expect(sourceCard).toHaveAttribute("data-check", "supported");
          await window.keyboard.press("Escape");
          const pending = checked("pending-check", mixed, [
            { ...part(0, words.fact.length, "fact"), verdict: "checking" },
            part(words.fact.length, mixed.length, "opinion"),
          ]);
          pending.state = "checking";
          await setContent(window, [paragraph("pending", mixed, pending)]);
          await window.getByTestId("claim-mark").click();
          await expect(
            window.getByTestId("claim-card").getByTestId("claim-part-check-anyway"),
          ).toBeDisabled();
          await screenshot(window, `opinions-pending-${language}-${width}`);
          await window.keyboard.press("Escape");
        }
        await setContent(window, [
          paragraph(
            "mixed",
            mixed,
            checked("mixed-check", mixed, [
              part(0, words.fact.length, "fact", [{ ...citation, id: "mixed-fact-receipt" }]),
              part(words.fact.length, mixed.length, "opinion"),
            ]),
          ),
          paragraph("pure", words.pure),
        ]);
        const settings = new Y.Doc();
        writeOpinionSentences(settings, [
          {
            id: "pure-check",
            blockId: "pure",
            text: words.pure,
            occurrence: 0,
            parts: [part(0, words.pure.length, "opinion")],
          },
        ]);
        writeMindCheck(settings.getMap("settings"), {
          at: "2026-10-28T20:00:00.000Z",
          sentences: 1,
          stop: null,
          skipped: [],
          unexamined: [],
        });
        await applySettings(window, Array.from(Y.encodeStateAsUpdate(settings)));
        const health = await checkCard(window);
        await expect(health.getByTestId("opinions-line").first()).toContainText(words.omitted);
        await expect(window.getByTestId("claim-mark")).toHaveCount(1);
        await expect(window.getByTestId("claim-mark")).toContainText("+");
        await pointAndClick(window, health.getByTestId("opinions-show").first());
        const card = window.getByTestId("claim-card");
        await allRowsVisible(window, 2);
        await expect(window.getByTestId("selection-menu")).toBeHidden();
        expect(await selectedWords(window)).toBe(words.opinion);
        await screenshot(window, `opinions-mixed-${language}-${width}`);
        await window.keyboard.press("Escape");
        const nextHealth = await checkCard(window);
        await pointAndClick(window, nextHealth.getByTestId("opinions-show").first());
        await expect(card).toHaveAttribute("data-check", "opinion");
        await expect(window.getByTestId("selection-menu")).toBeHidden();
        await expect(card.getByTestId("claim-part")).toHaveCount(1);
        expect(await selectedWords(window)).toBe(words.pure);
        await screenshot(window, `opinions-pure-${language}-${width}`);
        await card.getByTestId("claim-part").click({ button: "right" });
        await expect(
          window.getByRole("menuitem", { name: words.anyway, exact: true }),
        ).toBeVisible();
        await window.keyboard.press("Escape");
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("mind-editor")).toBeFocused();
        await rightClickWords(window, "pure", words.pure);
        await expect(
          window
            .getByTestId("opinion-context-actions")
            .getByRole("menuitem", { name: words.anyway, exact: true }),
        ).toBeVisible();
        expect(await selectedWords(window)).toBe(words.pure);
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("mind-editor")).toBeFocused();
        expect(await selectedWords(window)).toBe(words.pure);
        for (const key of ["ContextMenu", "Shift+F10"]) {
          await window.keyboard.press(key);
          const opinionMenu = window.getByTestId("opinion-context-actions");
          await expect(opinionMenu).toBeVisible();
          await expect(
            opinionMenu.getByRole("menuitem", { name: words.anyway, exact: true }),
          ).toBeFocused();
          expect(await selectedWords(window)).toBe(words.pure);
          const selectionBox = await window.getByTestId("mind-editor").evaluate((dom) => {
            const editor = (dom as unknown as { editor: Editor }).editor;
            const from = editor.view.coordsAtPos(editor.state.selection.from);
            const to = editor.view.coordsAtPos(editor.state.selection.to);
            return { left: from.left, right: to.right, top: from.top, bottom: to.bottom };
          });
          const menuBox = await opinionMenu.boundingBox();
          if (!menuBox) throw new Error("The opinion menu has no visible bounds.");
          expect(menuBox.x).toBeGreaterThanOrEqual(selectionBox.left - menuBox.width);
          expect(menuBox.x).toBeLessThan(selectionBox.right);
          expect(
            Math.min(
              Math.abs(menuBox.y - selectionBox.bottom),
              Math.abs(menuBox.y + menuBox.height - selectionBox.top),
            ),
          ).toBeLessThan(menuBox.height);
          await window.keyboard.press("Escape");
          await expect(window.getByTestId("mind-editor")).toBeFocused();
          expect(await selectedWords(window)).toBe(words.pure);
        }
        // ⌘K on selected words adds a link, as everywhere in a Note; with the caret in the
        // opinion it opens the palette, which reaches the opinion's card.
        await window.keyboard.press("ControlOrMeta+k");
        await expect(window.getByTestId("link-field")).toBeVisible();
        await expect(window.getByTestId("palette")).toHaveCount(0);
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("link-field")).toHaveCount(0);
        if (language === "en" && width === 900) {
          const gutter = await window.getByTestId("mind-editor").evaluate((dom) => {
            const editor = (dom as unknown as { editor: Editor }).editor;
            const start = editor.view.coordsAtPos(editor.state.selection.from);
            return {
              x: Math.max(dom.getBoundingClientRect().left + 1, start.left - 12),
              y: (start.top + start.bottom) / 2,
              textLeft: start.left,
            };
          });
          expect(gutter.x).toBeLessThan(gutter.textLeft);
          await window.mouse.move(gutter.x, gutter.y);
          await window.mouse.click(gutter.x, gutter.y, { button: "right" });
          await expect(window.getByTestId("opinion-context-actions")).toBeHidden();
          await window.keyboard.press("Escape");
        }
        await focusSettled(window, window.getByTestId("mind-editor"));
        await window.keyboard.press("ArrowLeft");
        await expect.poll(() => selectedWords(window)).toBe("");
        await runCommand(
          window,
          "check.showCard",
          language === "en" ? "Show the check for this sentence" : "查看这句话的核对结果",
        );
        await expect(card.getByTestId("claim-part-check-anyway")).toBeFocused();
        if (width === 900) {
          const factBefore = (await partsOfCheck(window, "mixed-check"))?.[0];
          await window.keyboard.press("Enter");
          await terminalPart(window, "pure-check", 0);
          await expect(card).toBeVisible();
          await expect(window.getByTestId("selection-menu")).toBeHidden();
          expect(await selectedWords(window)).toBe(words.pure);
          await expect
            .poll(() =>
              card.evaluate((element) => {
                const active = element.ownerDocument.activeElement;
                return element.contains(active)
                  ? "inside"
                  : `${active?.tagName}:${active?.getAttribute("data-testid")}`;
              }),
            )
            .toBe("inside");
          expect((await partsOfCheck(window, "mixed-check"))?.[0]).toEqual(factBefore);
          await expect(window.getByTestId("claim-mark")).toHaveCount(2);
          const remaining = await checkCard(window);
          await expect(remaining.getByTestId("opinions-line").first()).toContainText(
            language === "en" ? "1 opinion left out" : "1 处观点未纳入核对",
          );
          await pointAndClick(window, remaining.getByTestId("opinions-show").first());
          expect(await selectedWords(window)).toBe(words.opinion);
          await window.keyboard.press("Escape");
          await focusSettled(window, window.getByTestId("mind-editor"));
          await window.keyboard.press("ArrowLeft");
          await expect.poll(() => selectedWords(window)).toBe("");
          await runCommand(window, "check.anyway", words.anyway);
          await terminalPart(window, "mixed-check", 1);
          await expect(card).toBeVisible();
          expect(await selectedWords(window)).toBe(words.opinion);
          expect((await partsOfCheck(window, "mixed-check"))?.[0]).toEqual(factBefore);
          const completed = await checkCard(window);
          await expect(completed.getByTestId("opinions-line")).toHaveCount(0);
          await window.keyboard.press("Escape");
          await setContent(window, [
            paragraph(
              "mixed",
              mixed,
              checked("menu-check", mixed, [
                part(0, words.fact.length, "fact", [{ ...citation, id: "menu-fact-receipt" }]),
                part(words.fact.length, mixed.length, "opinion"),
              ]),
            ),
          ]);
          const menuFactBefore = (await partsOfCheck(window, "menu-check"))?.[0];
          await rightClickWords(window, "mixed", words.fact.trim());
          await expect(window.getByTestId("opinion-context-actions")).toBeHidden();
          await window.keyboard.press("Escape");
          await rightClickWords(window, "mixed", words.opinion);
          expect(await selectedWords(window)).toBe(words.opinion);
          await pointAndClick(
            window,
            window
              .getByTestId("opinion-context-actions")
              .getByRole("menuitem", { name: words.anyway, exact: true }),
          );
          await terminalPart(window, "menu-check", 1);
          await expect(card).toBeVisible();
          expect(await selectedWords(window)).toBe(words.opinion);
          expect((await partsOfCheck(window, "menu-check"))?.[0]).toEqual(menuFactBefore);
          const menuDone = await checkCard(window);
          await expect(menuDone.getByTestId("opinions-line")).toHaveCount(0);
          await window.keyboard.press("Escape");
        } else await window.keyboard.press("Escape");

        const summaryText = Array.from({ length: 6 }, (_, index) =>
          language === "en" ? `Part ${index + 1} grew` : `第 ${index + 1} 项增长`,
        );
        const summary = `${summaryText.join("; ")}.`;
        let at = 0;
        const summaryParts = summaryText.map((text) => {
          const result = part(at, at + text.length, "fact", [{ ...citation, quote: text }]);
          at += text.length + 2;
          return result;
        });
        await setContent(window, [
          paragraph("summary", summary, checked("summary-check", summary, summaryParts)),
        ]);
        await window.getByTestId("claim-mark").click();
        await allRowsVisible(window, 4);
        await expect(card.getByTestId("claim-parts-coverage")).toHaveCount(0);
        await screenshot(window, `opinions-four-${language}-${width}`);
        await card.getByTestId("claim-parts-more").focus();
        await window.keyboard.press("Enter");
        await expect(card.getByTestId("claim-part")).toHaveCount(6);
        // The first row it shows takes the focus, at its first action: its Add as Citation.
        await expect(
          card.getByTestId("claim-part").nth(4).getByTestId("claim-part-add-citation"),
        ).toBeFocused();
        await screenshot(window, `opinions-more-${language}-${width}`);
        await pointAndClick(
          window,
          card.getByTestId("claim-part").nth(4).getByTestId("claim-part-citation"),
        );
        const viewer = window.getByTestId("viewer");
        await expect(viewer).toBeVisible();
        await expect
          .poll(async () =>
            (await viewer.locator("[data-quote-highlight]").allTextContents()).join(""),
          )
          .toBe(summaryText[4]);
        await expect(viewer.locator("[data-quote-highlight]").first()).toBeInViewport();
        await screenshot(window, `opinions-source-${language}-${width}`);
        const sourceTab = window.getByTestId("document-tab").first();
        await sourceTab.hover();
        await pointAndClick(window, sourceTab.getByTestId("tab-close"));
        await expect(viewer).toHaveCount(0);

        const quantifier =
          language === "en" ? "Revenue rose in every quarter." : "每个季度的收入都增长了。";
        const coveragePart: ClaimCheckPart = {
          ...part(0, quantifier.length, "fact"),
          verdict: "unsupported",
          coverage: {
            quantifier: "all",
            complete: true,
            unit: language === "en" ? "quarters" : "季度",
            domainEvidence: [{ ...citation, quote: "Q1, Q2, Q3, Q4: the quarters of 2026." }],
            members: [1, 2, 3, 4].map((quarter) => ({
              label: `Q${quarter}`,
              verdict: quarter === 4 ? "unsupported" : "supported",
              evidence:
                quarter === 4 ? [] : [{ ...citation, quote: `Q${quarter}: ${words.fact.trim()}` }],
            })),
          },
        };
        // One part: its rows say what it covers, with no coverage line above them.
        await setContent(window, [
          paragraph("coverage", quantifier, checked("coverage-check", quantifier, [coveragePart])),
        ]);
        await window.getByTestId("claim-mark").click();
        await allRowsVisible(window, 4);
        await expect(card.getByTestId("claim-parts-coverage")).toHaveCount(0);
        await window.keyboard.press("Escape");

        // Two parts: the coverage line sits above the rows.
        const quarters = quantifier.slice(0, -1);
        const view = language === "en" ? "which we welcome" : "我们对此表示欢迎";
        const twoParts = language === "en" ? `${quarters}, ${view}.` : `${quarters}，${view}。`;
        const viewAt = twoParts.indexOf(view);
        await setContent(window, [
          paragraph(
            "coverage",
            twoParts,
            checked("coverage-check", twoParts, [
              { ...coveragePart, span: { start: 0, end: quarters.length } },
              part(viewAt, viewAt + view.length, "opinion"),
            ]),
          ),
        ]);
        await window.getByTestId("claim-mark").click();
        await expect(card.getByTestId("claim-parts-coverage")).toContainText(
          language === "en" ? "Covers 3 of the 4 quarters" : "覆盖 4 项中的 3 项",
        );
        await allRowsVisible(window, 4);
        await expect(
          card.getByTestId("claim-part").last().getByTestId("claim-part-reason"),
        ).toBeVisible();
        await screenshot(window, `opinions-coverage-${language}-${width}`);
        await window.keyboard.press("Escape");

        if (width === 900) {
          // A card of many rows is no taller than the room it opens into: it scrolls there, and
          // its last row stays reachable.
          const months = Array.from({ length: 12 }, (_, month) => `M${month + 1}`);
          const long: ClaimCheckPart = {
            ...coveragePart,
            coverage: coveragePart.coverage && {
              ...coveragePart.coverage,
              members: months.map((label, month) => ({
                label,
                verdict: month === 11 ? "unsupported" : "supported",
                evidence:
                  month === 11 ? [] : [{ ...citation, quote: `${label}: ${words.fact.trim()}` }],
              })),
            },
          };
          await setContent(window, [
            paragraph("long", quantifier, checked("long-check", quantifier, [long])),
          ]);
          await window.getByTestId("claim-mark").click();
          await pointAndClick(window, card.getByTestId("claim-parts-more"));
          await expect(card.getByTestId("claim-part")).toHaveCount(12);
          const fits = async () => {
            const box = await card.boundingBox();
            const height = await window.evaluate(() => globalThis.innerHeight);
            if (!box) throw new Error("The card has no size.");
            return box.y >= 0 && box.y + box.height <= height;
          };
          expect(await fits()).toBe(true);
          const last = card.getByTestId("claim-part").last();
          await card.hover();
          await expect(async () => {
            await window.mouse.wheel(0, 400);
            await expect(last).toBeInViewport({ ratio: 1, timeout: 500 });
          }).toPass();
          expect(await fits()).toBe(true);
          await window.keyboard.press("Escape");

          // A part citing a case no Document holds keeps the warning, on its row and the sentence.
          const both = `${words.fact.trim()} ${words.fact.trim()}`;
          const first = {
            ...part(0, words.fact.trim().length, "fact", [citation]),
            citedCaseUnchecked: true,
          };
          const second = part(words.fact.trim().length + 1, both.length, "fact", [citation]);
          const cases = {
            ...checked("case-check", both, [first, second]),
            citedCaseUnchecked: true,
          };
          await setContent(window, [paragraph("case", both, cases)]);
          // Opened once the page's check badge shows, as a User sees it, so the card can keep clear of it.
          const badge = window.locator(".mind-foot-badge .check-badge").first();
          await expect(badge).toBeVisible();
          await window.getByTestId("claim-mark").click();
          await expect(card.getByTestId("claim-cited-case-unchecked")).toHaveText(
            translate(language, "claim.citedCaseUnchecked"),
          );
          const rows = card.getByTestId("claim-part");
          await expect(rows.first().getByTestId("claim-part-cited-case-unchecked")).toBeVisible();
          await expect(rows.last().getByTestId("claim-part-cited-case-unchecked")).toHaveCount(0);
          const badgeBox = await badge.boundingBox();
          const box = await card.boundingBox();
          if (!badgeBox || !box) throw new Error("The card or the badge has no size.");
          expect(
            box.y + box.height <= badgeBox.y ||
              box.x + box.width <= badgeBox.x ||
              box.x >= badgeBox.x + badgeBox.width ||
              box.y >= badgeBox.y + badgeBox.height,
          ).toBe(true);
          await window.keyboard.press("Escape");
        }

        const unknownCoverage: ClaimCheckPart = {
          ...coveragePart,
          unsupported: {
            reason:
              language === "en"
                ? "The Documents do not establish the complete set of quarters."
                : "文档未说明完整的季度范围。",
            covered: null,
            uncovered: null,
          },
          coverage: coveragePart.coverage && { ...coveragePart.coverage, complete: false },
        };
        await setContent(window, [
          paragraph(
            "unknown-domain",
            quantifier,
            checked("unknown-domain-check", quantifier, [unknownCoverage]),
          ),
        ]);
        await window.getByTestId("claim-mark").click();
        await expect(card.getByTestId("claim-parts-coverage")).toHaveCount(0);
        await expect(card.getByTestId("claim-part").first()).toContainText(quantifier);
        await expect(
          card.getByTestId("claim-part").first().getByTestId("claim-part-reason"),
        ).toContainText(unknownCoverage.unsupported?.reason ?? "");
        await screenshot(window, `opinions-unknown-domain-${language}-${width}`);
        await window.keyboard.press("Escape");

        const forecast = {
          ...part(0, words.forecast.length, "fact", [{ ...citation, quote: words.quote }]),
          verdict: "unsupported" as const,
          unsupported: {
            kind: "forecast-certainty" as const,
            reason: "forecast",
            covered: null,
            uncovered: null,
            quoted: { ...citation, quote: words.quote },
          },
        };
        await setContent(window, [
          paragraph(
            "forecast",
            words.forecast,
            checked("forecast-check", words.forecast, [forecast]),
          ),
        ]);
        await window.getByTestId("claim-mark").click();
        await expect(card.getByTestId("claim-part-reason")).toHaveText(
          language === "en"
            ? "The Document forecasts this but doesn’t say it will happen"
            : "文档只是作出预测，没有说这一定会发生",
        );
        await screenshot(window, `opinions-forecast-${language}-${width}`);
        await card.getByRole("button", { name: words.wording, exact: true }).click();
        await expect(window.getByTestId("mind-editor")).toContainText(words.quote);
        await expect(window.getByTestId("claim-mark")).toHaveAttribute(
          "data-check",
          "needs-recheck",
        );
        await window.keyboard.press("ControlOrMeta+z");
        await expect(window.getByTestId("mind-editor")).toContainText(words.forecast);

        const verifySettings = new Y.Doc();
        const attributedParts = [
          part(0, words.attributedView.length, "fact", [{ ...citation, quote: words.attributed }]),
          part(
            words.attributed.indexOf(words.attributedFact),
            words.attributed.indexOf(words.attributedFact) + words.attributedFact.length,
            "fact",
            [{ ...citation, quote: words.attributed }],
          ),
        ];
        writeOpinionSentences(verifySettings, [
          {
            id: "pure-verify",
            blockId: "pure-verify",
            text: words.verifyOpinion,
            occurrence: 0,
            parts: [part(0, words.verifyOpinion.length, "opinion")],
          },
        ]);
        writeVerification(verifySettings.getMap("settings"), {
          documentId: verified.id,
          documentName: verified.name,
          pages: { attributed: 1, "pure-verify": 1 },
          claims: [{ blockId: "attributed", text: words.attributed }],
        });
        await setContent(window, [
          paragraph(
            "attributed",
            words.attributed,
            checked("attributed-check", words.attributed, attributedParts),
          ),
          paragraph("pure-verify", words.verifyOpinion),
        ]);
        await applySettings(window, Array.from(Y.encodeStateAsUpdate(verifySettings)));
        await window.getByTestId("claim-mark").click();
        await allRowsVisible(window, 2);
        await expect(card.getByTestId("claim-part-check-anyway")).toHaveCount(0);
        expect((await partsOfCheck(window, "attributed-check"))?.map((part) => part.kind)).toEqual([
          "fact",
          "fact",
        ]);
        await screenshot(window, `opinions-verify-attributed-${language}-${width}`);
        await window.keyboard.press("Escape");
        const verify = await checkCard(window);
        await expect(verify.getByTestId("verify-done")).toBeVisible();
        await expect(verify.getByTestId("opinions-line")).toContainText(
          language === "en" ? "1 opinion left out" : "1 处观点未纳入核对",
        );
        await pointAndClick(window, verify.getByTestId("opinions-show"));
        expect(await selectedWords(window)).toBe(words.verifyOpinion);
        await expect(card).toHaveAttribute("data-check", "opinion");
        await screenshot(window, `opinions-verify-${language}-${width}`);
        await window.keyboard.press("Escape");
        if (width === 900) {
          await setContent(window, [paragraph("pure-verify", words.verifyOpinion)]);
          writeVerification(verifySettings.getMap("settings"), {
            documentId: verified.id,
            documentName: verified.name,
            pages: { "pure-verify": 1 },
            claims: [],
          });
          await applySettings(window, Array.from(Y.encodeStateAsUpdate(verifySettings)));
          const pureVerify = await checkCard(window);
          await expect(pureVerify.getByTestId("verify-done")).toBeVisible();
          await expect(pureVerify.getByTestId("verify-done")).toContainText(
            language === "en" ? "No claims found" : "没有找到说法",
          );
          await expect(pureVerify.getByTestId("verify-again")).toHaveCount(0);
          await expect(window.getByTestId("claim-mark")).toHaveCount(0);
          await expect(pureVerify.getByTestId("opinions-line")).toContainText(
            language === "en" ? "1 opinion left out" : "1 处观点未纳入核对",
          );
          await screenshot(window, `opinions-pure-verify-${language}-${width}`);
          await window.keyboard.press("Escape");
        }
      }

      await setWindowSize(app, window, 900, 900);
      const changedFolder = join(sources, "Changes");
      const changedFile = join(changedFolder, "Moved source.docx");
      const changedQuote = words.fact.trim();
      const oldText = wordParagraph("A separate statement.") + wordParagraph(changedQuote);
      await mkdir(changedFolder);
      await writeFile(changedFile, wordFile({ body: oldText }));
      await linkFolderFromSidebar(app, window, changedFolder);
      await expectReadyDocuments(window, 3);
      const changedDocument = (
        await window.evaluate(() =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
        )
      ).find((each) => each.name === "Moved source");
      if (!changedDocument) throw new Error("The changed Source was not added.");
      const original = await window.evaluate(
        ({ documentId, quote, contentHash }) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.recheckCitation({
            documentId,
            quote,
            contentHash,
            pageFrom: 1,
            pageTo: 1,
            mindId: null,
          }),
        {
          documentId: changedDocument.id,
          quote: changedQuote,
          contentHash: changedDocument.contentHash,
        },
      );
      if ("keptInside" in original) throw new Error("The changed Source is behind no wall.");
      expect(original).toMatchObject({
        check: "found",
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "section", paragraphs: { from: 2, to: 2 } },
      });
      const oldCitation: CitationAttributes = {
        ...citation,
        passageId: original.passageId,
        documentId: changedDocument.id,
        documentName: changedDocument.name,
        contentHash: changedDocument.contentHash,
        pageFrom: original.pageFrom,
        pageTo: original.pageTo,
        location: original.location ?? null,
        quote: changedQuote,
      };
      const changedBlock = (multiple: boolean): JSONContent => {
        const text = multiple ? words.fact + words.opinion : changedQuote;
        const parts = [part(0, multiple ? words.fact.length : text.length, "fact", [oldCitation])];
        if (multiple) parts.push(part(words.fact.length, text.length, "opinion"));
        return {
          type: "paragraph",
          attrs: { id: "changed-cited" },
          content: [
            {
              type: "text",
              text,
              marks: [{ type: "claimCheck", attrs: checked("changed-check", text, parts) }],
            },
            { type: "citation", attrs: oldCitation },
          ],
        };
      };
      await newMind(window);
      await setContent(window, [changedBlock(true)]);
      await expect(window.getByTestId("mind-editor").getByTestId("citation-chip")).toHaveCount(1);
      await writeFile(
        changedFile,
        wordFile({ body: wordParagraph("Another statement.") + oldText }),
      );
      const changedAt = new Date("2026-10-21T12:00:00Z");
      await utimes(changedFile, changedAt, changedAt);
      await expect
        .poll(() =>
          window.evaluate(
            async ({ id, oldHash }) => {
              const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              const document = (await bridge.listDocuments()).find((each) => each.id === id);
              if (document?.status !== "ready" || document.contentHash === oldHash) return false;
              return (await bridge.readDocumentText(id)).contentHash === document.contentHash;
            },
            { id: changedDocument.id, oldHash: changedDocument.contentHash },
          ),
        )
        .toBe(true);
      for (const multiple of [false, true]) {
        await setContent(window, [changedBlock(multiple)]);
        await window.getByTestId("claim-mark").click();
        const changedCard = window.getByTestId("claim-card");
        const notice = changedCard.getByTestId("citation-changed-notice");
        await expect(notice).toHaveCount(1);
        await expect(notice).toContainText(
          language === "en"
            ? "The Document changed after this was cited."
            : "此文档在被引用后有改动。",
        );
        await expect(changedCard.getByTestId("claim-part")).toHaveCount(multiple ? 2 : 0);
        await screenshot(
          window,
          `opinions-changed-${multiple ? "parts" : "legacy"}-${language}-900`,
        );
        if (!multiple) {
          await window.keyboard.press("Escape");
          continue;
        }
        const beforeOpen = await window
          .getByTestId("mind-editor")
          .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.getJSON());
        await pointAndClick(window, changedCard.getByTestId("claim-part-citation"));
        const viewer = window.getByTestId("viewer");
        await expect(viewer).toBeVisible();
        const place = () =>
          window.evaluate(
            async (id) =>
              (
                await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLayout(
                  "main",
                )
              ).groups
                .flatMap((group) => group.tabs)
                .find((tab) => tab.item.kind === "document" && tab.item.documentId === id)?.place,
            changedDocument.id,
          );
        // The version the Citation was made from (#2159), at the paragraph it cites.
        const citedLabel = language === "en" ? "¶\u00a02" : "第 2 段";
        await expect(viewer.getByTestId("viewer-as-cited")).toBeVisible();
        await expect(viewer.getByTestId("viewer-cited-place")).toContainText(citedLabel);
        await expect
          .poll(async () =>
            (await viewer.locator("[data-quote-highlight]").allTextContents()).join(""),
          )
          .toBe(changedQuote);
        await expect(viewer.locator("[data-quote-highlight]").first()).toBeInViewport();
        await expect.poll(place).toMatchObject({
          pageFrom: 1,
          pageTo: 1,
          quote: changedQuote,
          citation: {
            contentHash: oldCitation.contentHash,
            pageFrom: 1,
            pageTo: 1,
            location: { kind: "section", paragraphs: { from: 2, to: 2 } },
            label: citedLabel,
          },
        });
        await screenshot(window, `opinions-cited-source-${language}-900`);

        // One action to the current version, at the paragraph the quote moved to.
        const movedLabel = language === "en" ? "¶\u00a03" : "第 3 段";
        await pointAndClick(window, viewer.getByTestId("viewer-open-current"));
        await expect(viewer.getByTestId("viewer-as-cited")).toHaveCount(0);
        const movedParagraph = viewer.locator("section.docx > article p").nth(2);
        await expect(movedParagraph).toHaveText(changedQuote);
        await expect(movedParagraph.locator("[data-quote-highlight]")).toHaveCount(1);
        await expect.poll(place).toMatchObject({
          pageFrom: 1,
          pageTo: 1,
          quote: changedQuote,
          citation: {
            pageFrom: 1,
            pageTo: 1,
            location: { kind: "section", paragraphs: { from: 3, to: 3 } },
            label: movedLabel,
          },
        });
        await screenshot(window, `opinions-current-source-${language}-900`);
        const sourceTab = window.getByTestId("document-tab").first();
        await sourceTab.hover();
        await pointAndClick(window, sourceTab.getByTestId("tab-close"));
        await expect(viewer).toHaveCount(0);
        await expect(window.getByTestId("mind-editor")).toBeVisible();
        expect(
          await window
            .getByTestId("mind-editor")
            .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.getJSON()),
        ).toEqual(beforeOpen);
      }
    } finally {
      await app.close();
      await removeDataFolder(data);
      await removeDataFolder(sources);
    }
  });
}

test("opinion Show opens one card and a real selection still opens the ordinary menu", async () => {
  const data = await createDataFolder();
  const { app, window } = await launchApp(data, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await newMind(window);
    await setWindowSize(app, window, 900, 900);
    const opinion = WORDS.en.pure;
    const ordinary = "Ordinary text remains editable.";
    await setContent(window, [paragraph("pure", opinion), paragraph("ordinary", ordinary)]);
    const settings = new Y.Doc();
    writeOpinionSentences(settings, [
      {
        id: "pure-check",
        blockId: "pure",
        text: opinion,
        occurrence: 0,
        parts: [part(0, opinion.length, "opinion")],
      },
    ]);
    writeMindCheck(settings.getMap("settings"), {
      at: "2026-10-28T20:00:00.000Z",
      sentences: 0,
      stop: null,
      skipped: [],
      unexamined: [],
    });
    await applySettings(window, Array.from(Y.encodeStateAsUpdate(settings)));
    const health = await checkCard(window);
    await pointAndClick(window, health.getByTestId("opinions-show").first());
    await expect(window.getByTestId("claim-card")).toHaveAttribute("data-check", "opinion");
    expect(await selectedWords(window)).toBe(opinion);
    await expect(window.getByTestId("selection-menu")).toBeHidden();
    await screenshot(window, "opinions-single-overlay-en-900");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("mind-editor")).toBeFocused();
    await slideSelect(
      window,
      window.getByTestId("mind-editor").locator("p").nth(1),
      "Ordinary text",
    );
    await expect(window.getByTestId("selection-menu")).toBeVisible();
    expect(await selectedWords(window)).toBe("Ordinary text");
    await screenshot(window, "opinions-ordinary-selection-en-900");
  } finally {
    await app.close();
    await removeDataFolder(data);
  }
});
