import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { checkComments } from "../../src/renderer/src/exportChecks";
import { answerCheckComments, exportMind, useExports } from "../../src/renderer/src/exports";
import { useUndo } from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { unzip } from "../helpers/docx";
import { verifyRequest as request, setUpWordVerify, verifyWordFile } from "../helpers/verifiedWord";

/*
 * Change in someone else's Word file (#110), taken back with the window's own Undo while the
 * real core sits behind its bridge: an Undo the file refuses leaves the file, the Note's choice
 * and the Saved line as they were and stays to be tried again, so the next Undo never puts back
 * another Change's step.
 */

const bridge = vi.hoisted(() => ({ core: null as Core | null, reported: [] as unknown[] }));

// Each call fails as the window sees it, with the core's wording carried in its text.
vi.mock("../../src/renderer/src/core", async () => {
  const { errorForWindow } = await import("../../src/shared/errorWording");
  return {
    core: new Proxy(
      {},
      {
        get: (_target, key) => {
          if (!bridge.core) throw new Error("No core.");
          const core = bridge.core as unknown as Record<string | symbol, unknown>;
          const value = core[key];
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            try {
              return await value.apply(core, args);
            } catch (error) {
              throw errorForWindow(error);
            }
          };
        },
      },
    ),
    files: {},
  };
});
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({
      settings: { language: "en", user: {} },
      reportError: (error: unknown) => bridge.reported.push(error),
      updateSettings: async () => {},
      updateGettingStarted: () => {},
    }),
  },
}));
vi.mock("../../src/renderer/src/home", () => ({ ownMindsOf: () => [] }));

const t = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const WORD = { format: "docx", commentFailedChecks: true } as const;

const ours = (bytes: Buffer) =>
  (unzip(bytes).get("word/comments.xml")?.toString("utf8") ?? "").includes(
    'w:author="IncarnaMind"',
  );

describe("Undo of Change in someone else's Word file", () => {
  test.skipIf(process.platform === "win32")(
    "an Undo refused while the folder is locked keeps the file, the Note's choice and the Saved line, and Try again takes back that Change, then the one before",
    async () => {
      const set = await setUpWordVerify();
      bridge.core = set.core;
      const { mind } = await verifyWordFile(set.core, set.report);
      await set.core.findClaims(request(mind.id));
      await set.core.verifyClaims(request(mind.id));
      const out = join(set.sources, "Exports");
      await mkdir(out);
      await set.core.setOutputLocation(out);
      await exportMind(mind.id, "docx");

      const saved = () => {
        const { result } = useExports.getState();
        if (result?.state !== "saved") throw new Error(`Nothing is saved: ${result?.state}.`);
        return result;
      };
      const { path } = saved();
      const now = async () => ({
        bytes: await readFile(path),
        choice: (await set.core.previewMindExport(mind.id, WORD)).othersComments,
        line: checkComments(saved().checks, t, saved().othersFile),
      });
      const plain = await now();
      expect(plain).toMatchObject({ choice: false, line: "Check comments off" });

      await answerCheckComments(mind.id, true);
      const on = await now();
      expect(ours(on.bytes)).toBe(true);
      expect(on).toMatchObject({ choice: true, line: "3 check comments" });
      await answerCheckComments(mind.id, false);
      const off = await now();
      expect(ours(off.bytes)).toBe(false);
      expect(off).toMatchObject({ choice: false, line: "Check comments off" });

      await chmod(out, 0o555);
      try {
        await useUndo.getState().undo();
      } finally {
        await chmod(out, 0o755);
      }
      const problem = useUndo.getState().line?.problem;
      expect(problem?.reason(t)).toBe(
        "“Harbour report.docx” can’t be changed: it may be read-only or open in another app. Close it there, or export the note again.",
      );
      expect(problem?.fix?.label(t)).toBe("Try again");
      expect(useUndo.getState().done).toHaveLength(2);
      expect(await now()).toEqual(off);

      await problem?.fix?.run();
      expect(await now()).toEqual(on);
      expect(useUndo.getState().done).toHaveLength(1);

      await useUndo.getState().undo();
      expect(await now()).toEqual(plain);
      expect(useUndo.getState().done).toHaveLength(0);

      await useUndo.getState().redo();
      expect(await now()).toEqual(on);
      await useUndo.getState().undo();
      expect(await now()).toEqual(plain);
      expect(bridge.reported).toEqual([]);
      await set.core.close();
    },
  );
});
