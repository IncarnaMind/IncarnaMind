import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  decisionServer,
  dismissChatSetup,
  forceQuit,
  frontMind,
  launchApp,
  newMind,
  organizeWithChatModel,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * How an Organize run meets the Review (#1569): Stop during a plan keeps nothing; a run that ends
 * while the User writes leaves the Note in front and counts what waits in the sidebar; and a model
 * that can only choose among the Folders there are proposes into the same Review, which a
 * force-quit keeps, a deleted Document leaves, and Confirm from ⌘K files as the User's own.
 */

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

async function write(name: string, text: string): Promise<string> {
  const path = join(sources, name);
  await writeFile(path, text);
  return path;
}

/** Five kitchen quotes, the last of which makes each plan request take 1.5 s, and four race plans. */
async function slowFiles(): Promise<string[]> {
  const paths: string[] = [];
  for (let at = 1; at <= 4; at++) {
    paths.push(await write(`Kitchen ${at}.txt`, `Kitchen renovation, item ${at}: quartz tops.`));
    paths.push(await write(`Race ${at}.txt`, `Marathon training, week ${at}: a long run.`));
  }
  paths.push(await write("Kitchen 5.txt", "Kitchen renovation, item 5: delivered slowly."));
  return paths;
}

async function startWithChatModel(): Promise<{ app: ElectronApplication; window: Page }> {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
  await useLocalChatModel(window);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await organizeWithChatModel(window);
  return { app, window };
}

const core = (window: Page) => ({
  folders: async () =>
    (await coreOf(window)).evaluate(async (bridge) =>
      (await bridge.getLibrary()).groups.map((group) => group.name).sort(),
    ),
  /** "Invoice 02 → Finance (user)" for each Document in a Folder. */
  filed: async () =>
    (await coreOf(window)).evaluate(async (bridge) => {
      const [library, documents] = await Promise.all([bridge.getLibrary(), bridge.listDocuments()]);
      const names = new Map(documents.map((each) => [each.id, each.name]));
      const folders = new Map(library.groups.map((each) => [each.id, each.name]));
      return library.assignments
        .filter((each) => each.groupId !== null)
        .map(
          (each) =>
            `${names.get(each.documentId)} → ${folders.get(each.groupId ?? "")} (${each.source})`,
        )
        .sort();
    }),
  waiting: async () =>
    (await coreOf(window)).evaluate(async (bridge) => (await bridge.getOrganizeReview()).count),
});

const card = (window: Page, name: string) =>
  window.getByTestId("organize-review-card").filter({
    has: window.getByTestId("organize-review-card-name").filter({
      hasText: new RegExp(`(^|› )${name}$`),
    }),
  });

test("Stop during a slow plan keeps nothing and says so, and Organize again proposes", async () => {
  test.setTimeout(120_000);
  const { app, window } = await startWithChatModel();
  try {
    await addDocuments(window, await slowFiles());
    await runCommand(window, "library.open", "Open the Library");
    const organize = window.getByTestId("library-sort-into-folders");
    await pointAndClick(window, organize);

    const running = window.getByTestId("organize-running");
    await expect(running).toContainText("Organizing 0 of 9…", { timeout: 30_000 });
    await expect(organize).toBeDisabled();
    await pointAndClick(window, running.getByTestId("organize-stop"));
    await expect(window.getByTestId("organize-stopped")).toHaveText(
      /^Stopped after reading \d+\. Nothing has moved\.$/,
    );
    await expect(running).toHaveCount(0);
    await expect(window.getByTestId("organize-review")).toHaveCount(0);
    expect(await core(window).waiting()).toBe(0);
    expect(await core(window).folders()).toEqual([]);
    expect(await core(window).filed()).toEqual([]);

    // Pressed again, it runs to the end, and the Review fills the page.
    await expect(organize).toBeEnabled();
    await pointAndClick(window, organize);
    await expect(window.getByTestId("organize-stopped")).toHaveCount(0);
    await expect(window.getByTestId("organize-review")).toBeVisible({ timeout: 30_000 });
    await expect(card(window, "Kitchen").getByTestId("organize-review-row")).toHaveCount(5);
    await expect(card(window, "Race").getByTestId("organize-review-row")).toHaveCount(4);
    expect(await core(window).folders()).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a plan that ends while the User writes leaves the Note in front and counts what waits in the sidebar", async () => {
  test.setTimeout(120_000);
  const { app, window } = await startWithChatModel();
  try {
    await addDocuments(window, await slowFiles());
    await runCommand(window, "library.open", "Open the Library");
    await pointAndClick(window, window.getByTestId("library-sort-into-folders"));
    await expect(window.getByTestId("organize-running")).toBeVisible({ timeout: 30_000 });

    await newMind(window, { title: true });
    await window.keyboard.type("Site visit");
    await expect(window.getByTestId("library")).toBeHidden();
    const count = window.getByTestId("library-row-count");
    await expect(count).toHaveAttribute("data-waiting", "true", { timeout: 30_000 });
    await expect(count).toContainText("9 Documents to confirm");
    expect(await core(window).waiting()).toBe(9);
    // The Note kept the keys: what is typed after the run ended lands in it.
    await window.keyboard.type(" notes");
    await expect(frontMind(window).locator(".mind-editor > :first-child")).toHaveText(
      "Site visit notes",
    );
    await expect(window.getByTestId("organize-review")).toHaveCount(0);

    await pointAndClick(window, window.getByTestId("open-library"));
    const waiting = window.getByTestId("organize-waiting");
    await expect(waiting).toContainText("9 Documents to confirm");
    await pointAndClick(window, waiting.getByTestId("organize-waiting-review"));
    await expect(window.getByTestId("organize-review")).toBeVisible();
    await expect(card(window, "Kitchen").getByTestId("organize-review-row")).toHaveCount(5);
  } finally {
    await app.close();
  }
});

/**
 * Three invoices and a chapter, with Finance, Thesis and Archive, Organized from Not in a Folder
 * by a local model that can only choose among those Folders: invoices to Finance, else Thesis.
 */
async function organizeWithDecisions(window: Page, port: number): Promise<void> {
  const paths: string[] = [];
  for (let at = 1; at <= 3; at++)
    paths.push(await write(`Invoice 0${at}.txt`, `Invoice 2026-${at} for consulting.`));
  paths.push(await write("Chapter 1.txt", "Chapter 1 of the thesis on urban heat islands."));
  await addDocuments(window, paths);
  await (await coreOf(window)).evaluate(async (bridge, url) => {
    for (const name of ["Finance", "Thesis", "Archive"])
      await bridge.createLibraryGroup({ name, description: `${name} documents` });
    await bridge.saveLibrarySettings({
      classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
      automatic: false,
    });
  }, `http://127.0.0.1:${port}`);
  await pointAndClick(window, window.getByTestId("open-library"));
  await pointAndClick(window, window.getByTestId("library").getByTestId("library-organize"));
}

const deleteDocument = async (window: Page, name: string) =>
  (await coreOf(window)).evaluate(async (bridge, named) => {
    const gone = (await bridge.listDocuments()).find((each) => each.name === named);
    if (!gone) throw new Error(`No Document ${named}.`);
    await bridge.deleteDocument(gone.id);
  }, name);

const decisions = () =>
  decisionServer((text) => (text.includes("invoice") ? "Finance" : "Thesis"), { delayMs: 500 });

test("a model that chooses among the Folders proposes into the Review, which a quit keeps without a deleted Document, and Confirm from ⌘K files them", async () => {
  test.setTimeout(150_000);
  const { server } = await decisions();
  let app: ElectronApplication | undefined;
  try {
    const first = await launchApp(dataDir);
    app = first.app;
    let { window } = first;
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await organizeWithDecisions(window, (server.address() as AddressInfo).port);

    // It sorts one Document at a time, so there is no plan to stop.
    const running = window.getByTestId("organize-running");
    await expect(running).toBeVisible();
    await expect(running.getByTestId("organize-stop")).toHaveCount(0);
    await expect(window.getByTestId("organize-review")).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId("organize-review-yours")).toContainText("Into your Folders");
    await expect(card(window, "Finance").getByTestId("organize-review-row")).toHaveCount(3);
    await expect(card(window, "Thesis").getByTestId("organize-review-row")).toHaveCount(1);
    await expect(window.getByTestId("organize-review-will-move")).toHaveText(
      "4 Documents will move into 2 of your Folders. Nothing has moved yet.",
    );
    expect(await core(window).filed()).toEqual([]);

    await deleteDocument(window, "Invoice 01");
    await forceQuit(app);
    ({ app, window } = await launchApp(dataDir));
    await setWindowSize(app, window, 1440, 900);
    await expect(window.getByTestId("library-row-count")).toHaveAttribute("data-waiting", "true");
    await pointAndClick(window, window.getByTestId("open-library"));
    const waiting = window.getByTestId("organize-waiting");
    await expect(waiting).toContainText("3 Documents to confirm");
    await pointAndClick(window, waiting.getByTestId("organize-waiting-review"));
    const page = window.getByTestId("organize-review");
    await expect(page).toBeVisible();
    await expect(card(window, "Finance").getByTestId("organize-review-row")).toHaveCount(2);
    expect(await core(window).filed()).toEqual([]);

    await runCommand(window, "library.confirmSuggestions", "Confirm Suggested Folders");
    await expect(page).toHaveCount(0);
    await expect(window.getByTestId("undo-line-here").getByTestId("undo-message")).toHaveText(
      "Organized 3 Documents",
    );
    const filed = [
      "Chapter 1 → Thesis (user)",
      "Invoice 02 → Finance (user)",
      "Invoice 03 → Finance (user)",
    ];
    expect(await core(window).filed()).toEqual(filed);
    await expect(waiting).toHaveCount(0);

    await forceQuit(app);
    ({ app, window } = await launchApp(dataDir));
    expect(await core(window).filed()).toEqual(filed);
    expect(await core(window).waiting()).toBe(0);
    const count = window.getByTestId("library-row-count");
    await expect(count).toHaveText("3");
    await expect(count).not.toHaveAttribute("data-waiting");
  } finally {
    server.close();
    await app?.close();
  }
});

test("a Document deleted while the Review is open leaves it and the count at once", async () => {
  test.setTimeout(120_000);
  const { server } = await decisions();
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await organizeWithDecisions(window, (server.address() as AddressInfo).port);
    await expect(window.getByTestId("organize-review")).toBeVisible({ timeout: 30_000 });
    const rows = card(window, "Finance").getByTestId("organize-review-row");
    await expect(rows).toHaveCount(3);

    await deleteDocument(window, "Invoice 01");
    await expect(rows).toHaveCount(2);
    await expect(window.getByTestId("organize-review-will-move")).toHaveText(
      "3 Documents will move into 2 of your Folders. Nothing has moved yet.",
    );
    await pointAndClick(window, window.getByTestId("organize-review-not-now"));
    await expect(window.getByTestId("organize-waiting")).toContainText("3 Documents to confirm");
    await expect(window.getByTestId("library-row-count")).toContainText("3 Documents to confirm");
  } finally {
    server.close();
    await app.close();
  }
});
