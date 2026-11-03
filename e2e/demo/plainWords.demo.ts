/**
 * Films the empty states of #763 in the built app, for the pull request: the sidebar and the
 * Library with nothing in them, the ways in, a Linked folder arriving, and an empty sheet's one
 * way on. Build the test app first (`npx electron-vite build --mode test`), then:
 *
 *   npx playwright test -c e2e/demo/playwright.demo.config.ts plainWords
 *
 * `DEMO_OUT` is where the GIF and the MP4 go. Nothing leaves the computer and no model is asked:
 * the folder and the file pickers are answered by the test, and the file manager opens nothing.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  interceptOpenDialog,
  interceptOpenPath,
  launchApp,
  openDocumentAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "../app";
import { encodeGif, encodeMp4, FILMED, Film, Hand, installOverlay, renderPills } from "./film";

const REPOSITORY = resolve(__dirname, "../..");
const OUT = process.env.DEMO_OUT ?? join(REPOSITORY, "out", "plain-words-demo");
const FIXTURES = join(REPOSITORY, "tests", "fixtures", "formats");
const GIF = { fps: 12, width: 1100, colors: 128 };

test("films the empty states and their ways in", async () => {
  test.setTimeout(300_000);
  const dataDir = await createDataFolder();
  const sources = await createDataFolder();
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  for (const file of ["Regional Revenue.xlsx", "Orders.csv", "Coastal Flood Risk Review.docx"]) {
    await copyFile(join(FIXTURES, file), join(library, file));
  }
  const { app, window } = await launchApp(dataDir);
  let film: Film | undefined;
  let finished = false;
  try {
    await setWindowSize(app, window, FILMED.width, FILMED.height);
    await setLanguage(window, "en");
    await dismissChatSetup(window);
    // The system's two pickers and the file manager, answered by the test.
    await interceptOpenDialog(app, library);
    await interceptOpenPath(app);

    await installOverlay(window);
    const pills = await renderPills(
      [
        "No Documents yet · Add files or a folder… · Link a folder…",
        "Link a folder… says what it takes, before anything is read",
        "Its Documents arrive in the Library",
        "An empty sheet says so, and offers its file’s own app",
      ],
      join(dataDir, "pills"),
    );
    film = await Film.start(window, join(dataDir, "frames"), pills);
    const hand = new Hand(window, film);
    await hand.place(640, 620);
    await hand.begin();

    // The empty sidebar and the empty Library, each with its two ways in.
    hand.caption("No Documents yet · Add files or a folder… · Link a folder…");
    await hand.moveTo(window.getByTestId("documents-empty"));
    await hand.hold(1200);
    await hand.click(window.getByTestId("open-library"));
    const empty = window.getByTestId("library-empty");
    await expect(empty).toBeVisible();
    await hand.moveTo(empty.getByTestId("library-empty-add-files"));
    await hand.hold(800);
    hand.caption("Link a folder… says what it takes, before anything is read");
    await hand.click(empty.getByTestId("library-empty-link-folder"));
    const dialog = window.getByTestId("link-folder-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("link-folder-files")).toBeVisible();
    await hand.hold(1600);
    hand.caption("Its Documents arrive in the Library");
    await hand.click(dialog.getByTestId("link-folder-confirm"));
    await expect(dialog).toBeHidden();
    await expect(window.getByTestId("document-list-item")).toHaveCount(3);
    await hand.hold(1400);

    // An empty sheet, and its one way on: the file's own app, which opens nothing here.
    hand.caption("An empty sheet says so, and offers its file’s own app");
    await hand.cut(async () =>
      openDocumentAt(window, {
        documentId: await documentIdOf(window, "Regional Revenue"),
      }),
    );
    const sheet = window.getByTestId("viewer-sheet");
    await expect(sheet).toBeVisible();
    await hand.click(sheet.getByRole("tab", { name: "Empty" }));
    const line = sheet.getByTestId("viewer-sheet-empty");
    await expect(line).toBeVisible();
    await hand.moveTo(line.getByTestId("viewer-sheet-open"));
    await hand.hold(1200);
    await hand.click(line.getByTestId("viewer-sheet-open"));
    await hand.hold(900);

    film.mark("end");
    await film.stop();
    finished = true;

    await mkdir(OUT, { recursive: true });
    const master = join(dataDir, "master.mp4");
    await film.master(master);
    const stem = join(OUT, "plain-words-2026-10-27");
    const mp4 = await encodeMp4(master, `${stem}.mp4`);
    const gif = await encodeGif(
      master,
      `${stem}.gif`,
      [[0, film.markTimes().end ?? film.kept]],
      GIF,
    );
    console.log(
      `${stem}.gif ${(gif / 1e6).toFixed(2)} MB, ${stem}.mp4 ${(mp4 / 1e6).toFixed(2)} MB`,
    );
  } finally {
    if (film && !finished) await film.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    for (const folder of [dataDir, sources]) await removeDataFolder(folder);
  }
});
