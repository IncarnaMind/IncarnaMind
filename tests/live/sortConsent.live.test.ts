/**
 * Dropped Documents and the footer's Allow against a real cloud model (#2308): with DeepSeek V4.1
 * Flash 1017 (deepseek-flash), nothing reaches DeepSeek before the press, and the press organizes
 * the Documents that waited, in English and Chinese, into the Folder their start calls for; a
 * Document dropped after it goes by itself. Runs only with the key in the environment
 * (DEEPSEEK_API_KEY); requests are counted at `fetch`. A few cents.
 */
import { describe, expect, test, vi } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = "deepseek-flash";

const FILES: [string, string, "harbour" | "orchard"][] = [
  [
    "Quay survey.md",
    "# North quay survey\n\nThe berth depth was sounded at low water; two fenders need replacing before the ferry season.",
    "harbour",
  ],
  [
    "Pruning plan.md",
    "# Winter pruning\n\nThe apple trees in rows 4 to 9 are pruned in February; the pear trees wait for March.",
    "orchard",
  ],
  [
    "码头检查.md",
    "# 码头检查记录\n\n三号泊位低潮时水深不足，护舷有两处破损，需在渡轮旺季前更换。",
    "harbour",
  ],
  [
    "果园施肥.md",
    "# 果园施肥计划\n\n苹果树在三月施有机肥，梨树在四月追肥，行间种植三叶草。",
    "orchard",
  ],
];

describe("DeepSeek, live", () => {
  test.skipIf(KEY === undefined)(
    "sends nothing before the Allow, then sorts what waited and what comes after",
    { timeout: 300_000 },
    async () => {
      const original = globalThis.fetch;
      const sent: string[] = [];
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://api.deepseek.com/")) sent.push(url);
        return original(input as Parameters<typeof original>[0], init);
      });
      try {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        const provider = await core.saveChatProvider({
          kind: "deepseek",
          apiKey: KEY ?? "",
          modelId: MODEL,
        });
        const folders = {
          harbour: await core.createLibraryGroup({
            name: "Harbour",
            description: "Port, quay, berth and ferry work.",
          }),
          orchard: await core.createLibraryGroup({
            name: "Orchard",
            description: "Fruit trees, pruning and feeding.",
          }),
        };
        await core.saveLibrarySettings({
          ...(await core.getLibrary()).settings,
          classifier: {
            kind: "chat",
            choice: { providerId: provider.id, modelId: MODEL },
          },
        });
        const sources = await createTempDataFolder();
        const added = await addAndProcess(
          core,
          await Promise.all(FILES.map(([name, text]) => writeSourceFile(sources, name, text))),
        );
        expect(sent).toEqual([]);
        expect((await core.getLibrary()).sortWaitsFor?.name).toBe("DeepSeek");

        const { settings } = await core.getLibrary();
        await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
        await core.classifyDocuments(added.map((each) => each.id));
        const later = await addAndProcess(core, [
          await writeSourceFile(
            sources,
            "Ferry timetable.md",
            "# Ferry berth timetable\n\nThe morning ferry uses berth 2 at the north quay.",
          ),
        ]);
        const wanted = [...FILES.map(([, , folder]) => folders[folder].id), folders.harbour.id];
        const ids = [...added, ...later].map((each) => each.id);
        await vi.waitFor(
          async () => {
            const { assignments } = await core.getLibrary();
            expect(
              ids.map((id) => assignments.find((each) => each.documentId === id)?.groupId),
            ).toEqual(wanted);
          },
          { timeout: 240_000, interval: 500 },
        );
        console.info(`sort-consent live: ${sent.length} requests to DeepSeek (${MODEL})`);
      } finally {
        spy.mockRestore();
      }
    },
  );
});
