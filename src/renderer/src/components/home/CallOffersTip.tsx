import { core } from "../../core";
import { useGap, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { closeTip, useFeatureTip } from "../../tips";
import { onMac } from "../BackgroundSettings";
import { LineAction } from "../ProblemLine";
import { Tip } from "../Tip";

/**
 * Home's one line for someone who set up Meetings before the offers to take notes were built
 * (#189): they never read the sheet that turns them on, so nothing is turned on for them. Turn on
 * does what that sheet does; ✕ and Turn on each end the line for good.
 */
export function CallOffersTip() {
  const t = useT();
  const gap = useGap();
  const wanted = useAppStore(
    (state) =>
      state.settings !== null &&
      state.settings.meetingAudio !== "none" &&
      state.settings.device.meetingNoticeAccepted &&
      !state.settings.device.callOffers,
  );
  const shown = useFeatureTip("call-offers", "home", wanted);
  if (!shown) return null;
  const line = t(onMac() ? "offers.turnOn.line" : "offers.turnOn.line.other");
  const turnOn = () => {
    closeTip("call-offers");
    void useAppStore.getState().updateSettings({ device: { callOffers: true, keepRunning: true } });
    core.setOpenAtLogin(true).catch(useAppStore.getState().reportError);
  };
  return (
    <div data-testid="call-offers-tip" className="mb-6">
      <Tip id="call-offers" onClose={() => closeTip("call-offers")}>
        {line}
        {gap(line, t("offers.turnOn"))}
        <LineAction
          action={{ label: t("offers.turnOn"), testId: "call-offers-turn-on", onClick: turnOn }}
        />
      </Tip>
    </div>
  );
}
