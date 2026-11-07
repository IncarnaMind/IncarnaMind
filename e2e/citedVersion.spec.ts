import { mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CitationLocation, CoreBridge } from "../src/core/api";
import { quoteBoxes } from "../src/shared/citedPage";
import { formatDate } from "../src/shared/dates";
import { docxOf, xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import { para, pptxOf, sp, txBody, xfrm } from "../tests/helpers/pptx";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  linkFolderFromSidebar,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  runFromPalette,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A Citation opens the version it was made from (#2159): after its Document
 * changed, its Open shows the cited Units as they were, marked "As cited,
 * {date}", the quote washed, with one action to the current version at the
 * same place — for a PDF's page, a slide, a sheet's rows, a Word section, a
 * Markdown section, a text's lines, and a saved web page fetched again.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

/** When the first version of each file was made, and the second: fixed, so the bar's dates assert literally. */
const MADE_A = new Date("2026-10-20T09:00:00Z");
const MADE_B = new Date("2026-10-21T09:00:00Z");
const AS_CITED_A = "As cited, 20 Oct 2026";
const AS_CITED_A_ZH = "引用时，2026年10月20日";

const OLD = {
  pdf: "The harbourmaster allows sixty dredging days each season.",
  slide: "Churn among subscriptions fell to 4.2 per cent after the redesign.",
  sheet: "The arrears are payable within thirty ledger days.",
  docx: "The indemnity covers escrowed funds for ninety days.",
  md: "Royalties accrue quarterly to the author.",
  txt: "The escrow release needs two approvals from trustees.",
  web: "Tidepool counts rose at the estuary after the restoration.",
};
const NEW = {
  pdf: "The harbourmaster allows forty dredging days each season.",
  slide: "Churn among subscriptions rose to 5.1 per cent after the redesign.",
  sheet: "The arrears are payable within sixty ledger days.",
  docx: "The indemnity covers escrowed funds for sixty days.",
  md: "Royalties accrue monthly to the author.",
  txt: "The escrow release needs three approvals from trustees.",
  web: "Tidepool counts fell at the estuary after the turbines.",
};
/** What the new version says that the cited one doesn't: a view showing it isn't the cited version. */
const CHANGED = {
  pdf: "forty dredging days",
  slide: "rose to 5.1 per cent",
  sheet: "within sixty ledger days",
  docx: "for sixty days",
  md: "accrue monthly",
  txt: "three approvals",
  web: "fell at the estuary",
};

const QUESTION = {
  pdf: "How many dredging days does the harbourmaster permit?",
  slide: "What happened to subscriptions churn after the redesign?",
  sheet: "Within what period are the arrears payable?",
  docx: "Which funds does the indemnity protect?",
  md: "How often do royalties accrue?",
  txt: "How many approvals does the escrow release need?",
  web: "How did tidepool counts change at the estuary?",
};

/** Where each cited version is, as the view names it. */
const PLACE = {
  pdf: "p. 2",
  slide: "slide 2",
  sheet: "Ledger, row 2",
  docx: "§ Settlement",
  md: "§ Royalties",
  txt: "line 3",
  web: "§ Tidepools",
};

/** Each Document's name, by the kind of Location it is cited at. */
const NAME = {
  pdf: "Harbour survey",
  slide: "Quarterly review",
  sheet: "Ledger",
  docx: "Settlement",
  md: "Royalties",
  txt: "Escrow memo",
  web: "Tidelands",
};

/** The current version's view for a kind, and the text it draws. */
const CURRENT_VIEW = {
  pdf: "pdf-page-number",
  slide: "viewer-slides",
  sheet: "viewer-grid",
  docx: "viewer-docx",
  md: "viewer-text",
  txt: "viewer-text",
  web: "viewer-web-article",
} as const;

const pdf = (clause: string) =>
  buildPdf([
    { lines: ["Harbour survey", "The survey covers the eastern approach."] },
    { lines: ["Dredging terms", clause] },
  ]);

const box = xfrm(457200, 457200, 8229600, 3657600);
const deck = (clause: string) =>
  pptxOf({
    slides: [
      {
        shapes: sp({
          id: 2,
          name: "Body",
          txBox: true,
          spPr: box,
          body: txBody(para("Quarterly review")),
        }),
      },
      { shapes: sp({ id: 2, name: "Body", txBox: true, spPr: box, body: txBody(para(clause)) }) },
    ],
  });

const ledger = (clause: string) =>
  xlsxOf([
    {
      name: "Ledger",
      rows: [
        ["Item", "Term"],
        ["Arrears", clause],
        ["Deposit", "Paid on signature."],
      ],
    },
  ]);

const clause = (text: string) => docxOf([{ text: "Settlement", heading: 1 }, { text }]);

const markdown = (line: string) =>
  ["# Royalties", "", line, "", "# Other", "", "Nothing else.", ""].join("\n");

const memo = (line: string) => ["Memo", "", line, "", "End", ""].join("\n");

const article = (line: string) =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tidelands</title></head><body><article>',
    "<h1>Tidelands</h1>",
    "<p>The estuary restoration programme began in 2019, with the removal of two weirs and the replanting of the salt marsh above the bridge. The county council publishes a survey of the flats each spring, and the survey teams count what they find along fixed transects.</p>",
    "<h2>Tidepools</h2>",
    `<p>${line}</p>`,
    "<p>The survey teams walk the same transects each year, at the same state of the tide, so that one year's figures can be set beside another's without correction. Volunteers from the local naturalists' society join them on the longer stretches.</p>",
    "<p>Water quality is measured at four points above and below the restored reach, and the results are published beside the counts in the annual report.</p>",
    "<h2>Notes</h2>",
    "<p>The survey teams return in the spring. The report for the previous year is kept in the county archive, and a copy is filed with the parish council.</p>",
    "<p>Questions about the programme go to the environment team at the county council, whose address is on the report's cover.</p>",
    "</article></body></html>",
  ].join("");

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
let server: Server;
let site: string;
/** The page the test server serves now: the cited version, then the fetched-again one. */
let served: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  served = article(OLD.web);
  server = createServer((request, response) => {
    if (request.url?.startsWith("/tides")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(served);
    } else {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Any host: a test build fetches a saved page from the stand-in, this server.
  site = "http://tidelands.test";
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** The Documents as the core lists them, through the window's bridge. */
const documents = (window: Page) =>
  window.evaluate(async () =>
    (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()).map(
      (each) => ({
        id: each.id,
        name: each.name,
        contentHash: each.contentHash,
        status: each.status,
      }),
    ),
  );

const contentHashOf = async (window: Page, name: string) =>
  (await documents(window)).find((each) => each.name === name)?.contentHash;

/** Writes a new version of a file, dates it as made that day, and waits until it is indexed. */
async function replace(
  window: Page,
  path: string,
  name: string,
  contents: string | Uint8Array,
  made: Date,
): Promise<void> {
  const before = await contentHashOf(window, name);
  await writeFile(path, contents);
  await utimes(path, made, made);
  await expect.poll(() => contentHashOf(window, name), { timeout: 20_000 }).not.toBe(before);
}

/** A Citation in an Answer, as its node stores it. */
interface CitationAttrs {
  documentId: string | null;
  contentHash: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
  quote: string | null;
  check?: string;
}

/** The Citations of an Answer in the assistant: their Document, the version they quote and their place. */
const citationsOf = (answer: Locator) =>
  answer.getByTestId("assistant-answer-text").evaluate((dom) => {
    const found: CitationAttrs[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name !== "citation") return;
      found.push({
        documentId: typeof node.attrs.documentId === "string" ? node.attrs.documentId : null,
        contentHash: typeof node.attrs.contentHash === "string" ? node.attrs.contentHash : null,
        pageFrom: typeof node.attrs.pageFrom === "number" ? node.attrs.pageFrom : null,
        pageTo: typeof node.attrs.pageTo === "number" ? node.attrs.pageTo : null,
        location: typeof node.attrs.location === "object" ? node.attrs.location : null,
        quote: typeof node.attrs.quote === "string" ? node.attrs.quote : null,
        check: typeof node.attrs.check === "string" ? node.attrs.check : undefined,
      });
    });
    return found;
  });

/** A Citation's place, as its saved page is read through the bridge (#133). */
function placeOf(citation: CitationAttrs) {
  const { documentId, contentHash, pageFrom, pageTo, location } = citation;
  if (!documentId || !contentHash) throw new Error("The Citation has no place.");
  return { documentId, contentHash, pageFrom, pageTo, location };
}

/** The saved page of a Citation's place: its size, and the text drawn on it. */
const savedPageOf = (window: Page, citation: CitationAttrs) =>
  window.evaluate(async (place) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const page = await bridge.readCitedPage(place);
    return page && { width: page.width, height: page.height, text: page.text };
  }, placeOf(citation));

/**
 * Waits until the page of the Citation's place is saved (#133), which it reads on
 * opening the cited version: its picture is drawn in the background after the Answer.
 */
async function expectPageSaved(window: Page, citation: CitationAttrs): Promise<void> {
  await expect
    .poll(() => savedPageOf(window, citation).then((page) => page !== null), {
      timeout: 60_000,
      message: "the cited page is saved",
    })
    .toBe(true);
}

/**
 * The quote's wash covers the line the saved page drew the quote on: the boxes the
 * viewer washes by, from the page's own text, are where the wash shows.
 */
async function expectWashOnQuote(
  window: Page,
  viewer: Locator,
  citation: CitationAttrs,
): Promise<void> {
  const saved = await savedPageOf(window, citation);
  if (!saved) throw new Error("The cited page isn't saved.");
  const [box] = quoteBoxes(
    {
      data: new Uint8Array(),
      type: "image/png",
      width: saved.width,
      height: saved.height,
      text: saved.text,
    },
    citation.quote,
    citation.location,
  ) ?? [null];
  if (!box) throw new Error("The quote isn't on the saved page's text.");
  const picture = viewer.getByTestId("viewer-cited-picture");
  const [pictureRect, washRect] = await Promise.all([
    picture.boundingBox(),
    picture.locator("[data-quote-highlight]").first().boundingBox(),
  ]);
  if (!pictureRect || !washRect) throw new Error("The picture or its wash isn't drawn.");
  const left = pictureRect.x + (box.x / saved.width) * pictureRect.width;
  const top = pictureRect.y + (box.y / saved.height) * pictureRect.height;
  const right = left + (box.width / saved.width) * pictureRect.width;
  const bottom = top + (box.height / saved.height) * pictureRect.height;
  const center = { x: washRect.x + washRect.width / 2, y: washRect.y + washRect.height / 2 };
  expect(center.x).toBeGreaterThanOrEqual(left - 1);
  expect(center.x).toBeLessThanOrEqual(right + 1);
  expect(center.y).toBeGreaterThanOrEqual(top - 1);
  expect(center.y).toBeLessThanOrEqual(bottom + 1);
}

/** Asks in the assistant, and pins the Answer by its id: a later Question makes `.last()` another one. */
async function asked(window: Page, question: string): Promise<Locator> {
  const answer = await askInAssistant(window, question);
  const id = await answer.getAttribute("data-answer-id");
  if (!id) throw new Error("The Answer has no id.");
  return window
    .getByTestId("assistant")
    .locator(`[data-testid="assistant-answer"][data-answer-id="${id}"]`);
}

/** Shows a Citation's card by pointing at it, as a person does; it is put away first if it is already up. */
async function showCard(window: Page, chip: Locator): Promise<Locator> {
  const card = window.getByTestId("citation-card");
  await expect(async () => {
    if ((await card.count()) > 0) {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0, { timeout: 1000 });
    }
    await window.mouse.move(0, 0);
    await pointAt(window, chip);
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  return card;
}

/** Opens a Citation's card and its Open, and gives the viewer of the Document's own tab. */
async function openCitation(
  window: Page,
  answer: Locator,
  kind: keyof typeof NAME,
): Promise<Locator> {
  const card = await showCard(window, answer.getByTestId("citation-chip"));
  await expect(async () => {
    await card.getByTestId("citation-open").click({ timeout: 2000 });
    await expect(card).toHaveCount(0, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  // Its own tab: more than one Document can be open, each in its group.
  return window.getByRole("tabpanel", { name: NAME[kind] }).getByTestId("viewer");
}

/** Closes the Document's tab, so the next Citation opens a page of its own. */
async function closeCitedTab(window: Page, kind: keyof typeof NAME): Promise<void> {
  const tab = window.getByTestId("document-tab").filter({ hasText: NAME[kind] }).first();
  await tab.hover();
  await tab.getByTestId("tab-close").click();
  await expect(window.getByTestId("document-tab").filter({ hasText: NAME[kind] })).toHaveCount(0);
}

/**
 * What a cited version's view shows: its place, the page saved when it was cited with the
 * quote washed where it stood, the cited words, and none of the new version's.
 */
async function expectCited(
  viewer: Locator,
  kind: keyof typeof OLD,
  asCited: string,
): Promise<void> {
  await expect(viewer.getByTestId("viewer-as-cited")).toContainText(asCited);
  await expect(viewer.getByTestId("viewer-cited-place")).toContainText(PLACE[kind]);
  // The picture of the cited place, and the quote washed on it.
  await expect(viewer.getByTestId("viewer-cited-page")).toBeVisible();
  await expect(
    viewer.getByTestId("viewer-cited-picture").locator("[data-quote-highlight]").first(),
  ).toBeVisible();
  // The picture's words, for a reader who can't see it, are the cited version's own.
  const says = viewer.getByTestId("viewer-cited-says");
  await expect(says).toContainText(OLD[kind]);
  await expect(says).not.toContainText(CHANGED[kind]);
  // A picture is kept: the view needn't say that only the text is.
  await expect(viewer.getByTestId("viewer-cited-text-only")).toHaveCount(0);
}

test("a Citation opens the version it was made from, for every kind of Location, and one action to the current one", async () => {
  // Seven kinds, each asked, changed and opened, in two languages and two widths.
  test.setTimeout(300_000);
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  const paths = {
    pdf: join(sources, "Harbour survey.pdf"),
    slide: join(library, "Quarterly review.pptx"),
    sheet: join(library, "Ledger.xlsx"),
    docx: join(library, "Settlement.docx"),
    md: join(library, "Royalties.md"),
    txt: join(library, "Escrow memo.txt"),
  };
  const first: Record<keyof typeof paths, string | Uint8Array> = {
    pdf: pdf(OLD.pdf),
    slide: deck(OLD.slide),
    sheet: ledger(OLD.sheet),
    docx: clause(OLD.docx),
    md: markdown(OLD.md),
    txt: memo(OLD.txt),
  };
  for (const [kind, path] of Object.entries(paths)) {
    await writeFile(path, first[kind as keyof typeof paths]);
    await utimes(path, MADE_A, MADE_A);
  }

  const port = (server.address() as AddressInfo).port;
  const { app, window } = await launchApp(dataDir, { fakeChat: true, web: port });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  try {
    await linkFolderFromSidebar(app, window, library);
    await window.evaluate(async (path) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.addDocuments([path]);
    }, paths.pdf);
    await expectReadyDocuments(window, 6);

    // The saved page joins them, as a Document of its own.
    const saved = await window.evaluate(async (address) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return bridge.saveWebPage({ address });
    }, `${site}/tides`);
    if (saved.outcome !== "saved") {
      throw new Error(`The page wasn't saved: ${JSON.stringify(saved)}`);
    }
    const webId = saved.document.id;
    await expectReadyDocuments(window, 7);

    await newMind(window);
    await pointAndClick(window, window.getByTestId("mind-editor"));
    const answers = {
      pdf: await asked(window, QUESTION.pdf),
      slide: await asked(window, QUESTION.slide),
      sheet: await asked(window, QUESTION.sheet),
      docx: await asked(window, QUESTION.docx),
      md: await asked(window, QUESTION.md),
      txt: await asked(window, QUESTION.txt),
      web: await asked(window, QUESTION.web),
    };
    // Each Answer cites the Document whose words the Question shares, and the version it read.
    const listed = await documents(window);
    for (const [kind, answer] of Object.entries(answers)) {
      const [citation] = await citationsOf(answer);
      const name = listed.find((each) => each.id === citation?.documentId)?.name;
      expect({ kind, name }).toEqual({ kind, name: NAME[kind as keyof typeof NAME] });
      expect(citation?.contentHash).toBeTruthy();
    }
    const cited = Object.fromEntries(
      await Promise.all(
        (Object.keys(answers) as (keyof typeof answers)[]).map(async (kind) => [
          kind,
          (await citationsOf(answers[kind]))[0] ?? null,
        ]),
      ),
    ) as Record<keyof typeof answers, CitationAttrs>;
    const citedHashes = Object.fromEntries(
      (Object.keys(cited) as (keyof typeof cited)[]).map((kind) => [kind, cited[kind].contentHash]),
    );

    // Each cited place is saved as a page: what the cited version shows once its file changes.
    for (const kind of Object.keys(cited) as (keyof typeof cited)[]) {
      await expectPageSaved(window, cited[kind]);
    }

    // Every file changes, and the page is fetched again: the Citations keep the versions they read.
    await replace(window, paths.pdf, "Harbour survey", pdf(NEW.pdf), MADE_B);
    await replace(window, paths.slide, "Quarterly review", deck(NEW.slide), MADE_B);
    await replace(window, paths.sheet, "Ledger", ledger(NEW.sheet), MADE_B);
    await replace(window, paths.docx, "Settlement", clause(NEW.docx), MADE_B);
    await replace(window, paths.md, "Royalties", markdown(NEW.md), MADE_B);
    await replace(window, paths.txt, "Escrow memo", memo(NEW.txt), MADE_B);
    const pageBefore = (await documents(window)).find((each) => each.id === webId)?.contentHash;
    served = article(NEW.web);
    await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.fetchWebPageAgain(id);
    }, webId);
    await expect
      .poll(
        () => documents(window).then((list) => list.find((each) => each.id === webId)?.contentHash),
        {
          timeout: 20_000,
        },
      )
      .not.toBe(pageBefore);

    // Each kind: Open shows the version it was cited from, its place, its quote, and none of the new words.
    const started = new Date();
    const webDates = [formatDate(started, "en"), formatDate(new Date(), "en")];
    for (const kind of ["pdf", "slide", "sheet", "docx", "md", "txt"] as const) {
      const viewer = await openCitation(window, answers[kind], kind);
      await expectCited(viewer, kind, AS_CITED_A);
      await expectWashOnQuote(window, viewer, cited[kind]);
      await screenshot(window, `cited-${kind}-en`);

      // One action to the current version, at the same place: from its bar, or from ⌘K.
      if (kind === "pdf") await runFromPalette(window, "Open the current version");
      else await viewer.getByTestId("viewer-open-current").click();
      await expect(viewer.getByTestId("viewer-as-cited")).toHaveCount(0);
      // The current version says, as it always did, that the Document changed after it was cited.
      await expect(viewer.getByTestId("viewer-citation-changed")).toContainText(
        "The Document changed after this was cited.",
      );
      const current = viewer.getByTestId(CURRENT_VIEW[kind]);
      if (kind === "pdf") await expect(current).toHaveValue("2");
      else await expect(current).toContainText(NEW[kind]);
      // A deck opens at the cited slide.
      if (kind === "slide")
        await expect(viewer.getByTestId("viewer-slide").nth(1)).toBeInViewport();
      await screenshot(window, `cited-${kind}-current-en`);
      await closeCitedTab(window, kind);
    }

    // A saved web page: its snapshot as it was cited, not the one fetched since.
    const web = await openCitation(window, answers.web, "web");
    await expect(web.getByTestId("viewer-as-cited")).toContainText("As cited,");
    await expect(web.getByTestId("viewer-as-cited")).toContainText(new RegExp(webDates.join("|")));
    await expect(web.getByTestId("viewer-cited-place")).toContainText(PLACE.web);
    // Its page keeps how it looked, as the other kinds' do.
    await expect(web.getByTestId("viewer-cited-page")).toBeVisible();
    await expect(
      web.getByTestId("viewer-cited-picture").locator("[data-quote-highlight]").first(),
    ).toBeVisible();
    const webSays = web.getByTestId("viewer-cited-says");
    await expect(webSays).toContainText(OLD.web);
    await expect(webSays).not.toContainText(CHANGED.web);
    await expectWashOnQuote(window, web, cited.web);
    await screenshot(window, "cited-web-en");
    await web.getByTestId("viewer-open-current").click();
    await expect(web.getByTestId("viewer-as-cited")).toHaveCount(0);
    await expect(web.getByTestId("viewer-citation-changed")).toContainText(
      "This page was fetched again on",
    );
    await expect(web.getByTestId("viewer-web-article")).toContainText(CHANGED.web);
    await closeCitedTab(window, "web");

    // In Chinese, the bar, the saved page and its one action read as the rest of the interface does.
    await setLanguage(window, "zh-CN");
    const chinese = await openCitation(window, answers.md, "md");
    await expect(chinese.getByTestId("viewer-as-cited")).toContainText(AS_CITED_A_ZH);
    await expect(chinese.getByTestId("viewer-open-current")).toHaveText("打开当前版本");
    await expect(chinese.getByTestId("viewer-cited-page")).toBeVisible();
    await expect(chinese.getByTestId("viewer-cited-says")).toContainText(OLD.md);
    await screenshot(window, "cited-md-zh");
    await closeCitedTab(window, "md");

    // The saved page too, in Chinese.
    const chineseWeb = await openCitation(window, answers.web, "web");
    await expect(chineseWeb.getByTestId("viewer-as-cited")).toContainText("引用时，");
    await expect(chineseWeb.getByTestId("viewer-cited-page")).toBeVisible();
    await expect(chineseWeb.getByTestId("viewer-cited-says")).toContainText(OLD.web);
    await screenshot(window, "cited-web-zh");
    await closeCitedTab(window, "web");
    await setLanguage(window, "en");

    // A narrow window shows the same; the keyboard reaches its one action.
    await setWindowSize(app, window, 980, 820);
    const narrow = await openCitation(window, answers.docx, "docx");
    await expectCited(narrow, "docx", AS_CITED_A);
    const openCurrent = narrow.getByTestId("viewer-open-current");
    await expect(openCurrent).toBeVisible();
    await screenshot(window, "cited-docx-narrow-en");
    await openCurrent.focus();
    await window.keyboard.press("Enter");
    await expect(narrow.getByTestId("viewer-docx")).toContainText(NEW.docx);
    await expect(narrow.getByTestId("viewer-citation-changed")).toContainText(
      "The Document changed after this was cited.",
    );
    await screenshot(window, "cited-docx-narrow-current-en");
    await closeCitedTab(window, "docx");

    // A Citation whose page was never saved keeps only its text: the view says so, in one line.
    await rm(join(dataDir, "Cited pages"), { recursive: true, force: true });
    await setLanguage(window, "zh-CN");
    const textOnly = await openCitation(window, answers.txt, "txt");
    await expect(textOnly.getByTestId("viewer-as-cited")).toContainText(AS_CITED_A_ZH);
    await expect(textOnly.getByTestId("viewer-cited-text-only")).toContainText(
      "只保留了此版本的文字，没有保留原文件的原貌。",
    );
    await expect(textOnly.getByTestId("viewer-cited-picture")).toHaveCount(0);
    const kept = textOnly
      .getByTestId("viewer-cited")
      .locator(".document-plain")
      .filter({ hasText: OLD.txt });
    await expect(kept).toBeVisible();
    await expect(textOnly.getByTestId("viewer-cited")).not.toContainText(CHANGED.txt);
    await screenshot(window, "cited-txt-text-only-zh");
    await closeCitedTab(window, "txt");
    await setLanguage(window, "en");

    // Every Citation still quotes what it quoted: the views never moved them to the new version.
    for (const kind of Object.keys(answers) as (keyof typeof answers)[]) {
      expect((await citationsOf(answers[kind]))[0]?.contentHash).toBe(citedHashes[kind]);
    }
  } finally {
    await app.close();
  }
});
