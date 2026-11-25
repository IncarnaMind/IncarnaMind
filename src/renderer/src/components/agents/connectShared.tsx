import { useEffect, useState } from "react";
import {
  type AgentSetupPreview,
  ALL_SHARED_ID,
  NOT_IN_A_FOLDER_ID,
  type SecretStorageStatus,
} from "../../../../core/api";
import { leftOutOfAll, onlyNotInAFolder } from "../../agentFolders";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { SecretStorageNotice } from "../providers/ProviderForm";
import { SLOT, Slotted } from "../Slotted";
import { dialogTextClass } from "../ui";
import { useAgentFolderRows } from "./AgentFolderList";

const ALL_UNFILED: ReadonlySet<string> = new Set([NOT_IN_A_FOLDER_ID]);
const NOTHING: ReadonlySet<string> = new Set();

/** Shared Folder-share state for the one-app and many-app consent sheets. */
export function useShareFolders() {
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const rows = useAgentFolderRows(true);
  const leftOut = leftOutOfAll(useAppStore((state) => state.library?.groups) ?? []);
  const anyFolder = rows.some((row) => row.id !== NOT_IN_A_FOLDER_ID);
  const shared = all || !anyFolder;
  const chosen = picked ?? (onlyNotInAFolder(rows) ? ALL_UNFILED : NOTHING);
  const toggle = (folderId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(folderId);
    else next.delete(folderId);
    setPicked(next);
  };
  const allowed = shared
    ? [ALL_SHARED_ID]
    : rows.filter((row) => chosen.has(row.id)).map((row) => row.id);
  const reset = () => {
    setAll(true);
    setPicked(null);
  };
  return { all, setAll, rows, leftOut, anyFolder, shared, chosen, toggle, allowed, reset };
}

/** Reads whether the system keyring can keep an agent's key, and lets the User allow plain text. */
export function useSecretStorage(resetKey: string) {
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const reportError = useAppStore((state) => state.reportError);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check storage when the sheet's target changes.
  useEffect(() => {
    let current = true;
    core.getSecretStorage().then((value) => {
      if (current) setStorage(value);
    }, reportError);
    return () => {
      current = false;
    };
  }, [resetKey, reportError]);
  const accept = () => core.acceptPlainTextSecretStorage().then(setStorage, reportError);
  return { storage, canKeepKey: storage?.canSave !== false, accept };
}

/** Shows the plain-text key notice when the system keyring is unavailable. */
export function AgentSecretNotice({
  storage,
  onAccept,
}: {
  storage: SecretStorageStatus | null;
  onAccept(): void;
}) {
  if (!storage || storage.canSave) return null;
  return <SecretStorageNotice status={storage} onAccept={onAccept} />;
}

/** The exact settings-file change and backup paths shown under Details before connecting. */
export function FileChangePreview({
  preview,
  testIdPrefix,
}: {
  preview: AgentSetupPreview;
  testIdPrefix: string;
}) {
  const t = useT();
  return (
    <div data-testid={`${testIdPrefix}-change`} className="flex flex-col gap-1">
      <p className={dialogTextClass}>
        <Slotted
          message={t("agents.connect.fileChange", { path: SLOT })}
          slot={<InlinePath path={preview.path} />}
        />
      </p>
      <details data-testid={`${testIdPrefix}-change-lines`}>
        <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary">
          {t("agents.connect.showChange")}
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
          {preview.change}
        </pre>
      </details>
      {preview.backup && (
        <p data-testid={`${testIdPrefix}-backup`} className={dialogTextClass}>
          <Slotted
            message={t("agents.connect.backup", { path: SLOT })}
            slot={<InlinePath path={preview.backup} />}
          />
        </p>
      )}
    </div>
  );
}
