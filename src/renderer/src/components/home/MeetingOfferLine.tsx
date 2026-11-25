import { meetingAppName } from "../../../../shared/meetingApps";
import { core } from "../../core";
import { useGap, useLanguage, useT } from "../../i18n";
import { useMeetingOffers } from "../../meetingOffers";
import { useMeetings } from "../../meetings";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";

/** Where a notification click takes the User on systems that cannot show the tray menu. */
export function MeetingOfferLine() {
  const t = useT();
  const gap = useGap();
  const language = useLanguage();
  const offer = useMeetingOffers((state) => state.offers.offer);
  if (!offer) return null;
  const calendar = offer.kind === "calendar";
  const app = calendar ? null : meetingAppName(offer.app, language);
  const title = calendar
    ? t("offers.calendar.label", { title: offer.title })
    : t("offers.call.title");
  const body = app === null ? null : t("offers.call.body", { app });
  const report = useAppStore.getState().reportError;
  return (
    <div data-testid={calendar ? "calendar-offer-line" : "call-offer-line"} className="mb-6">
      <ProblemLine
        role="status"
        action={{
          label: t("offers.take"),
          testId: calendar ? "calendar-offer-take" : "call-offer-take",
          onClick: () => void useMeetings.getState().takeOffer(offer.id),
        }}
        also={{
          label: app === null ? t("offers.notNow") : t("offers.dontAsk", { app }),
          testId: calendar ? "calendar-offer-not-now" : "call-offer-dont-ask",
          onClick: () =>
            void core.declineMeetingOffer({ offerId: offer.id, always: !calendar }).catch(report),
        }}
      >
        {title}
        {body && gap(title, body)}
        {body}
      </ProblemLine>
    </div>
  );
}
