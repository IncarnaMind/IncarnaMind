import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  type AgentActivity,
  type AgentClientId,
  type AgentDisconnected,
  type AgentPairing,
  type AgentSetupResult,
  ALL_SHARED_ID,
  type LibraryGroup,
  NOT_IN_A_FOLDER_ID,
} from "../../../../core/api";
import { unitsOf } from "../../../../shared/i18n/join";
import { choiceOfAll, sharedInside } from "../../agentFolders";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsRow } from "../settings/SettingsGroup";
import { buttonStyle, rowFieldClass } from "../ui";
import { useAgentFolderRows } from "./AgentFolderList";
import { AgentShareChoice } from "./AgentShareChoice";
import {
  activityWords,
  doneWords,
  helpUrl,
  pairingInSentence,
  readsLine,
  takesParts,
  timeWords,
} from "./agentWords";
import { LaunchDetails } from "./LaunchDetails";
import { ProposeChoice } from "./ProposeChoice";

/** What setting this agent up just did, shown under it until the page goes. */
export interface JustSetUp {
  pairingId: string;
  result: AgentSetupResult;
}

/**
 * One connected agent in Settings → AI (#351): its name, what it may read
 * (all of the User's Documents and Notes, or its Folders, #3544) and whether it
 * may propose changes to their notes (#352), both
 * changed in place, when it was last used, its activity (every
 * call, newest first), the details a technical User needs to set it up again,
 * and Disconnect, which stops it at once, as deleting a Connector does. A
 * Skill the User changed, after IncarnaMind's text changed, says so, with a
 * way to replace it that asks first (#3430).
 */
export function AgentPairingRow({
  pairing,
  skillInstalled,
  skillOutOfDate,
  awaitingInstall,
  shimOutOfDate = false,
  isBundleClient = pairing.client === "claude-desktop",
  folders,
  justSetUp,
  onUndone,
  onInstallReopened,
  onDisconnected,
}: {
  pairing: AgentPairing;
  /** IncarnaMind's current Skill is in the agent's skills folder. */
  skillInstalled: boolean;
  /** The agent's Skill is one the User changed, and IncarnaMind's text has changed since. */
  skillOutOfDate: boolean;
  /** Its install file waits for the agent, which hasn't connected or been used (#3523). */
  awaitingInstall: boolean;
  /** Its last connection used a legacy v1 shim without mutual verification (ADR-0036). */
  shimOutOfDate?: boolean;
  /** Whether this pairing's agent installs a bundle file that can be reopened to upgrade. */
  isBundleClient?: boolean;
  folders: readonly LibraryGroup[];
  justSetUp: JustSetUp | null;
  onUndone(): void;
  /** The install file was made and opened again. */
  onInstallReopened(): void;
  /** The agent is disconnected; `agent` is how a sentence names it. */
  onDisconnected(agent: string, left: AgentDisconnected): void;
}) {
  const t = useT();
  const language = useLanguage();
  const reportError = useAppStore((state) => state.reportError);
  const [open, setOpen] = useState<"folders" | "activity" | null>(null);
  const [activity, setActivity] = useState<AgentActivity[] | null>(null);
  const [copied, setCopied] = useState<"settings" | "skill" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const nameButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);

  // The question takes the focus, on the safe answer, and gives it back when it is closed.
  useEffect(() => {
    if (replacing) keepButton.current?.focus();
    else if (asked.current) replaceButton.current?.focus();
    asked.current = replacing;
  }, [replacing]);

  const closeOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape") return;
    // Esc closes the question, not Settings.
    event.preventDefault();
    event.stopPropagation();
    setReplacing(false);
  };

  // The activity list follows each call while it is open.
  useEffect(() => {
    if (open !== "activity") return;
    core.listAgentActivity(pairing.id).then(setActivity, reportError);
    return core.on("agents.activity", (call) => {
      if (call.pairingId === pairing.id) setActivity((list) => [call, ...(list ?? [])]);
    });
  }, [open, pairing.id, reportError]);

  // The Folders as the User just chose them, shown at once; the core's answer then replaces them.
  const [chosen, setChosen] = useState(pairing.folderIds);
  // What the core said last, which a refused change goes back to: the Folders as they were when
  // it was asked can be older than an agents.changed that came meanwhile (#2302).
  const said = useRef(pairing.folderIds);
  useEffect(() => {
    said.current = pairing.folderIds;
    setChosen(pairing.folderIds);
  }, [pairing.folderIds]);
  // As the User just ticked it, shown at once; the core's answer then replaces it.
  const [propose, setPropose] = useState(pairing.propose);
  useEffect(() => setPropose(pairing.propose), [pairing.propose]);
  const changePropose = (value: boolean) => {
    setPropose(value);
    core.updateAgent(pairing.id, { propose: value }).catch((error: unknown) => {
      setPropose(pairing.propose);
      reportError(error);
    });
  };
  const all = chosen.includes(ALL_SHARED_ID);
  const rows = useAgentFolderRows(open === "folders", all || chosen.includes(NOT_IN_A_FOLDER_ID));
  const names = [
    ...folders.filter((folder) => chosen.includes(folder.id)).map((folder) => folder.name),
    ...(chosen.includes(NOT_IN_A_FOLDER_ID) ? [t("library.unsorted")] : []),
  ];
  // What a pairing made before #3394 reaches now too, named on its row (#3394).
  const inside = all ? [] : sharedInside(folders, chosen);
  const insideNames = folders
    .filter((folder) => inside.includes(folder.id))
    .map((folder) => folder.name);
  const share = (next: string[]) => {
    setChosen(next);
    core.updateAgent(pairing.id, { folderIds: next }).catch((error: unknown) => {
      setChosen(said.current);
      reportError(error);
    });
  };
  const setFolder = (folderId: string, on: boolean) =>
    share(on ? [...chosen, folderId] : chosen.filter((id) => id !== folderId));
  // Choosing Folders starts from what all reaches now, so the agent loses nothing at the click.
  const setAll = (value: boolean) => share(value ? [ALL_SHARED_ID] : choiceOfAll(folders, rows));
  const copySettings = async (what: "settings" | "skill") => {
    try {
      const setup = await core.copyAgentSetup(pairing.id);
      await navigator.clipboard.writeText(what === "skill" ? setup.skill : setup.text);
      setCopied(what);
    } catch (error) {
      reportError(error);
    }
  };
  const done = justSetUp?.pairingId === pairing.id ? justSetUp.result : null;
  useEffect(() => {
    if (!done) return;
    const frame = requestAnimationFrame(() => nameButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [done]);

  const toggle = (what: "folders" | "activity") => setOpen(open === what ? null : what);

  return (
    <SettingsRow
      data-testid="agent-pairing"
      data-name={pairing.name}
      label={
        renaming ? (
          <RenameAgent pairing={pairing} onDone={() => setRenaming(false)} />
        ) : (
          <button
            type="button"
            data-testid="agent-pairing-name"
            ref={nameButton}
            title={pairing.name}
            onDoubleClick={() => setRenaming(true)}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setRenaming(true);
              }
            }}
            className="block max-w-full cursor-default truncate text-left"
          >
            {pairing.name}
          </button>
        )
      }
      detail={
        <>
          <span data-testid="agent-pairing-reads" className="block">
            {all ? t("agents.pairing.readsAll") : readsLine(names, t, language)}
          </span>
          {insideNames.length > 0 && (
            <span data-testid="agent-pairing-inside" className="block">
              {t("agents.pairing.inside", { folders: unitsOf(insideNames, language) })}
            </span>
          )}
          {propose && (
            <span data-testid="agent-pairing-proposes" className="block">
              {t("agents.pairing.proposes")}
            </span>
          )}
          <span className="block">
            {pairing.lastUsedAt
              ? t("agents.pairing.lastUsed", { when: timeWords(pairing.lastUsedAt, language) })
              : t("agents.pairing.notUsed")}
            {awaitingInstall && (
              <>
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  data-testid="agent-install-again"
                  onClick={() =>
                    core.openAgentInstallAgain(pairing.id).then(onInstallReopened, reportError)
                  }
                  className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                >
                  {t("agents.pairing.installAgain")}
                </button>
              </>
            )}
          </span>
          {skillInstalled && (
            <span data-testid="agent-pairing-skill" className="block">
              {t("agents.pairing.skill", { agent: pairingInSentence(pairing, t) })}
            </span>
          )}
          {pairing.tagNamesNotShared && (
            <span className="block">
              {t("agents.sorting.tagConsent", { agent: pairingInSentence(pairing, t) })}{" "}
              <button
                type="button"
                className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                onClick={() =>
                  core.updateAgent(pairing.id, { shareTagNames: true }).catch(reportError)
                }
              >
                {t("agents.sorting.shareTags")}
              </button>
            </span>
          )}
          {skillOutOfDate && (
            <span data-testid="agent-pairing-skill-old" className="block">
              {replacing ? (
                <>
                  {t("agents.pairing.skillOld.ask")}
                  <span className="block">
                    <button
                      type="button"
                      data-testid="agent-skill-replace-confirm"
                      onKeyDown={closeOnEscape}
                      onClick={() =>
                        core
                          .replaceAgentSkill(pairing.id)
                          .then(() => setReplacing(false), reportError)
                      }
                      className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      {t("agents.pairing.skillOld.confirm")}
                    </button>
                    <span aria-hidden="true"> · </span>
                    <button
                      ref={keepButton}
                      type="button"
                      data-testid="agent-skill-replace-cancel"
                      onKeyDown={closeOnEscape}
                      onClick={() => setReplacing(false)}
                      className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      {t("agents.pairing.skillOld.cancel")}
                    </button>
                  </span>
                </>
              ) : (
                <>
                  {t("agents.pairing.skillOld")}
                  <span aria-hidden="true"> · </span>
                  <button
                    ref={replaceButton}
                    type="button"
                    data-testid="agent-skill-replace"
                    onClick={() => setReplacing(true)}
                    className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {t("agents.pairing.skillOld.replace")}
                  </button>
                </>
              )}
            </span>
          )}
          {shimOutOfDate && (
            <span data-testid="agent-pairing-shim-old" className="block">
              {isBundleClient ? (
                <>
                  {t("agents.pairing.shimOld.bundle")}
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    data-testid="agent-shim-reinstall"
                    onClick={() =>
                      core.openAgentInstallAgain(pairing.id).then(onInstallReopened, reportError)
                    }
                    className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {t("agents.pairing.installAgain")}
                  </button>
                </>
              ) : (
                t("agents.pairing.shimOld")
              )}
            </span>
          )}
          {done && (
            <p data-testid="agent-setup-done" role="status" className="mt-1">
              {doneWords(done, pairing, t)}
              {done.kind === "wrote" && (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    data-testid="agent-setup-undo"
                    onClick={() => core.undoAgentSetup(pairing.id).then(onUndone, reportError)}
                    className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {t("agents.done.undo")}
                  </button>
                </>
              )}
              {pairing.client && done.kind === "copy" && (
                <>
                  <span aria-hidden="true"> · </span>
                  <a
                    href={helpUrl(pairing.client as AgentClientId, language)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {t("agents.settings.help")}
                  </a>
                </>
              )}
            </p>
          )}
        </>
      }
      control={
        <>
          <button
            type="button"
            data-testid="agent-folders"
            aria-expanded={open === "folders"}
            onClick={() => toggle("folders")}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.pairing.folders")}
          </button>
          <button
            type="button"
            data-testid="agent-activity-toggle"
            aria-expanded={open === "activity"}
            onClick={() => toggle("activity")}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.pairing.activity")}
          </button>
          <button
            type="button"
            data-testid="agent-disconnect"
            onClick={() =>
              core
                .disconnectAgent(pairing.id)
                .then((left) => onDisconnected(pairingInSentence(pairing, t), left), reportError)
            }
            className={buttonStyle("ghost", "sm")}
          >
            {t("agents.pairing.disconnect")}
          </button>
        </>
      }
    >
      {open === "folders" && (
        <fieldset data-testid="agent-pairing-folders" className="mb-2 flex min-w-0 flex-col">
          <legend className="text-[13px] leading-5 font-semibold text-ink">
            {t("agents.pairing.foldersTitle", { agent: pairingInSentence(pairing, t) })}
          </legend>
          <AgentShareChoice
            all={all}
            onAll={setAll}
            rows={rows}
            chosen={new Set(chosen)}
            onToggle={setFolder}
          />
          <div className="mt-2">
            <ProposeChoice checked={propose} onChange={changePropose} noFolders={all} />
          </div>
        </fieldset>
      )}
      {open === "activity" && (
        <ol
          data-testid="agent-activity"
          className="mb-2 flex max-h-64 flex-col gap-1 overflow-y-auto"
        >
          {activity?.length === 0 && (
            <li className="text-[12px] leading-[18px] text-ink-meta">
              {t("agents.activity.empty")}
            </li>
          )}
          {activity?.map((call) => (
            <li
              key={call.id}
              data-testid="agent-activity-call"
              data-outcome={call.outcome}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[13px] leading-5"
            >
              <span className="text-ink-meta">{timeWords(call.at, language)}</span>
              <span className="break-words text-ink-secondary">{activityWords(call, t)}</span>
              {call.request !== null && (
                <details data-testid="agent-activity-request" className="col-start-2">
                  <summary className="cursor-pointer text-[12px] leading-[18px] text-ink-meta">
                    {t("agents.activity.request")}
                  </summary>
                  <p className="mt-1 text-[12px] leading-[18px] whitespace-pre-wrap break-words text-ink-secondary">
                    {call.request}
                  </p>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      <details>
        <summary className="cursor-pointer text-[12px] leading-[18px] text-ink-meta">
          {t("agents.pairing.details")}
        </summary>
        <button
          type="button"
          data-testid="agent-copy-settings"
          onClick={() => void copySettings("settings")}
          className={`${buttonStyle("ghost", "sm")} mt-1`}
        >
          {copied === "settings" ? t("agents.pairing.copied") : t("agents.pairing.copySettings")}
        </button>
        {takesParts(pairing.client) && <LaunchDetails pairingId={pairing.id} />}
        {!skillInstalled && (
          <>
            <button
              type="button"
              data-testid="agent-copy-skill"
              onClick={() => void copySettings("skill")}
              className={`${buttonStyle("ghost", "sm")} mt-1 ml-2`}
            >
              {copied === "skill" ? t("agents.pairing.copied") : t("agents.pairing.copySkill")}
            </button>
            <p className="mt-1 text-[12px] leading-[18px] text-ink-meta">
              {t("agents.pairing.copySkill.hint")}
            </p>
          </>
        )}
      </details>
    </SettingsRow>
  );
}

/**
 * An agent's name, renamed in place as everywhere (a double-click or F2):
 * Enter or leaving the field saves, Esc cancels, and an empty name changes
 * nothing. Enter while a Chinese input method is composing only composes.
 */
function RenameAgent({ pairing, onDone }: { pairing: AgentPairing; onDone(): void }) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [value, setValue] = useState(pairing.name);
  const field = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = value.trim();
    if (save && name && name !== pairing.name) {
      core.updateAgent(pairing.id, { name }).catch(reportError);
    }
    onDone();
  };

  return (
    <input
      ref={field}
      value={value}
      data-testid="agent-pairing-rename"
      aria-label={t("agents.pairing.renameLabel", { agent: pairingInSentence(pairing, t) })}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" || event.key === "Escape") {
          // Esc ends the renaming, not Settings.
          event.preventDefault();
          event.stopPropagation();
          finish(event.key === "Enter");
        }
      }}
      onBlur={() => finish(true)}
      className={`${rowFieldClass} w-56 max-w-full`}
    />
  );
}
