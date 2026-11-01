import { useEffect, useId, useState } from "react";
import {
  type AgentClient,
  type AgentSetupPreview,
  NOT_IN_A_FOLDER_ID,
  type SecretStorageStatus,
} from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { onlyNotInAFolder } from "../../agentFolders";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { ProblemMark } from "../ProblemLine";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { SLOT, Slotted } from "../Slotted";
import {
  buttonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  errorTextClass,
  fieldLabelClass,
  hintClass,
  inputClass,
  primaryButtonClass,
} from "../ui";
import { useModal } from "../useModal";
import { AgentFolderList, useAgentFolderRows } from "./AgentFolderList";
import { ProposeChoice } from "./ProposeChoice";

const ALL_UNFILED: ReadonlySet<string> = new Set([NOT_IN_A_FOLDER_ID]);
const NOTHING: ReadonlySet<string> = new Set();

/**
 * The one confirmation before an agent is connected (#351), which is also the
 * User's consent to its data flow: what it will be able to read, where that
 * goes (its own AI model, under its service's terms, which may train on it),
 * the Folders it may read (none chosen until the User picks), and, for an
 * agent whose settings file IncarnaMind writes, exactly what it adds there.
 * The User may also let it propose changes to the notes there (#352), off
 * unless they tick it. Open while `client` is set; `onAllow` gets the choices.
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
  onAllow(folderIds: string[], name: string, propose: boolean): void;
  onClose(): void;
}) {
  const t = useT();
  const dialog = useModal(client !== null, { focusDialog: true });
  /** What the User has ticked; null until they tick or untick something. */
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const rows = useAgentFolderRows(client !== null);
  /** The name the User gives "Other agent". */
  const [name, setName] = useState("");
  const [propose, setPropose] = useState(false);
  const [preview, setPreview] = useState<AgentSetupPreview | null>(null);
  /** Where the agent's key can be kept: with no keyring (Linux), only once the User allows plain text. */
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const reportError = useAppStore((state) => state.reportError);
  const titleId = useId();
  const clientId = client?.id ?? null;

  // A new agent starts with nothing picked, and its own preview.
  useEffect(() => {
    setPicked(null);
    setName("");
    setPropose(false);
    setPreview(null);
    if (!clientId) return;
    let current = true;
    core.previewAgentSetup(clientId).then((value) => {
      if (current) setPreview(value);
    }, reportError);
    core.getSecretStorage().then((value) => {
      if (current) setStorage(value);
    }, reportError);
    return () => {
      current = false;
    };
  }, [clientId, reportError]);
  const canKeepKey = storage?.canSave !== false;

  const agent = client ? name.trim() || clientInSentence(client, t) : "";
  // Not in a Folder alone is ticked: it is every Document, so there is nothing else to choose.
  const chosen = picked ?? (onlyNotInAFolder(rows) ? ALL_UNFILED : NOTHING);
  const toggle = (folderId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(folderId);
    else next.delete(folderId);
    setPicked(next);
  };
  const allowed = rows.filter((row) => chosen.has(row.id)).map((row) => row.id);

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
      <div className={dialogBodyClass}>
        <h2 id={titleId} className={dialogTitleClass}>
          {t("agents.connect.title", { agent })}
        </h2>
        <p className={dialogTextClass}>{t("agents.connect.body", { agent })}</p>
        {client?.id === "other" && (
          <label className="flex flex-col gap-1">
            <span className={fieldLabelClass}>{t("agents.connect.name")}</span>
            <input
              type="text"
              data-testid="connect-agent-name"
              value={name}
              placeholder={t("agents.connect.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </label>
        )}
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className={fieldLabelClass}>{t("agents.connect.folders")}</legend>
          <AgentFolderList rows={rows} agent={agent} chosen={chosen} onToggle={toggle} />
        </fieldset>
        <ProposeChoice checked={propose} onChange={setPropose} />
        {preview && (
          <div data-testid="connect-agent-change" className="flex flex-col gap-1">
            <p className={dialogTextClass}>
              <Slotted
                message={t("agents.connect.fileChange", { path: SLOT })}
                slot={<InlinePath path={preview.path} />}
              />
            </p>
            <details>
              <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
                {t("agents.connect.showChange")}
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
                {preview.change}
              </pre>
            </details>
          </div>
        )}
        {client?.skillPath && (
          <p data-testid="connect-agent-skill" className={dialogTextClass}>
            <Slotted
              message={t("agents.connect.skill", { path: SLOT, agent })}
              slot={<InlinePath path={client.skillPath} />}
            />
          </p>
        )}
        {rows.length > 0 && allowed.length === 0 && (
          <p className={hintClass}>{t("agents.connect.pickOne")}</p>
        )}
        {storage && !storage.canSave && (
          <SecretStorageNotice
            status={storage}
            onAccept={() => core.acceptPlainTextSecretStorage().then(setStorage, reportError)}
          />
        )}
        {problem && (
          <p data-testid="connect-agent-problem" role="alert" className={errorTextClass}>
            <ProblemMark />
            {problem}
          </p>
        )}
        <div className={dialogActionsClass}>
          <button type="button" onClick={onClose} className={buttonClass}>
            {t("agents.connect.cancel")}
          </button>
          <button
            type="button"
            data-testid="connect-agent-allow"
            disabled={allowed.length === 0 || busy || !canKeepKey}
            onClick={() => onAllow(allowed, name, propose)}
            className={primaryButtonClass}
          >
            {t("agents.connect.allow")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
