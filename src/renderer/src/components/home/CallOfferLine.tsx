import { meetingAppName } from "../../../../shared/meetingApps";
import { core } from "../../core";
import { useGap, useLanguage, useT } from "../../i18n";
import { useMeetingOffers } from "../../meetingOffers";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";

/**
 * Home's line for a call offered now (#208), as the menu bar's menu holds it: where a click on the
 * notification brings the User when no menu can show, and for whoever opens Home meanwhile. Take
 * notes records; nothing else here does.
 */
export function CallOfferLine() {
  const t = useT();
  const gap = useGap();
  const language = useLanguage();
  const offer = useMeetingOffers((state) => state.offers.offer);
  if (!offer) return null;
  const app = meetingAppName(offer.app, language);
  const title = t("offers.call.title");
  const body = t("offers.call.body", { app });
  const report = useAppStore.getState().reportError;
  return (
    <div data-testid="call-offer-line" className="mb-6">
      <ProblemLine
        role="status"
        action={{
          label: t("offers.take"),
          testId: "call-offer-take",
          onClick: () => void core.takeMeetingOffer(offer.id).catch(report),
        }}
        also={{
          label: t("offers.dontAsk", { app }),
          testId: "call-offer-dont-ask",
          onClick: () =>
            void core.declineMeetingOffer({ offerId: offer.id, always: true }).catch(report),
        }}
      >
        {title}
        {gap(title, body)}
        {body}
      </ProblemLine>
    </div>
  );
}
