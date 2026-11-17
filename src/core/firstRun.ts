/**
 * The first run's setup (#3296): a fresh profile opens on it, before the example, to ask what the
 * User works on and set up the three models. Nothing is kept or made until it is finished or
 * skipped through, so a setup left halfway shows again at the next launch.
 */
import { keptOrder } from "../shared/keptOrder";
import { type Examples, type FirstRunSetup, WORK_KINDS, type WorkKind } from "./api";
import { InvalidInputError } from "./errors";
import type { createExamples } from "./examples";
import type { SettingsStore } from "./settings";
import type { UsageData } from "./usageData";
import { exampleGroupsOf, pickedWork } from "./workKinds";

/** The device value keeping the order the kinds of work are shown in, once per install. */
const ORDER_VALUE = "workOrder";

const ASKED = WORK_KINDS.filter((kind) => kind !== "other");

export function createFirstRun(options: {
  settings: SettingsStore;
  examples: Pick<ReturnType<typeof createExamples>, "unoffered" | "offer">;
  usageData: Pick<UsageData, "sendWorkPicked">;
  hasMinds(): boolean;
  /** Whether the host opens a fresh profile on the setup; a test build only when a test asks. */
  offered: boolean;
  /** Pushes "settings.changed". */
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

  const picks = (work: unknown): WorkKind[] => {
    const picked = pickedWork(work);
    if (!picked) throw new InvalidInputError("Those aren't kinds of work the setup asks about.");
    return picked;
  };

  return {
    status(): FirstRunSetup {
      return fresh() ? { show: true, workOrder: workOrder() } : { show: false };
    },

    async finish(work: unknown): Promise<Examples | null> {
      const picked = picks(work);
      settings.update({ device: { work: picked, setupFinished: true } });
      options.settingsChanged();
      return examples.offer(options.hasMinds(), exampleGroupsOf(picked));
    },

    sendPicks(work: unknown): boolean {
      const picked = picks(work);
      if (picked.length === 0) throw new InvalidInputError("There are no picks to send.");
      return options.usageData.sendWorkPicked(picked);
    },
  };
}
