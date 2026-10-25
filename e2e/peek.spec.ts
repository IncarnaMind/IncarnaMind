import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { FakeScanScript } from "../src/core/documents/scan/fake";
import { type MessageKey, translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  type LaunchOptions,
  launchApp,
  linkFolderFromSidebar,
  nameMind,
  newMind,
  type RunningApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSourceLocations,
  turnOnEmbeddings,
} from "./app";

/*
 * Peek (docs/agents/interaction.md, rules 0 and 3): Space on a Document's row,
 * in the sidebar or the Library, shows a quick look beside the list, without
 * opening the viewer. ↑ and ↓ move it to the next or previous Document, Space or
 * Esc put it away, and Enter opens the Document in the viewer. Its name and
 * facts show at once and its first page follows. Driven by the keyboard, as
 * Finder's Quick Look is.
 */

const FORMATS = join(__dirname, "..", "tests", "fixtures", "formats");
const SCAN = join(__dirname, "..", "tests", "fixtures", "scans", "en-clean.jpg");

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** A kind of Document: its file, its name, what its kind is called, and what shows once its first page is drawn. */
interface Format {
  file: string;
  name: string;
  kind: MessageKey;
  drawn(peek: Locator): Locator;
  /** What a deck or a workbook adds to its facts once its slides or sheets are counted. */
  counted?: RegExp;
}

const FORMAT_LIST: Format[] = [
  {
    file: "Tide tables.pdf",
    name: "Tide tables",
    kind: "library.format.pdf",
    drawn: (peek) => peek.locator('[data-drawn="true"]'),
  },
  {
    file: "Harbour scan.pdf",
    name: "Harbour scan",
    kind: "library.format.pdf",
    drawn: (peek) => peek.locator('[data-drawn="true"]'),
  },
  {
    file: "Coastal Flood Risk Review.docx",
    name: "Coastal Flood Risk Review",
    kind: "library.format.docx",
    drawn: (peek) => peek.getByTestId("viewer-docx").locator("section"),
  },
  {
    file: "Quarterly Research Update.pptx",
    name: "Quarterly Research Update",
    kind: "library.format.pptx",
    drawn: (peek) => peek.getByTestId("viewer-slide-canvas"),
    counted: /\d+ slides?/,
  },
  {
    file: "Regional Revenue.xlsx",
    name: "Regional Revenue",
    kind: "library.format.xlsx",
    drawn: (peek) => peek.getByTestId("viewer-grid"),
    counted: /\d+ sheets?/,
  },
  {
    file: "Orders.csv",
    name: "Orders",
    kind: "library.format.csv",
    drawn: (peek) => peek.getByTestId("viewer-grid"),
  },
  {
    file: "Reading list.md",
    name: "Reading list",
    kind: "library.format.markdown",
    drawn: (peek) => peek.getByTestId("viewer-text"),
  },
  {
    file: "Field notes.txt",
    name: "Field notes",
    kind: "library.format.text",
    drawn: (peek) => peek.getByTestId("viewer-text"),
  },
];

/** Writes a Document of every kind, the scan read by a stand-in for the text recognition model. */
async function writeFormats(): Promise<{ paths: string[]; scans: string }> {
  const script: FakeScanScript = { pages: { "1": { lines: ["Harbour log: spring tides."] } } };
  const scans = join(sources, "scans.json");
  await writeFile(scans, JSON.stringify(script));
  await writeFile(
    join(sources, "Tide tables.pdf"),
    buildPdf([{ lines: ["Tide tables", "High water at noon."] }]),
  );
  await writeFile(join(sources, "Harbour scan.pdf"), buildPdf([{ scan: await readFile(SCAN) }]));
  for (const file of [
    "Coastal Flood Risk Review.docx",
    "Quarterly Research Update.pptx",
    "Regional Revenue.xlsx",
    "Orders.csv",
  ]) {
    await copyFile(join(FORMATS, file), join(sources, file));
  }
  await writeFile(
    join(sources, "Reading list.md"),
    "# Reading list\n\n- Tides and currents\n- Estuaries in autumn\n",
  );
  await writeFile(join(sources, "Field notes.txt"), "Spring tides come twice a month.\n");
  return { paths: FORMAT_LIST.map((each) => join(sources, each.file)), scans };
}

/** Writes text Documents named as given. */
async function writeTexts(names: string[]): Promise<string[]> {
  const paths = names.map((name) => join(sources, `${name}.txt`));
  for (const path of paths) await writeFile(path, "Spring tides come twice a month.\n");
  return paths;
}

/** Where Documents are listed in rows that take Space: how to find a row, its button, and the names in order. */
interface Place {
  name: "sidebar" | "library";
  show(window: Page): Promise<void>;
  row(window: Page, name: string): Locator;
  main(row: Locator): Locator;
  /** What says the row is selected: its tree item in the sidebar, the row itself in the Library. */
  selects(row: Locator): Locator;
  names(window: Page): Promise<string[]>;
}

const sidebar: Place = {
  name: "sidebar",
  async show(window) {
    const more = window.getByTestId("show-more-documents");
    if (await more.count()) await more.click();
  },
  row: (window, name) =>
    window
      .getByTestId("sidebar")
      .getByTestId("document-list-item")
      .filter({ has: window.getByTestId("row-text").getByText(name, { exact: true }) }),
  main: (row) => row.getByTestId("open-document"),
  selects: (row) => row.getByTestId("open-document"),
  names: (window) =>
    window
      .getByTestId("sidebar")
      .getByTestId("document-list-item")
      .getByTestId("row-text")
      .allTextContents(),
};

const library: Place = {
  name: "library",
  show: (window) => window.getByTestId("open-library").click(),
  row: (window, name) =>
    window
      .getByTestId("library")
      .getByTestId("library-document")
      .filter({
        has: window.getByTestId("library-document-name").getByText(name, { exact: true }),
      }),
  main: (row) => row.locator("[data-row-main]"),
  selects: (row) => row,
  names: (window) => window.getByTestId("library-document-name").allTextContents(),
};

const PLACES = [sidebar, library];

const peekOf = (window: Page) => window.getByTestId("peek");

/** Launches the app in a window of a size the peek has room in, past first run. */
async function start(options?: LaunchOptions): Promise<RunningApp> {
  const running = await launchApp(dataDir, options);
  await setWindowSize(running.app, running.window, 1400, 800);
  await dismissChatSetup(running.window);
  return running;
}

/** Adds the files, waits until they are read, and shows them in the place, in the language. */
async function addAndShow(
  window: Page,
  place: Place,
  paths: string[],
  language: "en" | "zh-CN" = "en",
): Promise<void> {
  await window.getByTestId("add-documents-input").setInputFiles(paths);
  await expect
    .poll(async () =>
      (await coreOf(window)).evaluate(
        async (core) =>
          (await core.listDocuments()).filter((each) => each.status === "ready").length,
      ),
    )
    .toBe(paths.length);
  await setLanguage(window, language);
  await place.show(window);
}

/** A Mind in the window, to see that nothing replaces it. */
async function openShortlist(window: Page): Promise<void> {
  await newMind(window);
  await nameMind(window, "Shortlist");
}

const mindTab = (window: Page) => window.getByTestId("tab-title").filter({ hasText: "Shortlist" });

for (const place of PLACES) {
  test(`Space in the ${place.name} peeks at a Document of every kind: its name and facts, then its first page, slide or sheet`, async () => {
    const { paths, scans } = await writeFormats();
    const { app, window } = await start({ scans });
    try {
      await addAndShow(window, place, paths);
      const peek = peekOf(window);
      for (const format of FORMAT_LIST) {
        const main = place.main(place.row(window, format.name));
        await main.focus();
        await window.keyboard.press("Space");
        await expect(peek, format.name).toBeVisible();
        await expect(peek.getByTestId("peek-name")).toHaveText(format.name);
        // Its kind and its size at once; a deck's or a workbook's count once it is read.
        const facts = peek.getByTestId("peek-kind");
        await expect(facts).toContainText(translate("en", format.kind));
        await expect(facts).toContainText(/\d+(\.\d)? (KB|MB)/);
        if (format.counted) await expect(facts).toContainText(format.counted);
        await expect(peek.getByTestId("peek-added")).toContainText(format.file);
        // Then its page, drawn small, with no viewer opened and the focus still on the list.
        await expect(format.drawn(peek).first()).toBeVisible();
        await expect(window.getByTestId("viewer")).toHaveCount(0);
        await expect(main).toBeFocused();
        await window.keyboard.press("Escape");
        await expect(peek).toHaveCount(0);
        await expect(main).toBeFocused();
      }
    } finally {
      await app.close();
    }
  });

  test(`in the ${place.name}, ↓ and ↑ step the peek through the Documents, Space and Esc put it away, Enter opens the viewer, and the Mind stays`, async () => {
    const paths = await writeTexts(["Alpha", "Bravo", "Charlie"]);
    const { app, window } = await start();
    try {
      await openShortlist(window);
      await addAndShow(window, place, paths);
      const names = await place.names(window);
      expect(names).toHaveLength(3);
      const [first, second, third] = names.map((name) => place.row(window, name)) as [
        Locator,
        Locator,
        Locator,
      ];
      const peekName = peekOf(window).getByTestId("peek-name");

      await place.main(first).focus();
      await window.keyboard.press("Space");
      await expect(peekName).toHaveText(names[0] as string);

      // ↓ moves the peek, the focus and the selection to the next row; at the last it stays.
      await window.keyboard.press("ArrowDown");
      await expect(peekName).toHaveText(names[1] as string);
      await expect(place.main(second)).toBeFocused();
      await expect(place.selects(second)).toHaveAttribute("aria-selected", "true");
      await expect(place.selects(first)).toHaveAttribute("aria-selected", "false");
      await window.keyboard.press("ArrowDown");
      await expect(peekName).toHaveText(names[2] as string);
      await window.keyboard.press("ArrowDown");
      await expect(peekName).toHaveText(names[2] as string);
      await expect(place.main(third)).toBeFocused();
      await window.keyboard.press("ArrowUp");
      await expect(peekName).toHaveText(names[1] as string);

      // Space puts it away and brings it back; Esc puts it away and leaves the row focused.
      await window.keyboard.press("Space");
      await expect(peekOf(window)).toHaveCount(0);
      await window.keyboard.press("Space");
      await expect(peekName).toHaveText(names[1] as string);
      await window.keyboard.press("Escape");
      await expect(peekOf(window)).toHaveCount(0);
      await expect(place.main(second)).toBeFocused();
      // With no peek, the arrows move the focus as they always did.
      await window.keyboard.press("ArrowDown");
      await expect(place.main(third)).toBeFocused();
      await expect(peekOf(window)).toHaveCount(0);

      // Enter opens the Document in the viewer, beside the Mind, and puts the peek away.
      await window.keyboard.press("Space");
      await expect(peekName).toHaveText(names[2] as string);
      await window.keyboard.press("Enter");
      await expect(peekOf(window)).toHaveCount(0);
      const viewer = window.getByTestId("viewer");
      await expect(viewer.getByTestId("viewer-title")).toHaveText(names[2] as string);
      await expect(mindTab(window)).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test(`in the ${place.name}, the peek's name and facts are on screen before its page is drawn`, async () => {
    const { paths, scans } = await writeFormats();
    const { app, window } = await start({ scans });
    try {
      await addAndShow(window, place, paths);
      const tideTables = FORMAT_LIST[0] as Format;
      await place.main(place.row(window, tideTables.name)).focus();
      // Watches the page from the key press: when the name and facts first show, and when
      // the page first does, which can't be earlier.
      await window.evaluate(() => {
        const seen: { key?: number; name?: number; drawn?: number; drawnAtName?: boolean } = {};
        (globalThis as unknown as { peekSeen: typeof seen }).peekSeen = seen;
        addEventListener(
          "keydown",
          (event) => {
            if (event.key === " ") seen.key = event.timeStamp;
          },
          { capture: true, once: true },
        );
        const drawn = () =>
          document.querySelector('[data-testid="peek-page"] [data-drawn="true"]') !== null;
        const look = () => {
          const name = document.querySelector('[data-testid="peek-name"]')?.textContent;
          const facts = document.querySelector('[data-testid="peek-kind"]')?.textContent;
          if (name && facts && seen.name === undefined) {
            seen.name = performance.now();
            seen.drawnAtName = drawn();
          }
          if (drawn() && seen.drawn === undefined) {
            seen.drawn = performance.now();
            observer.disconnect();
          }
        };
        const observer = new MutationObserver(look);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await window.keyboard.press("Space");
      await expect(peekOf(window).locator('[data-drawn="true"]').first()).toBeVisible();
      const seen = await window.evaluate(
        () =>
          (
            globalThis as unknown as {
              peekSeen: { key: number; name: number; drawn: number; drawnAtName: boolean };
            }
          ).peekSeen,
      );
      expect(seen.drawnAtName).toBe(false);
      expect(seen.name).toBeLessThan(seen.drawn);
      // What the 100 ms goal is judged by: the key press to the name and facts on screen.
      test.info().annotations.push({
        type: "peek",
        description: `name and facts ${Math.round(seen.name - seen.key)} ms after Space, page ${Math.round(seen.drawn - seen.key)} ms`,
      });
    } finally {
      await app.close();
    }
  });
}

test("a 300-page PDF is peeked at by its first pages alone, not drawn whole", async () => {
  const path = join(sources, "Almanac.pdf");
  await writeFile(
    path,
    buildPdf(Array.from({ length: 300 }, (_, index) => ({ lines: [`Almanac page ${index + 1}`] }))),
  );
  const { app, window } = await start();
  try {
    await addAndShow(window, sidebar, [path]);
    await sidebar.main(sidebar.row(window, "Almanac")).focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);
    await expect(peek.getByTestId("peek-kind")).toContainText("300 pages");
    const drawn = peek.locator('[data-drawn="true"]');
    await expect(drawn.first()).toBeVisible();
    expect(await drawn.count()).toBeLessThan(5);
  } finally {
    await app.close();
  }
});

test("Peek is in the row's menu with Space beside it, and the keys of the peek work from there", async () => {
  const paths = await writeTexts(["Alpha", "Bravo"]);
  const { app, window } = await start();
  try {
    await addAndShow(window, sidebar, paths);
    const names = await sidebar.names(window);
    const row = sidebar.row(window, names[0] as string);
    await sidebar.main(row).focus();
    await window.keyboard.press("Shift+F10");
    const item = row.getByTestId("document.peek");
    await expect(item).toContainText("Peek");
    await expect(item).toContainText("Space");
    await item.click();
    const peekName = peekOf(window).getByTestId("peek-name");
    await expect(peekName).toHaveText(names[0] as string);
    await expect(sidebar.main(row)).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(peekName).toHaveText(names[1] as string);
  } finally {
    await app.close();
  }
});

test("a Document still being read shows its progress in the peek, which goes once it is ready", async () => {
  const path = join(sources, "Scaling laws.txt");
  await writeFile(
    path,
    Array.from(
      { length: 4000 },
      (_, index) => `Line ${index}: test loss falls as a power law in model size and data.`,
    ).join("\n"),
  );
  const { app, window } = await start();
  try {
    await turnOnEmbeddings(window);
    await window.getByTestId("add-documents-input").setInputFiles([path]);
    const row = sidebar.row(window, "Scaling laws");
    await expect(row).toHaveAttribute("data-status", "embedding");
    await sidebar.main(row).focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);
    await expect(peek.getByTestId("peek-name")).toHaveText("Scaling laws");
    await expect(peek.getByTestId("peek-status")).toContainText("Embedding…");
    await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await expect(peek.getByTestId("peek-status")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a file that couldn't be read shows its kind in the peek, and says why", async () => {
  const path = join(sources, "Broken.pdf");
  await writeFile(path, "this is not a PDF at all");
  const { app, window } = await start();
  try {
    await window.getByTestId("add-documents-input").setInputFiles([path]);
    const row = sidebar.row(window, "Broken");
    await expect(row).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
    await sidebar.main(row).focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);
    await expect(peek.getByTestId("peek-page")).toHaveAttribute("data-state", "kind-only");
    await expect(peek.getByTestId("peek-status")).toContainText("Failed");
  } finally {
    await app.close();
  }
});

test("a large file shows its kind in the peek instead of being read whole", async () => {
  const path = join(sources, "Logbook.txt");
  await writeFile(path, `${"Spring tides come twice a month.\n".repeat(100_000)}`);
  const { app, window } = await start();
  try {
    await addAndShow(window, sidebar, [path]);
    await sidebar.main(sidebar.row(window, "Logbook")).focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);
    await expect(peek.getByTestId("peek-name")).toHaveText("Logbook");
    await expect(peek.getByTestId("peek-kind")).toContainText(/MB/);
    await expect(peek.getByTestId("peek-page")).toHaveAttribute("data-state", "kind-only");
    await expect(peek.getByTestId("viewer-text")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("in the sidebar, ↓ passes over the Folders and Minds between two Documents", async () => {
  const paths = await writeTexts(["Alpha", "Bravo"]);
  const { app, window } = await start();
  try {
    await openShortlist(window);
    await addAndShow(window, sidebar, paths);
    // Alpha is in a Folder and Bravo is not: the Folder's row and the Mind's lie between them.
    await (await coreOf(window)).evaluate(async (bridge) => {
      const folder = await bridge.createLibraryGroup({ name: "Ocean", description: "" });
      const alpha = (await bridge.listDocuments()).find((each) => each.name === "Alpha");
      if (alpha) await bridge.moveToFolder({ documentIds: [alpha.id], folderId: folder.id });
    });
    const ocean = window.getByTestId("library-folder").filter({ hasText: "Ocean" });
    await ocean.getByTestId("folder-row").focus();
    await window.keyboard.press("Enter");
    // Alpha is listed in the Folder once the move has reached the sidebar.
    await expect(ocean.getByTestId("document-list-item")).toHaveCount(1);
    const alpha = sidebar.row(window, "Alpha");
    await sidebar.main(alpha).focus();
    await window.keyboard.press("Space");
    const peekName = peekOf(window).getByTestId("peek-name");
    await expect(peekName).toHaveText("Alpha");
    await window.keyboard.press("ArrowDown");
    await expect(peekName).toHaveText("Bravo");
    await expect(sidebar.main(sidebar.row(window, "Bravo"))).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(peekName).toHaveText("Alpha");
  } finally {
    await app.close();
  }
});

test("in the Library, ↓ steps from one Folder's section into the next, and passes over a folded section", async () => {
  const paths = await writeTexts(["Alpha", "Bravo", "Charlie", "Delta"]);
  const { app, window } = await start();
  try {
    await addAndShow(window, library, paths);
    // Alpha and Bravo in one Folder, Charlie in another, Delta in none: three sections.
    await (await coreOf(window)).evaluate(async (bridge) => {
      const reef = await bridge.createLibraryGroup({ name: "Reef", description: "" });
      const tide = await bridge.createLibraryGroup({ name: "Tide", description: "" });
      const named = new Map((await bridge.listDocuments()).map((each) => [each.name, each.id]));
      const move = (name: string, folderId: string) =>
        bridge.moveToFolder({ documentIds: [named.get(name) as string], folderId });
      await move("Alpha", reef.id);
      await move("Bravo", reef.id);
      await move("Charlie", tide.id);
    });
    const sections = window.getByTestId("library").getByTestId("library-section");
    await expect(sections).toHaveCount(3);
    const walk = async (names: string[]) => {
      await library.main(library.row(window, names[0] as string)).focus();
      await window.keyboard.press("Space");
      const peekName = peekOf(window).getByTestId("peek-name");
      for (const name of names) {
        await expect(peekName).toHaveText(name);
        await window.keyboard.press("ArrowDown");
      }
      await expect(peekName).toHaveText(names.at(-1) as string);
      await window.keyboard.press("Escape");
    };
    // The page puts its sections in order as the moves arrive: its rows are read once they stop moving.
    const settledNames = async () => {
      let last = "";
      await expect
        .poll(async () => {
          const now = (await library.names(window)).join("|");
          const still = now === last;
          last = now;
          return still;
        })
        .toBe(true);
      return library.names(window);
    };
    const all = await settledNames();
    expect(all).toHaveLength(4);
    await walk(all);

    // With a section folded its Documents aren't on the page: the peek goes past it.
    await sections.filter({ hasText: "Tide" }).getByTestId("library-section-toggle").click();
    await expect(window.getByTestId("library-document-name")).toHaveCount(3);
    const open = await settledNames();
    expect(open).not.toContain("Charlie");
    await walk(open);
  } finally {
    await app.close();
  }
});

test("the Folder and the Tags of a peeked Document change in the peek, by keyboard, and Undo puts the Folder back", async () => {
  const [path] = await writeTexts(["Tides"]);
  const { app, window } = await start();
  try {
    await addAndShow(window, sidebar, [path as string]);
    await (await coreOf(window)).evaluate((bridge) =>
      bridge.createLibraryGroup({ name: "Ocean", description: "" }),
    );
    const main = sidebar.main(sidebar.row(window, "Tides"));
    await main.focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);
    const folder = peek.getByTestId("peek-folder");
    await expect(folder).toHaveText("Not in a Folder");

    // Tab leads from the row into the peek, where its Folder is the first stop: Move to…
    await window.keyboard.press("Tab");
    await expect(folder.getByRole("button")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("move-to-picker")).toBeVisible();
    await window.keyboard.type("Oce");
    await window.keyboard.press("Enter");
    await expect(folder).toHaveText("Ocean");
    await expect(peek).toBeVisible();
    await expect(window.getByTestId("undo-line")).toContainText("Ocean");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(folder).toHaveText("Not in a Folder");

    // + Add tags names a Tag in the picker, and it shows among the peek's Tags.
    const tags = peek.getByTestId("peek-tags");
    await tags.getByTestId("document-tags-menu").click();
    await expect(peek.getByTestId("tag-picker-input")).toBeFocused();
    // The same picker as everywhere: 360px wide.
    await expect
      .poll(async () => (await peek.getByTestId("document-tags-popover").boundingBox())?.width)
      .toBe(360);
    await window.keyboard.type("Seawater");
    await window.keyboard.press("Enter");
    await window.keyboard.press("Escape");
    await expect(peek).toBeVisible();
    await expect(tags.getByTestId("tag-chip")).toHaveText("Seawater");

    // Esc with the focus in the peek puts it away and gives the row the focus back.
    await window.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await expect(main).toBeFocused();
  } finally {
    await app.close();
  }
});

test("Open ↵ in the peek opens the Document beside the Mind, and Ask about this scopes the next Question to it", async () => {
  const [path] = await writeTexts(["Tides"]);
  const { app, window } = await start();
  try {
    await openShortlist(window);
    await addAndShow(window, sidebar, [path as string]);
    const main = sidebar.main(sidebar.row(window, "Tides"));
    await main.focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);

    await peek.getByTestId("peek-open").click();
    await expect(peek).toHaveCount(0);
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await expect(mindTab(window)).toBeVisible();

    await main.focus();
    await window.keyboard.press("Space");
    await peek.getByTestId("peek-ask").click();
    await expect(peek).toHaveCount(0);
    const chips = window.getByTestId("composer").getByTestId("scope-chip");
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText("Tides");
  } finally {
    await app.close();
  }
});

test("a Document whose file is gone says Missing in its peek, and a press elsewhere puts the peek away", async () => {
  const folder = join(sources, "Library");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Kept.txt"), "Spring tides come twice a month.\n");
  await writeFile(join(folder, "Deleted later.txt"), "Neap tides come between them.\n");
  const { app, window } = await start();
  try {
    await openShortlist(window);
    await linkFolderFromSidebar(app, window, folder);
    await showSourceLocations(window);
    const doomed = window
      .getByTestId("not-in-a-folder")
      .getByTestId("document-list-item")
      .filter({ hasText: "Deleted later" });
    await expect(doomed).toHaveAttribute("data-status", "ready");
    await rm(join(folder, "Deleted later.txt"));
    await expect(doomed).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });

    await doomed.getByTestId("open-document").focus();
    await window.keyboard.press("Space");
    const peek = peekOf(window);
    await expect(peek.getByTestId("peek-name")).toHaveText("Deleted later");
    await expect(peek.getByTestId("peek-page")).toHaveAttribute("data-state", "unreadable");
    const state = peek.getByTestId("peek-file-state");
    await expect(state).toHaveText("Missing");
    await expect(state).toHaveAttribute("title", /File missing/);

    await window.getByTestId("mind-editor").click();
    await expect(peek).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("the peek speaks Chinese: its words and a Chinese name, and Space twice leaves nothing open", async () => {
  const path = join(sources, "潮汐表.txt");
  await writeFile(path, "大潮每月出现两次。\n");
  const { app, window } = await start();
  try {
    await addAndShow(window, sidebar, [path], "zh-CN");
    for (const place of PLACES) {
      await place.show(window);
      const main = place.main(place.row(window, "潮汐表"));
      await main.focus();
      await window.keyboard.press("Space");
      const peek = peekOf(window);
      await expect(peek.getByTestId("peek-name")).toHaveText("潮汐表");
      await expect(peek).toHaveAttribute("aria-label", "预览：潮汐表");
      await expect(peek.getByTestId("peek-facts")).toContainText(translate("zh-CN", "peek.kind"));
      await expect(peek.getByTestId("peek-folder")).toHaveText(
        translate("zh-CN", "library.unsorted"),
      );
      await expect(peek.getByTestId("peek-open")).toContainText(translate("zh-CN", "mind.open"));
      await expect(peek.getByTestId("peek-ask")).toHaveText(translate("zh-CN", "peek.ask"));
      await expect(peek.getByTestId("viewer-text")).toContainText("大潮");
      await window.keyboard.press("Space");
      await expect(peek).toHaveCount(0);
      await window.keyboard.press("Space");
      await expect(peek).toBeVisible();
      await window.keyboard.press("Space");
      await expect(peek).toHaveCount(0);
    }
  } finally {
    await app.close();
  }
});
