/**
 * Records the README's demo of the built app, once in English and once in Chinese, with a real
 * model, the real speech and search models, and test Documents only. Build the test app first
 * (`npx electron-vite build --mode test`), then:
 *
 *   set -a; . ./.env.local; set +a; npm run demo:record
 *
 * `DEMO_LANGUAGE` records one language, `DEMO_OUT` is where the film's files go (docs/images by
 * default), `DEMO_STILLS` where the feature pictures go (docs/images by default), `DEMO_CONTACT`
 * where the contact sheet goes (a temporary folder) and `DEMO_SCENES` films only the scenes it
 * lists (a try-out: the cuts are not the README's, and no pictures are written).
 * `INCARNAMIND_MODEL_CACHE` is the folder whose `models/` hold the speech and search models.
 * The recording makes only the cuts, the zooms, the pointer and the captions: every Answer,
 * Citation, verdict, table, transcript and note on screen is the app's own.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { assertCaptionsAtScenes } from "./captionGuard";
import { captureFeature, contactSheet, writeFeatures } from "./features";
import {
  encodeGif,
  encodeMp4,
  FILMED,
  Film,
  Hand,
  installOverlay,
  probeDuration,
  renderPills,
} from "./film";
import { SCENES, type Scene, type Take } from "./scenes";
import { SCENE_TABLE } from "./sceneTable";
import { type DemoScript, SCRIPTS } from "./script";
import { checkTheMind, openMind, quietCommand, snap } from "./steps";
import { FEATURE_SCREEN_PIXELS, type Feature } from "./stills";
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
/** Where the feature pictures go; the film's own files go to `DEMO_OUT`. */
const STILLS = process.env.DEMO_STILLS ?? join(repository, "docs", "images");
/** The contact sheet of both takes, for the review: a build artifact, never committed. */
const CONTACT = process.env.DEMO_CONTACT ?? join(tmpdir(), "readme-features-contact.png");
/** The GIF is the README's fallback and must stay under 10 MB: try the sharpest, then lighter. */
const GIF_QUALITIES = [
  { fps: 12, width: 1100, colors: 128 },
  { fps: 10, width: 1000, colors: 96 },
  { fps: 8, width: 960, colors: 64 },
  { fps: 8, width: 900, colors: 48 },
];
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

if (!process.env.DEMO_REENCODE) {
  test("puts every take's feature pictures on one contact sheet", async () => {
    if (ONLY) return;
    await contactSheet(STILLS, LANGUAGES, CONTACT);
    console.log(`contact sheet: ${CONTACT}`);
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
  // The sandbox runs the Python an Analysis needs; the pictures are cut at 2.5 pixels per CSS pixel.
  const { app, window } = await launchApp(dataDir, { realEngines: true, sandboxed: true });
  let film: Film | undefined;
  let finished = false;
  try {
    await setWindowSize(app, window, FILMED.width, FILMED.height);
    await window.emulateMedia({ colorScheme: "light" });
    expect(await window.evaluate(() => devicePixelRatio)).toBe(FEATURE_SCREEN_PIXELS);
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
    const samples: number[][] = [];
    for (const [index, line] of script.call.lines.entries()) {
      samples.push(
        await speech(
          voices,
          `${line.side}-${index}`,
          line.side === "them" ? script.call.voices.them : script.call.voices.me,
          line.text,
        ),
      );
    }
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
    const pictures = new Map<Feature, Buffer>();
    const take: Take = {
      window,
      hand,
      film,
      script,
      app,
      output,
      workspace,
      call: { samples, voices: script.call.voices },
      async still(name, targets) {
        if (!SCENE_TABLE.some((row) => row.still === name)) {
          throw new Error(`The scene table has no picture “${name}”.`);
        }
        await snap(window, `still-${name}`);
        pictures.set(name, await captureFeature(window, targets));
      },
    };
    await hand.place(PARK.x, PARK.y);
    await hand.begin();

    for (const scene of SCENES) {
      if (ONLY && !ONLY.includes(scene.name)) continue;
      const before = film.kept;
      film.mark(scene.name);
      film.picturesOnly(!scene.film);
      film.caption(scene.caption ? script.captions[scene.caption] : null);
      await run(scene, take);
      if (scene.still && !pictures.has(scene.still)) {
        throw new Error(`“${scene.name}” filmed without its ${scene.still} picture.`);
      }
      console.log(`${script.language}: ${scene.name} ${(film.kept - before).toFixed(1)} s`);
    }
    film.mark("end");
    await film.picturesOnly(false);
    await film.stop();

    if (!ONLY) {
      await writeFeatures(pictures, join(files, "features"), STILLS, script.language);
      console.log(
        `${script.language}: ${pictures.size} stills in ${join(STILLS, "features", script.language)}`,
      );
    }

    const marks = film.markTimes();
    // A caption belongs to the scene it was set in: a range that runs into another scene, or a
    // scene whose own caption is not at its mark, stops the take rather than shipping.
    if (!ONLY) {
      const expected = SCENES.flatMap((scene) => {
        if (!scene.film || !scene.caption) return [];
        return [
          {
            scene: scene.name,
            at: marks[scene.name] ?? 0,
            text: script.captions[scene.caption],
          },
        ];
      });
      assertCaptionsAtScenes(film.captionTimes(), marks, SCENES, expected, film.kept);
    }
    const master = process.env.DEMO_MASTER ?? join(files, "master.mp4");
    await film.master(master);
    await writeFile(`${master}.marks.json`, JSON.stringify(marks, null, 2));
    const stem = join(OUT, `${NAME}-${script.language}`);
    const mp4 = await encodeMp4(master, `${stem}.mp4`);
    let gif = 0;
    let quality = { fps: 12, width: 1100, colors: 128 };
    for (const each of GIF_QUALITIES) {
      quality = each;
      gif = await encodeGif(master, `${stem}.gif`, cutOf(marks), each);
      if (gif <= 10_000_000) break;
    }
    if (gif > 10_000_000) {
      throw new Error(`The GIF is ${(gif / 1e6).toFixed(1)} MB, over the README's 10 MB fallback.`);
    }
    // The file is what someone watches: its own length must be the film the scenes made.
    const length = await probeDuration(`${stem}.mp4`);
    if (Math.abs(length - film.kept) > 1) {
      throw new Error(
        `The film file is ${length.toFixed(1)} s, not the ${film.kept.toFixed(1)} s its scenes made.`,
      );
    }
    console.log(
      `${script.language}: ${stem}.gif ${(gif / 1e6).toFixed(2)} MB (${quality.fps} fps, ${quality.width} px, ${quality.colors} colours), ${stem}.mp4 ${(mp4 / 1e6).toFixed(2)} MB, ${length.toFixed(1)} s on disk (scenes ${film.kept.toFixed(1)} s), spent $${(await spent(window)).toFixed(3)}`,
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

/** The README's GIF is the whole film, from its first frame to its end card. */
function cutOf(marks: Record<string, number>): [number, number][] {
  const end = marks.end;
  if (end === undefined || end <= 0) throw new Error("The recording has no end mark.");
  return [[marks.hook ?? 0, end]];
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
    const best = GIF_QUALITIES[0] ?? { fps: 12, width: 1100, colors: 128 };
    const gif = await encodeGif(REENCODE, `${stem}.gif`, cutOf(marks), {
      ...best,
      colors: Number(process.env.DEMO_COLORS ?? best.colors),
    });
    console.log(
      `${stem}.gif ${(gif / 1e6).toFixed(2)} MB, ${stem}.mp4 ${(mp4 / 1e6).toFixed(2)} MB`,
    );
  });
}
