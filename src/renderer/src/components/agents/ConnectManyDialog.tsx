import { useId } from "react";
import type { AgentClient, AgentClientId } from "../../../../core/api";
import type { AgentConnectOutcome } from "../../agentConnection";
import { useT } from "../../i18n";
import {
  buttonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTitleClass,
  primaryButtonClass,
} from "../ui";
import { useModal } from "../useModal";
import { ConnectManyFields, type ManyAgentsChoice } from "./ConnectManyFields";
import { ConnectManyResult } from "./ConnectManyResult";

/** Settings › AI modal for connecting several found AI apps in one press (#3644). */
export function ConnectManyDialog({
  open,
  clients,
  busy,
  problem,
  outcomes,
  undone,
  onAllow,
  onUndo,
  onRetry,
  onClose,
}: {
  open: boolean;
  clients: readonly AgentClient[];
  busy: boolean;
  problem: string | null;
  outcomes: readonly AgentConnectOutcome[] | null;
  undone: ReadonlySet<AgentClientId>;
  onAllow(choice: ManyAgentsChoice): void;
  onUndo(clientId: AgentClientId, pairingId: string): Promise<void>;
  onRetry(client: AgentClient): Promise<void>;
  onClose(): void;
}) {
  const t = useT();
  const dialog = useModal(open, { focusDialog: true });
  const titleId = useId();

  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      onCancel={(event) => {
        event.stopPropagation();
        // Keep the dialog open while setup is still writing so its results stay in view.
        if (busy) event.preventDefault();
      }}
      onClose={(event) => {
        // React passes the event on up its tree, to Settings' own dialog, which would close too.
        event.stopPropagation();
        if (!busy) onClose();
      }}
      aria-labelledby={titleId}
      data-testid="connect-many-dialog"
      className={`${dialogClass} w-[34rem]`}
    >
      {open && (
        <div className={dialogBodyClass}>
          <h2 id={titleId} className={dialogTitleClass}>
            {outcomes ? t("agents.connectAll.resultTitle") : t("agents.connectAll.title")}
          </h2>
          {outcomes ? (
            <>
              <ConnectManyResult
                outcomes={outcomes}
                undone={undone}
                onUndo={onUndo}
                onRetry={onRetry}
              />
              <div className={dialogActionsClass}>
                <button
                  type="button"
                  data-testid="connect-many-done"
                  onClick={onClose}
                  className={primaryButtonClass}
                >
                  {t("agents.connectAll.done")}
                </button>
              </div>
            </>
          ) : (
            <ConnectManyFields
              clients={clients}
              problem={problem}
              actions={({ choice, disabled }) => (
                <div className={dialogActionsClass}>
                  <button
                    type="button"
                    data-testid="connect-many-cancel"
                    disabled={busy}
                    onClick={onClose}
                    className={buttonClass}
                  >
                    {t("agents.connect.cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="connect-many-allow"
                    disabled={disabled || busy}
                    onClick={() => onAllow(choice)}
                    className={primaryButtonClass}
                  >
                    {t("agents.connectAll.allow", { count: choice.clients.length })}
                  </button>
                </div>
              )}
            />
          )}
        </div>
      )}
    </dialog>
  );
}
