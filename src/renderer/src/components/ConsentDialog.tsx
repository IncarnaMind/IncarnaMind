import { useEffect, useRef, useState } from "react";
import type { ConsentRequest } from "../../../core/api";
import { CHATGPT_SERVICE } from "../../../core/providers/chatgpt/service";
import { core } from "../core";
import { useGap, useT } from "../i18n";
import { useAppStore } from "../store";
import { ProviderDataUseNotice } from "./providers/ProviderDataUseNotice";
import {
  buttonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  hintClass,
  primaryButtonClass,
  ruledListClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * Asks before data leaves the machine: the core raises a consent request
 * before the first request on a flow, and waits. It lists what the flow sends
 * and to whom. The User must choose; Esc doesn't dismiss it.
 */
export function ConsentDialog() {
  const t = useT();
  const gap = useGap();
  const [queue, setQueue] = useState<ConsentRequest[]>([]);

  useEffect(() => {
    const add = (requests: readonly ConsentRequest[]) =>
      setQueue((current) => [
        ...current,
        ...requests.filter((request) =>
          current.every((queued) => queued.requestId !== request.requestId),
        ),
      ]);
    const stopRequested = core.on("consent.requested", (request) => add([request]));
    const stopResolved = core.on("consent.resolved", ({ requestId }) =>
      setQueue((current) => current.filter((request) => request.requestId !== requestId)),
    );
    // Requests raised before this window was listening.
    core.listConsentRequests().then(add, () => undefined);
    return () => {
      stopRequested();
      stopResolved();
    };
  }, []);

  const request = queue[0];
  const decline = useRef<HTMLButtonElement>(null);
  const dialog = useModal(request !== undefined, { initialFocus: decline });

  const respond = async (accept: boolean) => {
    if (!request) return;
    setQueue((current) => current.filter((queued) => queued.requestId !== request.requestId));
    try {
      await core.respondToConsent(request.requestId, accept);
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    }
  };

  const service = request?.flow.service.name ?? "";
  const purpose = request ? t(`consent.flow.${request.flow.id}.purpose`) : "";
  const isFirstAsk = request !== undefined && request.newKinds.length === request.flow.sends.length;

  return (
    <dialog
      ref={dialog}
      data-testid="consent-dialog"
      aria-labelledby="consent-title"
      onCancel={(event) => event.preventDefault()}
      className={`${dialogClass} w-[30rem]`}
    >
      {request && (
        <div className={dialogBodyClass}>
          <h2 id="consent-title" className={dialogTitleClass}>
            {t("consent.dialog.title", { service })}
          </h2>
          <div className="flex flex-col gap-2">
            <p className={dialogTextClass}>
              {t(isFirstAsk ? "consent.dialog.body" : "consent.dialog.bodyMore", {
                purpose,
                service,
              })}
            </p>
            {/* What it sends: rows split by rules. */}
            <ul className={ruledListClass}>
              {request.newKinds.map((kind) => (
                <li key={kind} className="py-2 text-ui text-ink">
                  {t(`consent.data.${kind}`)}
                </li>
              ))}
            </ul>
          </div>
          <ProviderDataUseNotice service={request.flow.service} />
          {request.flow.id === "connectors" && (
            <p className={dialogTextClass}>
              {/* A local Connector's service is "connector:<id>"; a remote one's is its server's origin. */}
              {request.flow.service.id.startsWith("connector:")
                ? t("connectors.consent.note")
                : t("remoteConnectors.consent.note")}
            </p>
          )}
          {request.flow.service.id === CHATGPT_SERVICE.id && (
            <p data-testid="consent-chatgpt-note" className={dialogTextClass}>
              {t("chatgpt.consent.note")}
            </p>
          )}
          <p className={hintClass}>
            {t("consent.dialog.note")}
            {gap(t("consent.dialog.note"), t("privacy.changeAnyTime"))}
            {t("privacy.changeAnyTime")}
          </p>
          <div className={dialogActionsClass}>
            <button
              ref={decline}
              type="button"
              data-testid="consent-decline"
              onClick={() => void respond(false)}
              className={buttonClass}
            >
              {t("consent.dialog.decline")}
            </button>
            <button
              type="button"
              data-testid="consent-allow"
              onClick={() => void respond(true)}
              className={primaryButtonClass}
            >
              {t("consent.dialog.allow")}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
