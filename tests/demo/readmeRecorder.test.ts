/**
 * The README recording's plan (e2e/demo): the scenes the take runs, what each shows in both
 * languages, the captions, and the eight feature pictures. The take runs the table and writes the
 * pictures the table names, so a scene that loses its picture or its words fails here or in the
 * take, never silently in the README.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SCENES } from "../../e2e/demo/scenes";
import { FILMED_SCENES, SCENE_TABLE } from "../../e2e/demo/sceneTable";
import { SCRIPTS } from "../../e2e/demo/script";
import {
  FEATURE_ALT,
  FEATURE_CROP,
  FEATURE_INSET,
  FEATURE_MAX_BYTES,
  FEATURE_PIXELS,
  FEATURE_SIZE,
  FEATURES,
} from "../../e2e/demo/stills";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const sizeOf = (bytes: Buffer) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

describe("The README recorder's plan", () => {
  test("names each scene once, and the film keeps the story's scenes in order", () => {
    const names = SCENE_TABLE.map((row) => row.scene);
    expect(new Set(names).size).toBe(names.length);
    // The recorder's own list is the table's, row for row: a scene the table drops is not run.
    expect(SCENES.map((scene) => scene.name)).toEqual(names);
    for (const [index, scene] of SCENES.entries()) {
      expect(scene.film, scene.name).toBe(SCENE_TABLE[index]?.film);
      expect(scene.still, scene.name).toBe(SCENE_TABLE[index]?.still);
      expect(scene.caption, scene.name).toBe(SCENE_TABLE[index]?.caption);
    }
    expect(FILMED_SCENES).toEqual([
      "hook",
      "organize",
      "add to note",
      "analyse",
      "check",
      "formula",
      "export",
      "call",
      "notes",
      "end card",
    ]);
  });

  test("gives each of the eight pictures one scene, and no scene a picture the list lacks", () => {
    const stills = SCENE_TABLE.flatMap((row) => (row.still ? [row.still] : []));
    expect(stills.toSorted()).toEqual([...FEATURES].toSorted());
    expect(new Set(stills).size).toBe(stills.length);
    for (const name of FEATURES) expect(FEATURE_ALT[name].length).toBeGreaterThan(20);
  });

  test("describes each scene and gives its caption in English and Chinese", () => {
    for (const row of SCENE_TABLE) {
      for (const language of ["en", "zh-CN"] as const) {
        expect(row.shows[language].length, `${row.scene} ${language}`).toBeGreaterThan(20);
        const script = SCRIPTS[language];
        if (row.caption === null) continue;
        const caption = script.captions[row.caption];
        expect(caption.length, `${row.scene} ${language}`).toBeGreaterThan(8);
      }
    }
  });

  test("gives every Question and each call's lines in both languages", () => {
    for (const language of ["en", "zh-CN"] as const) {
      const script = SCRIPTS[language];
      for (const text of [script.question, script.seedQuestion, script.chartRequest]) {
        expect(text.length, language).toBeGreaterThan(20);
      }
      expect(script.call.lines.map((line) => line.side)).toEqual([
        "them",
        "me",
        "them",
        "me",
        "them",
        "me",
        "them",
      ]);
      for (const line of script.call.lines) expect(line.text.length, language).toBeGreaterThan(5);
      expect(script.call.voices.them.length).toBeGreaterThan(0);
      expect(script.call.voices.me.length).toBeGreaterThan(0);
    }
  });

  test("keeps the app's text readable at the width the README shows a picture", () => {
    expect(FEATURE_CROP.width + FEATURE_INSET * 2).toBe(FEATURE_SIZE.width);
    expect(FEATURE_CROP.height + FEATURE_INSET * 2).toBe(FEATURE_SIZE.height);
    // The app's body text, 16 CSS px, as it reads where the README shows a card 410 px wide.
    const onThePage = 16 * FEATURE_PIXELS * (410 / FEATURE_SIZE.width);
    expect(onThePage).toBeGreaterThanOrEqual(11);
  });

  test("wrote every picture of both takes at 1200 × 750 and under 250 KB", async () => {
    for (const language of ["en", "zh-CN"] as const) {
      for (const name of FEATURES) {
        const file = join(ROOT, "docs", "images", "features", language, `${name}.png`);
        const bytes = await readFile(file);
        expect(sizeOf(bytes), file).toEqual([FEATURE_SIZE.width, FEATURE_SIZE.height]);
        expect(bytes.length, file).toBeLessThan(FEATURE_MAX_BYTES);
      }
    }
  });
});
