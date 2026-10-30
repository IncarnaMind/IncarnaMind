import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor, JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import {
  type CitationAttributes,
  type ClaimCheckAttributes,
  type CoreBridge,
  MIND_CONTENT_FIELD,
} from "../src/core/api";
import { citationAttributesOf } from "../src/shared/citations";
import { readClaimCheck } from "../src/shared/claimChecks";
import { formatClaimFacetPeriod } from "../src/shared/dates";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";
import {
  ATTRIBUTION_PERIODS,
  ATTRIBUTION_SMOKE,
  type AttributionLanguage,
} from "./fixtures/attribution";

async function readCheck(window: Page): Promise<ClaimCheckAttributes | null> {
  const value = await window.getByTestId("mind-editor").evaluate((dom) => {
    const editor = (dom as unknown as { editor: Editor }).editor;
    let check: unknown = null;
    editor.state.doc.descendants((node) => {
      const mark = node.marks.find((mark) => mark.type.name === "claimCheck");
      if (mark) check = mark.attrs;
    });
    return check;
  });
  return readClaimCheck(value);
}

async function savedCheck(window: Page, mindId: string) {
  const state = await window.evaluate(async (id) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const opened = await core.openMind(id);
    await core.closeMind(id);
    return Array.from(opened.state);
  }, mindId);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(state));
    let result: ClaimCheckAttributes | null = null;
    const visit = (element: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
      if (element instanceof Y.XmlText) {
        for (const delta of element.toDelta()) {
          const check = readClaimCheck(delta.attributes?.claimCheck);
          if (check) result = check;
        }
      } else if (element instanceof Y.XmlElement)
        for (const child of element.toArray()) visit(child);
    };
    for (const child of doc.getXmlFragment(MIND_CONTENT_FIELD).toArray()) visit(child);
    return result;
  } finally {
    doc.destroy();
  }
}

async function documentJSON(window: Page): Promise<JSONContent> {
  return window
    .getByTestId("mind-editor")
    .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.getJSON());
}

async function noteText(window: Page): Promise<string> {
  return window
    .getByTestId("mind-editor")
    .evaluate((dom) => (dom as unknown as { editor: Editor }).editor.state.doc.textContent);
}

function citationsIn(node: JSONContent): Partial<CitationAttributes>[] {
  return node.type === "citation" && node.attrs
    ? [citationAttributesOf(node.attrs)]
    : (node.content ?? []).flatMap(citationsIn);
}

function expectCitationsKept(before: JSONContent, after: JSONContent) {
  const originals = citationsIn(before);
  const current = citationsIn(after);
  expect(originals).toHaveLength(1);
  expect(current.length).toBeGreaterThanOrEqual(originals.length);
  expect(current.every((citation) => typeof citation.id === "string" && citation.id !== "")).toBe(
    true,
  );
  expect(new Set(current.map((citation) => citation.id)).size).toBe(current.length);
  for (const original of originals) {
    expect(original.documentId).toEqual(expect.any(String));
    expect(original.contentHash).toEqual(expect.any(String));
    expect(original.quote).toEqual(expect.any(String));
    expect(current.find((citation) => citation.id === original.id)).toEqual(original);
    expect(
      current.every(
        (citation) =>
          citation.documentId === original.documentId &&
          citation.contentHash === original.contentHash &&
          citation.quote === original.quote,
      ),
    ).toBe(true);
  }
}

async function checkedNote(window: Page, language: AttributionLanguage, text: string) {
  await newMind(window);
  await window.keyboard.insertText(text);
  await runCommand(window, "mind.check", translate(language, "mindCheck.command"));
  await pointAndClick(window, window.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  await expect.poll(async () => (await readCheck(window))?.state).not.toBeUndefined();
  await expect.poll(async () => (await readCheck(window))?.state).not.toBe("checking");
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await window.keyboard.press("Escape");
  const mindId = await window.getByTestId("mind-pane").last().getAttribute("data-mind-id");
  if (!mindId) throw new Error("The checked Note is not open.");
  return mindId;
}

async function openClaim(window: Page) {
  await pointAndClick(window, window.getByTestId("claim-mark").first());
  await expect(window.getByTestId("claim-card")).toBeVisible();
}

async function shot(window: Page, name: string) {
  await window.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  await window.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

const facetRow = (window: Page, kind: "source" | "speaker" | "time") =>
  window.locator(`[data-testid="claim-part"][data-facet="${kind}"]`);

async function fixture(language: AttributionLanguage, width: number) {
  const row = ATTRIBUTION_SMOKE[language];
  const data = await createDataFolder();
  const sources = await createDataFolder();
  const files = [
    { folder: "home", name: row.residents, text: row.firstQuote },
    { folder: "group", name: row.residents, text: row.secondQuote },
    {
      folder: "other",
      name: row.wrongName,
      text: language === "en" ? "The archive is open on Monday." : "档案馆星期一开放。",
    },
    { folder: "other", name: row.actualName, text: row.wrongFact },
    { folder: "other", name: row.staleName, text: row.staleQuote },
    { folder: "other", name: row.noPeriodName, text: row.noPeriodQuote },
    { folder: "other", name: row.freshName, text: row.recentQuote },
  ];
  const paths: string[] = [];
  for (const file of files) {
    const folder = join(sources, file.folder);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${file.name}.md`);
    await writeFile(path, `# ${file.name}\n\n${file.text}\n`);
    paths.push(path);
  }
  const transcript = join(sources, `${row.transcriptName}.vtt`);
  await writeFile(
    transcript,
    `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Nora>${language === "en" ? "Welcome to the call." : "欢迎参加通话。"}\n\n00:14:32.000 --> 00:14:35.000\n<v Speaker 2>${row.spoken}\n`,
  );
  paths.push(transcript);
  try {
    const { app, window } = await launchApp(data, { fakeChat: true });
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
    });
    await addDocuments(window, paths);
    const documents = await window.evaluate(
      async ({ name, first, second }) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const documents = await core.listDocuments();
        const twins = documents.filter((document) => document.name === name);
        const home = twins.find((document) => /[/\\]home[/\\]/.test(document.path));
        const group = twins.find((document) => /[/\\]group[/\\]/.test(document.path));
        if (!home || !group) throw new Error("Both real same-title Sources must be imported.");
        const firstFolder = await core.createLibraryGroup({ name: first, description: "" });
        const secondFolder = await core.createLibraryGroup({ name: second, description: "" });
        await core.assignDocumentGroup(home.id, firstFolder.id);
        await core.assignDocumentGroup(group.id, secondFolder.id);
        return { home: home.id, group: group.id };
      },
      { name: row.residents, first: row.firstFolder, second: row.secondFolder },
    );
    return {
      app,
      window,
      row,
      documents,
      async close() {
        await app.close();
        await removeDataFolder(data);
        await removeDataFolder(sources);
      },
    };
  } catch (error) {
    await removeDataFolder(data);
    await removeDataFolder(sources);
    throw error;
  }
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1600]) {
    test(`same-title Source choice shows Folder and period, checks the other fact and Undo (${language}, ${width})`, async () => {
      const setup = await fixture(language, width);
      const { window, row, documents } = setup;
      try {
        const mindId = await checkedNote(window, language, row.source);
        const before = await readCheck(window);
        expect(before?.parts?.find((part) => part.facet)?.verdict).toBe("unsupported");
        await openClaim(window);
        const source = facetRow(window, "source");
        await expect(source).toContainText(row.sourceWords);
        await expect(source.getByTestId("claim-part-reason")).toHaveText(
          translate(language, "claim.source.ambiguous", { n: 2, name: row.residents }),
        );
        await shot(window, "source-before");
        if (width === 1600) {
          await window.keyboard.press("Escape");
          const editor = window.getByTestId("mind-editor");
          await editor.evaluate((dom) => {
            (dom as unknown as { editor: Editor }).editor.commands.focus("start");
          });
          await expect(editor).toBeFocused();
          await runCommand(
            window,
            "check.chooseSource",
            translate(language, "claim.source.choose"),
          );
          await expect(window.getByTestId("claim-source-picker")).toBeVisible();
          await window.keyboard.press("Escape");
          await expect(window.getByTestId("claim-source-picker")).toHaveCount(0);
          await expect(window.getByTestId("claim-card")).toBeVisible();
          await window.keyboard.press("Escape");
          await expect(window.getByTestId("claim-card")).toHaveCount(0);
          await expect(editor).toBeFocused();
          await openClaim(window);
          await source.focus();
          await window.keyboard.press("Shift+F10");
          await pointAndClick(
            window,
            window.getByTestId("check-actions").getByRole("menuitem", {
              name: translate(language, "claim.source.choose"),
              exact: true,
            }),
          );
        } else {
          await pointAndClick(window, source.getByTestId("claim-part-choose-source"));
        }
        const picker = window.getByTestId("claim-source-picker");
        await expect(picker).toContainText(
          translate(language, "claim.source.picker", { name: row.residents }),
        );
        const first = picker.locator(
          `[data-testid="claim-source-option"][data-document-id="${documents.home}"]`,
        );
        const second = picker.locator(
          `[data-testid="claim-source-option"][data-document-id="${documents.group}"]`,
        );
        await expect(first).toContainText(row.firstFolder);
        await expect(first).toContainText(
          formatClaimFacetPeriod(ATTRIBUTION_PERIODS.stale, language),
        );
        await expect(second).toContainText(row.secondFolder);
        await expect(second).toContainText(
          formatClaimFacetPeriod(
            { start: "2024-03-01", end: "2024-03-31", precision: "month" },
            language,
          ),
        );
        expect(
          await picker.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
            );
          }),
        ).toBe(true);
        await shot(window, "source-picker");
        await pointAndClick(window, second);
        await expect(picker).toBeHidden();
        await expect
          .poll(async () => (await readCheck(window))?.parts?.find((part) => !part.facet)?.verdict)
          .toBe("contradicted");
        const chosen = await readCheck(window);
        await expect(
          window.locator('.mind-foot-badge .check-badge-mark[data-part="contradicted"]'),
        ).toBeVisible();
        await shot(window, "source-chosen");
        expect(chosen?.parts?.find((part) => part.facet?.kind === "source")?.facet).toMatchObject({
          selectedDocumentId: documents.group,
        });
        expect(await savedCheck(window, mindId)).toEqual(chosen);
        await expect(window.getByTestId("badge-stop")).toHaveCount(0);
        await pointAndClick(window, window.getByTestId("undo-action").last());
        await expect.poll(() => readCheck(window)).toEqual(before);
        expect(await savedCheck(window, mindId)).toEqual(before);
        await window.keyboard.press("Escape");
        await openClaim(window);
        await pointAndClick(window, source.getByTestId("claim-part-choose-source"));
        await pointAndClick(window, second);
        await expect.poll(async () => (await readCheck(window))?.state).toBe("contradicted");
        await expect(window.getByTestId("badge-stop")).toHaveCount(0);
        const beforeAgain = await readCheck(window);
        await window.keyboard.press("Escape");
        await window.getByTestId("mind-editor").evaluate((dom) => {
          (dom as unknown as { editor: Editor }).editor.commands.focus("start");
        });
        await expect(window.getByTestId("mind-editor")).toBeFocused();
        await runCommand(window, "mind.checkEverySentence", translate(language, "mindCheck.every"));
        await expect.poll(async () => (await readCheck(window))?.request).not.toBe(beforeAgain?.request);
        await expect.poll(async () => (await readCheck(window))?.state).toBe("contradicted");
        expect(
          (await readCheck(window))?.parts?.find((part) => part.facet?.kind === "source")?.facet,
        ).toMatchObject({ selectedDocumentId: documents.group });
      } finally {
        await setup.close();
      }
    });

    test(`Source correction preserves the fact and ordinary Citation with one Undo (${language}, ${width})`, async () => {
      const setup = await fixture(language, width);
      const { window, row } = setup;
      try {
        await checkedNote(window, language, row.wrong);
        await openClaim(window);
        const source = facetRow(window, "source");
        await expect(source).toHaveAttribute("data-verdict", "unsupported");
        const fact = window.locator('[data-testid="claim-part"]:not([data-facet])');
        await expect(fact).toHaveAttribute("data-verdict", "supported");
        await pointAndClick(window, fact.getByTestId("claim-part-add-citation"));
        await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(1);
        await window.keyboard.press("Escape");
        await openClaim(window);
        const before = await documentJSON(window);
        const label = translate(language, "claim.source.changeTo", { document: row.actualName });
        await expect(source.getByTestId("claim-part-change-source")).toHaveText(label);
        if (width === 900) {
          await pointAndClick(window, source.getByTestId("claim-part-change-source"));
        } else {
          await pointAndClick(window, source.getByTestId("check-menu"));
          await expect(
            window.getByTestId("check-actions").getByRole("menuitem", { name: label, exact: true }),
          ).toBeVisible();
          await window.keyboard.press("Escape");
          await source.focus();
          await runCommand(window, "check.correctSource", label);
        }
        await expect.poll(() => noteText(window)).toBe(row.corrected);
        expectCitationsKept(before, await documentJSON(window));
        await pointAndClick(window, window.getByTestId("applied-undo").first());
        await expect.poll(() => documentJSON(window)).toEqual(before);
      } finally {
        await setup.close();
      }
    });

    test(`speaker Open uses the actual cue, and time distinguishes missing from current periods (${language}, ${width})`, async () => {
      const setup = await fixture(language, width);
      const { window, row } = setup;
      try {
        await checkedNote(window, language, row.speaker);
        await openClaim(window);
        const speaker = facetRow(window, "speaker");
        await expect(speaker).toHaveAttribute("data-verdict", "unsupported");
        await expect(speaker).toContainText(row.speakerWords);
        await expect(speaker.getByTestId("claim-part-reason")).toContainText(row.transcriptName);
        await shot(window, "speaker");
        await pointAndClick(window, speaker.getByTestId("claim-part-citation").first());
        const cue = window.getByTestId("transcript-line").filter({ hasText: row.spoken });
        await expect(cue).toHaveAttribute("data-start", "872000");
        await expect(cue.locator("[data-quote-highlight]")).toHaveText(row.spoken);
        await pointAndClick(
          window,
          window
            .getByTestId("document-tab")
            .filter({ hasText: row.transcriptName })
            .getByTestId("tab-close"),
        );
        await checkedNote(window, language, row.noPeriod);
        await openClaim(window);
        await expect(facetRow(window, "time")).toHaveAttribute("data-verdict", "unsupported");
        await expect(facetRow(window, "time").getByTestId("claim-part-reason")).toHaveText(
          translate(language, "claim.time.noPeriod", { document: row.noPeriodName }),
        );
        await expect(facetRow(window, "time").getByTestId("claim-part-change-period")).toHaveCount(
          0,
        );
        await window.keyboard.press("Escape");
        await checkedNote(window, language, row.recent);
        await openClaim(window);
        await expect(facetRow(window, "time")).toHaveAttribute("data-verdict", "supported");
        await expect(facetRow(window, "time")).toContainText(
          translate(language, "claim.time.supported", {
            document: row.freshName,
            period: formatClaimFacetPeriod(ATTRIBUTION_PERIODS.fresh, language),
          }),
        );
      } finally {
        await setup.close();
      }
    });

    test(`stale time correction uses the checked period and keeps its Citation through Undo (${language}, ${width})`, async () => {
      const setup = await fixture(language, width);
      const { window, row } = setup;
      try {
        await checkedNote(window, language, row.stale);
        await openClaim(window);
        const time = facetRow(window, "time");
        await expect(time).toHaveAttribute("data-verdict", "unsupported");
        const period = formatClaimFacetPeriod(ATTRIBUTION_PERIODS.stale, language);
        await expect(time.getByTestId("claim-part-reason")).toHaveText(
          translate(language, "claim.time.stale", { period, document: row.staleName }),
        );
        await shot(window, "time-before");
        await pointAndClick(
          window,
          window
            .locator('[data-testid="claim-part"]:not([data-facet])')
            .getByTestId("claim-part-add-citation"),
        );
        await expect(window.getByTestId("mind-editor").getByTestId("citation")).toHaveCount(1);
        await window.keyboard.press("Escape");
        await openClaim(window);
        const before = await documentJSON(window);
        const label = translate(language, "claim.time.changeTo", { period });
        if (width === 900) {
          await pointAndClick(window, time.getByTestId("claim-part-change-period"));
        } else {
          await time.focus();
          await expect(window.getByTestId("claim-part-change-period")).toHaveText(label);
          await pointAndClick(window, time.getByTestId("check-menu"));
          await pointAndClick(
            window,
            window.getByTestId("check-actions").getByRole("menuitem", { name: label, exact: true }),
          );
        }
        await expect.poll(() => noteText(window)).toBe(row.anchored);
        await shot(window, "time-anchored");
        expectCitationsKept(before, await documentJSON(window));
        await pointAndClick(window, window.getByTestId("applied-undo").first());
        await expect.poll(() => documentJSON(window)).toEqual(before);
      } finally {
        await setup.close();
      }
    });
  }
}
