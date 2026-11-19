import { useId } from "react";
import type { AgentClient } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
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
import { type AgentChoice, ConnectAgentFields } from "./ConnectAgentFields";

/**
 * The one confirmation before an agent is connected in Settings › Agents (#351), which is also
 * the User's consent to its data flow: `ConnectAgentFields` says what it may read and where that
 * goes, and Allow is the press. Open while `client` is set; `onAllow` gets the choices.
 */
export function ConnectAgentDialog({
  client,
  busy,
  problem,
  onAllow,
  onClose,
}: {
  client: AgentClient | null;
  busy: boolean;
  /** Why the last try to connect failed, shown here, where it happened. */
  problem: string | null;
  onAllow(choice: AgentChoice): void;
  onClose(): void;
}) {
  const t = useT();
  const dialog = useModal(client !== null, { focusDialog: true });
  const titleId = useId();
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      onClose={(event) => {
        // React passes the event on up its tree, to Settings' own dialog, which would close too.
        event.stopPropagation();
        onClose();
      }}
      aria-labelledby={titleId}
      data-testid="connect-agent-dialog"
      className={`${dialogClass} w-[30rem]`}
    >
      {client && (
        <div className={dialogBodyClass}>
          <h2 id={titleId} className={dialogTitleClass}>
            {t("agents.connect.title", { agent: clientInSentence(client, t) })}
          </h2>
          <ConnectAgentFields
            client={client}
            problem={problem}
            actions={({ choice, disabled }) => (
              <div className={dialogActionsClass}>
                <button type="button" onClick={onClose} className={buttonClass}>
                  {t("agents.connect.cancel")}
                </button>
                <button
                  type="button"
                  data-testid="connect-agent-allow"
                  disabled={disabled || busy}
                  onClick={() => onAllow(choice)}
                  className={primaryButtonClass}
                >
                  {t("agents.connect.allow")}
                </button>
              </div>
            )}
          />
        </div>
      )}
    </dialog>
  );
}
