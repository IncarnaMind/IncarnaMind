/**
 * The first run's setup (#3296): a fresh profile opens on it, before the example, to ask what the
 * User works on and set up their AI and meeting transcription. A setup left halfway shows again
 * at the next launch.
 */
import { keptOrder } from "../shared/keptOrder";
import {
  type Examples,
  FIRST_RUN_STEPS,
  type FirstRunSetup,
  type FirstRunStep,
  WORK_KINDS,
  type WorkKind,
} from "./api";
import { InvalidInputError } from "./errors";
import type { createExamples } from "./examples";
import type { SettingsStore } from "./settings";
import type { UsageData } from "./usageData";
import { exampleGroupsOf, pickedWork } from "./workKinds";

const ORDER_VALUE = "workOrder";
const PROGRESS_VALUE = "firstRunProgress";

const ASKED = WORK_KINDS.filter((kind) => kind !== "other");

const isStep = (value: unknown): value is FirstRunStep =>
  typeof value === "string" && (FIRST_RUN_STEPS as readonly string[]).includes(value);

export function createFirstRun(options: {
  settings: SettingsStore;
  examples: Pick<ReturnType<typeof createExamples>, "unoffered" | "offer">;
  usageData: Pick<UsageData, "sendWorkPicked" | "workPickedSent">;
  hasMinds(): boolean;
  /** Whether the host opens a fresh profile on the setup; a test build only when a test asks. */
  offered: boolean;
  settingsChanged(): void;
  random?(): number;
}) {
  const { settings, examples } = options;

  const fresh = (): boolean => {
    const { device } = settings.get();
    return (
      options.offered &&
      examples.unoffered() &&
      !options.hasMinds() &&
      !device.openedBefore &&
      !device.setupFinished
    );
  };

  const workOrder = (): WorkKind[] => {
    const order = keptOrder(
      ASKED,
      settings.readDeviceValue(ORDER_VALUE),
      options.random ?? Math.random,
    );
    settings.writeDeviceValue(ORDER_VALUE, order);
    return [...order, "other"];
  };

  const readProgress = (): { step: FirstRunStep; work: WorkKind[] } => {
    const stored = settings.readDeviceValue(PROGRESS_VALUE);
    if (!stored || typeof stored !== "object") return { step: "work", work: [] };
    const { step, work } = stored as { step?: unknown; work?: unknown };
    return {
      step: isStep(step) ? step : "work",
      work: pickedWork(work) ?? [],
    };
  };

  const picks = (work: unknown): WorkKind[] => {
    const picked = pickedWork(work);
    if (!picked) throw new InvalidInputError({ key: "error.firstRun.work" });
    return picked;
  };

  return {
    status(): FirstRunSetup {
      if (!fresh()) return { show: false };
      const { step, work } = readProgress();
      return {
        show: true,
        workOrder: workOrder(),
        picksSent: options.usageData.workPickedSent(),
        step,
        work,
      };
    },

    saveProgress(progress: unknown): void {
      if (!progress || typeof progress !== "object") {
        throw new InvalidInputError({ key: "error.firstRun.work" });
      }
      const { step, work } = progress as { step?: unknown; work?: unknown };
      if (!isStep(step)) throw new InvalidInputError({ key: "error.firstRun.work" });
      settings.writeDeviceValue(PROGRESS_VALUE, { step, work: picks(work) });
    },

    async finish(work: unknown): Promise<Examples | null> {
      const picked = picks(work);
      settings.writeDeviceValue(PROGRESS_VALUE, null);
      settings.update({ device: { work: picked, setupFinished: true } });
      options.settingsChanged();
      return examples.offer(options.hasMinds(), exampleGroupsOf(picked));
    },

    sendPicks(work: unknown): boolean {
      const picked = picks(work);
      if (picked.length === 0) throw new InvalidInputError({ key: "error.firstRun.noPicks" });
      return options.usageData.sendWorkPicked(picked);
    },
  };
}
