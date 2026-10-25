import type { GettingStarted } from "../../core/api";
import type { AppState } from "./store";

export const stepsShownOf = (progress: GettingStarted | undefined): boolean =>
  progress?.started === true && !progress.hidden;

export const firstOpenOf = (progress: GettingStarted | undefined): boolean =>
  stepsShownOf(progress) &&
  !(progress?.indexed && (progress?.askedOwn || progress?.askedReady) && progress?.citationChecked);

export type NudgeId = "usage-data";

type NudgeState = Pick<
  AppState,
  "settings" | "privacy" | "ownAnswerArrived" | "askedOwnAtLaunch" | "usageNotice"
>;

// A newcomer meets one ask at a time: a release asks once the first own Answer has arrived and the
// steps are done or closed, or at the next launch if they are still open.
export function usageDataShown(state: NudgeState): boolean {
  const usageData = state.privacy?.usageData;
  if (!usageData?.available || usageData.localMode || state.usageNotice === "answered")
    return false;
  if (usageData.testerBuild) return !usageData.asked || state.usageNotice === "kept";
  if (usageData.asked) return false;
  const stepsOver = !firstOpenOf(state.settings?.device.gettingStarted);
  return state.askedOwnAtLaunch || (state.ownAnswerArrived && stepsOver);
}

const ORDER: readonly { id: NudgeId; shown(state: NudgeState): boolean }[] = [
  { id: "usage-data", shown: usageDataShown },
];

export const chooseNudge = (state: NudgeState): NudgeId | null =>
  ORDER.find((nudge) => nudge.shown(state))?.id ?? null;
