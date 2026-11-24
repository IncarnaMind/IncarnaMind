import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AgentDisconnected, AgentPairing } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { buttonStyle } from "../ui";
import { pairingInSentence } from "./agentWords";

const REPAIR_TARGET = ["repair-all-agents"] as const;
const DISCONNECT_TARGET = ["disconnect-all-agents"] as const;

/**
 * The connected AI apps whose entry starts a program that has gone since (#3644), read as
 * Settings › AI opens and as the agents change: null until first read. `read` reads them again,
 * as after a Repair.
 */
export function useAgentsNeedingRepair(pairings: readonly AgentPairing[]) {
  const reportError = useAppStore((state) => state.reportError);
  const [needs, setNeeds] = useState<ReadonlySet<string> | null>(null);
  const ids = pairings.map((pairing) => pairing.id).join(" ");
  const latest = useRef(0);
  const read = useCallback(() => {
    const reading = ++latest.current;
    const each = ids === "" ? [] : ids.split(" ");
    return Promise.all(each.map((id) => core.agentNeedsRepair(id))).then(
      (answers) => {
        if (reading === latest.current) setNeeds(new Set(each.filter((_, at) => answers[at])));
      },
      (error: unknown) => {
        if (reading === latest.current) setNeeds(new Set());
        reportError(error);
      },
    );
  }, [ids, reportError]);
  useEffect(() => {
    void read();
    return core.on("agents.changed", () => void read());
  }, [read]);
  return { needs, read };
}

/** Repair all (N), while two or more AI apps need it: writes each one's entry again. */
export function RepairAll({
  ids,
  ready,
  onRepaired,
}: {
  ids: readonly string[];
  /** Which apps need repair has been read, so ⌘K's entry can land on the button. */
  ready: boolean;
  onRepaired(): void;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [busy, setBusy] = useState(false);
  const repair = async () => {
    setBusy(true);
    for (const id of ids) await core.repairAgent(id).catch(reportError);
    setBusy(false);
    onRepaired();
  };
  const button: RefObject<HTMLButtonElement | null> = useSettingsTarget<HTMLButtonElement>(
    REPAIR_TARGET,
    ready,
    () => button.current?.focus(),
  );
  if (ids.length < 2) return null;
  return (
    <button
      ref={button}
      type="button"
      data-testid="agents-repair-all"
      disabled={busy}
      onClick={() => void repair()}
      className={buttonStyle("secondary", "sm")}
    >
      {t("agents.settings.repairAll", { count: ids.length })}
    </button>
  );
}

export interface LeftBehind {
  agent: string;
  left: AgentDisconnected;
}

/**
 * Disconnect all…, while two or more AI apps are connected. It asks first, in place: an app set
 * up by a pasted line or by a press in the app can't be put back by an Undo (#3644).
 */
export function DisconnectAll({
  pairings,
  onDisconnected,
}: {
  pairings: readonly AgentPairing[];
  onDisconnected(left: LeftBehind[]): void;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (asking) keep.current?.focus();
    else if (asked.current) opener.current?.focus();
    asked.current = asking;
  }, [asking]);

  const target = useSettingsTarget<HTMLParagraphElement>(DISCONNECT_TARGET, true, () => {
    if (pairings.length > 1) setAsking(true);
  });

  const closeOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape") return;
    // Esc closes the question, not Settings.
    event.preventDefault();
    event.stopPropagation();
    setAsking(false);
  };

  const disconnect = async () => {
    setBusy(true);
    const left: LeftBehind[] = [];
    // One after another: two connections can share a settings file, and apps share Skill folders.
    for (const pairing of pairings) {
      await core
        .disconnectAgent(pairing.id)
        .then(
          (each) => left.push({ agent: pairingInSentence(pairing, t), left: each }),
          reportError,
        );
    }
    setBusy(false);
    asked.current = false;
    setAsking(false);
    onDisconnected(left);
  };

  if (pairings.length < 2) return null;
  return (
    <div data-testid="agents-disconnect-all" className="px-4">
      <p ref={target}>
        <button
          ref={opener}
          type="button"
          data-testid="agents-disconnect-all-open"
          aria-expanded={asking}
          onClick={() => setAsking(true)}
          className="rounded-sm text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline"
        >
          {t("agents.settings.disconnectAll")}
        </button>
      </p>
      {asking && (
        <div
          data-testid="agents-disconnect-all-ask"
          className="mt-2 rounded-lg bg-wash px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-rule)]"
        >
          <p className="mb-2 text-[13px] leading-5 text-ink-secondary">
            {t("agents.settings.disconnectAll.ask", { count: pairings.length })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="agents-disconnect-all-confirm"
              disabled={busy}
              onKeyDown={closeOnEscape}
              onClick={() => void disconnect()}
              className={buttonStyle("primary", "sm")}
            >
              {t("agents.settings.disconnectAll.confirm")}
            </button>
            <button
              ref={keep}
              type="button"
              data-testid="agents-disconnect-all-keep"
              disabled={busy}
              onKeyDown={closeOnEscape}
              onClick={() => setAsking(false)}
              className={buttonStyle("secondary", "sm")}
            >
              {t("agents.settings.disconnectAll.keep")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
