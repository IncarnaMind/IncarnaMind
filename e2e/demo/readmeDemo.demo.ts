/**
 * Records the README's demo of the built app, once in English and once in Chinese, with a real
 * model, the real speech and search models, and test Documents only. Build the test app first
 * (`npx electron-vite build --mode test`), then:
 *
 *   set -a; . ./.env.local; set +a; npm run demo:record
 *
 * `DEMO_LANGUAGE` records one language, `DEMO_OUT` is where the files go (docs/images by default),
 * `DEMO_SCENES` films only the scenes it lists (a try-out; the cuts are then not the README's)
 * and `INCARNAMIND_MODEL_CACHE` the folder whose `models/` hold the speech and search models.
 * The recording makes only the cuts, the zooms, the pointer and the captions: every Answer,
 * Citation, verdict, table, transcript and note on screen is the app's own.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addToNote,
  askInAssistant,
  createDataFolder,
  launchApp,
  removeDataFolder,
  useOutputLocation as saveFilesIn,
  setLanguage,
  setWindowSize,
} from "../app";
import { connectCall, speech } from "./call";
import { encodeGif, encodeMp4, FILMED, Film, Hand, installOverlay, renderPills } from "./film";
import { SCENES, type Scene, type Take } from "./scenes";
import { type DemoScript, SCRIPTS } from "./script";
import { checkTheMind, openMind, quietCommand } from "./steps";
import {
  buildWorkspace,
  chooseSonnetEverywhere,
  connectClaude,
  seedModels,
  spent,
  writeDraft,
} from "./workspace";

const repository = resolve(__dirname, "../..");
const NAME = "demo-tour-2026-10-25";
const OUT = process.env.DEMO_OUT ?? join(repository, "docs", "images");
const GIF = { fps: 12, width: 1100, colors: 128 };
/** Where the pointer waits at the start of a scene: over nothing, so no card opens under it. */
const PARK = { x: 640, y: 600 };
const LANGUAGES = process.env.DEMO_LANGUAGE
  ? [process.env.DEMO_LANGUAGE as "en" | "zh-CN"]
  : (["en", "zh-CN"] as const);
const ONLY = process.env.DEMO_SCENES?.split(",");

test.describe.configure({ mode: "serial" });

for (const language of process.env.DEMO_REENCODE ? [] : LANGUAGES) {
  test(`records the README demo in ${language}`, async () => {
    await record(SCRIPTS[language]);
  });
}

async function record(script: DemoScript): Promise<void> {
  const dataDir = await createDataFolder();
  const sources = await createDataFolder();
  const files = await createDataFolder();
  const output = join(files, script.outputFolder);
  await mkdir(output, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await seedModels(dataDir);
  const { app, window } = await launchApp(dataDir, { realEngines: true });
  let film: Film | undefined;
  let finished = false;
  try {
    await setWindowSize(app, window, FILMED.width, FILMED.height);
    expect(await window.evaluate(() => devicePixelRatio)).toBe(2);
    // The computer's spell checker would underline the fictional names in the draft.
    await app.evaluate(({ session }) => session.defaultSession.setSpellCheckerEnabled(false));
    if (script.language !== "en") await setLanguage(window, script.language);
    console.log(
      `${script.language}: model ${(await connectClaude(window)).replace(/.*_/, "key ")}`,
    );
    await chooseSonnetEverywhere(window);
    await saveFilesIn(window, output);
    const workspace = await buildWorkspace(window, script, sources);

    // The draft: its title, a cited paragraph the assistant adds below it, then the User's own text.
    await openMind(window, script.paper.title);
    await window.getByTestId("mind-editor").click();
    const seeded = await askInAssistant(window, script.seedQuestion, { timeout: 90_000 });
    await expect(seeded.getByTestId("citation").nth(1)).toBeVisible();
    await addToNote(window, seeded);
    await writeDraft(window, script, workspace.paperId);
    const covered = script.paper.blocks[5]?.text ?? "";
    await expect(window.getByTestId("mind-editor")).toContainText(covered.slice(0, 30));

    // The sidebar shows both Folders open, as a workspace in use has them.
    const sidebar = window.getByTestId("library-folders");
    if (!(await sidebar.getByText(script.options.title).isVisible())) {
      await sidebar.getByText(script.folders.contracts.name).first().click();
    }
    if (!(await sidebar.getByText(script.paper.title).isVisible())) {
      await sidebar.getByText(script.folders.credit.name).first().click();
    }
    const voices = join(files, "voices");
    const them = await speech(voices, "them", script.call.voices.them, script.call.them);
    const me = await speech(voices, "me", script.call.voices.me, script.call.me);
    await connectCall(app);

    await quietCommand(window, script.words.foldCommand, script.words.foldCommand);
    await expect(window.getByTestId("assistant")).toHaveAttribute("data-folded", "true");

    // The film opens on the paper as the first check left it: the film shows the payoff first.
    await checkTheMind(window, script);
    await expect(
      window.locator('[data-testid="claim-mark"][data-check="contradicted"]'),
    ).toHaveCount(1);

    await installOverlay(window);
    const pills = await renderPills(Object.values(script.captions), join(files, "pills"));
    film = await Film.start(window, join(files, "frames"), pills);
    const hand = new Hand(window, film);
    const take: Take = { window, hand, film, script, app, output, workspace, voices: { them, me } };
    await hand.place(PARK.x, PARK.y);
    await hand.begin();

    for (const scene of SCENES) {
      if (ONLY && !ONLY.includes(scene.name)) continue;
      const before = film.kept;
      film.mark(scene.name);
      await run(scene, take);
      console.log(`${script.language}: ${scene.name} ${(film.kept - before).toFixed(1)} s`);
    }
    film.mark("end");
    await film.stop();

    const master = process.env.DEMO_MASTER ?? join(files, "master.mp4");
    await film.master(master);
    const marks = film.markTimes();
    await writeFile(`${master}.marks.json`, JSON.stringify(marks, null, 2));
    const stem = join(OUT, `${NAME}-${script.language}`);
    const mp4 = await encodeMp4(master, `${stem}.mp4`);
    const gif = await encodeGif(master, `${stem}.gif`, cutOf(marks, ONLY), GIF);
    console.log(
      `${script.language}: ${stem}.gif ${(gif / 1e6).toFixed(2)} MB, ${stem}.mp4 ${(mp4 / 1e6).toFixed(2)} MB, ${film.kept.toFixed(1)} s, spent $${(await spent(window)).toFixed(3)}`,
    );
    finished = true;
  } finally {
    if (film && !finished) {
      await film.stop().catch(() => undefined);
      const unfinished = join(files, "master.mp4");
      await film.master(unfinished).catch(() => undefined);
      await encodeMp4(unfinished, join(OUT, `${NAME}-${script.language}-unfinished.mp4`), 28).catch(
        () => undefined,
      );
    }
    await app.close().catch(() => undefined);
    for (const folder of [dataDir, sources, files]) await removeDataFolder(folder);
  }
}

async function run(scene: Scene, take: Take): Promise<void> {
  await scene.run(take);
  // A zoom is never left in across a cut.
  await take.hand.zoomOutIfIn();
}

/** The README's GIF: the mistake, the click on a Citation, the formula, the check, the end card. */
function cutOf(marks: Record<string, number>, only: string[] | undefined): [number, number][] {
  if (only) return [[0, marks.end ?? 0]];
  const cut = (from: string, to: string): [number, number] => {
    const start = marks[from];
    const end = marks[to];
    if (start === undefined || end === undefined) throw new Error(`No mark ${from} or ${to}.`);
    return [start, end];
  };
  const [answered, asked] = cut("answer", "formula");
  const [working, worked] = cut("formula", "compare");
  const [fixing, checked] = cut("wrong", "fixed");
  return [
    cut("hook", "organize"),
    [answered + 0.2, asked],
    [working, worked],
    [fixing, checked],
    cut("end card", "end"),
  ];
}

const REENCODE = process.env.DEMO_REENCODE;
if (REENCODE) {
  test("makes the GIF and the MP4 again from a master", async () => {
    const marks = JSON.parse(await readFile(`${REENCODE}.marks.json`, "utf8")) as Record<
      string,
      number
    >;
    const language = LANGUAGES[0];
    const stem = join(OUT, `${NAME}-${language}`);
    await mkdir(OUT, { recursive: true });
    const crf = Number(process.env.DEMO_CRF ?? 20);
    const mp4 = await encodeMp4(REENCODE, `${stem}.mp4`, crf);
    const gif = await encodeGif(REENCODE, `${stem}.gif`, cutOf(marks, undefined), {
      ...GIF,
      colors: Number(process.env.DEMO_COLORS ?? GIF.colors),
    });
    console.log(
      `${stem}.gif ${(gif / 1e6).toFixed(2)} MB, ${stem}.mp4 ${(mp4 / 1e6).toFixed(2)} MB`,
    );
  });
}
