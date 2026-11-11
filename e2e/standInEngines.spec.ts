import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { coreOf, createDataFolder, launchApp, removeDataFolder } from "./app";
import { ENGINES, type Engine } from "./launchEnvironment";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/**
 * Where each engine's model stands, as the bridge reports it. A stand-in has no files to download,
 * so it is ready at once; the real model is not downloaded until a Document or a Meeting needs it.
 */
async function models(window: Page): Promise<Record<Engine, { state: string; host: string }>> {
  return (await coreOf(window)).evaluate(async (core) => {
    const [embedder, ocr, transcriber] = await Promise.all([
      core.getEmbeddingModel(),
      core.getTextRecognitionModel(),
      core.getTranscriptionModel(),
    ]);
    const stood = (model: { state: string; host: string } | null) =>
      model ? { state: model.state, host: model.host } : { state: "none", host: "" };
    return { embedder: stood(embedder), ocr: stood(ocr), transcriber: stood(transcriber) };
  });
}

test("a launch has a stand-in for every engine, and nothing to download", async () => {
  const { window } = await launchApp(dataDir);
  const stood = await models(window);
  for (const engine of ENGINES) expect(stood[engine].state, engine).toBe("ready");
});

for (const engine of ENGINES) {
  test(`real: ["${engine}"] runs that engine as the User's copy does, and the others as stand-ins`, async () => {
    const { window } = await launchApp(dataDir, { real: [engine] });
    const stood = await models(window);
    for (const each of ENGINES) {
      if (each === engine) {
        expect(stood[each], each).toMatchObject({
          state: "not-downloaded",
          host: "huggingface.co",
        });
      } else {
        expect(stood[each].state, each).toBe("ready");
      }
    }
  });
}

test("the launcher refuses a data folder or a home outside the temporary folder, naming it", async () => {
  const outside = resolve(__dirname, "..", "test-results", "not-a-temporary-folder");
  await expect(launchApp(outside)).rejects.toThrow(
    `its data folder ${outside} is not inside the system's temporary folder`,
  );
  await expect(launchApp(dataDir, { home: outside })).rejects.toThrow(
    `its home folder ${outside} is not inside the system's temporary folder`,
  );
});
