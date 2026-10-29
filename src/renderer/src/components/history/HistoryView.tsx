import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CheckpointList, MindComparison } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useHistory } from "../../history";
import { reasonLabel, versionLabel } from "../../historyLabels";
import { languageNow, translateNow, useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { useUndo } from "../../undo";
import { CloseLineIcon, HistoryLineIcon, RestoreLineIcon } from "../lineIcons";
import { ProblemLine } from "../ProblemLine";
import { UndoLineAt } from "../UndoLine";
import { buttonStyle, iconButtonClass } from "../ui";
import { useModal } from "../useModal";
import { ComparedRows } from "./ComparedRows";
import { VersionName } from "./VersionName";
import { VersionPicker } from "./VersionPicker";
import { HISTORY_UNDO_PLACE } from "./versionNames";

/** How long the Mind stays unchanged before a comparison with now is made again. */
const REFRESH_MS = 300;

/**
 * History (#113): the whole window over the Mind, which stays as it was
 * underneath. A version picked on the left beside the Mind now (or another
 * version) on the right, and Restore, which brings the left one back as a
 * new change that ⌘Z takes back. Esc, or ✕, closes it.
 */
export function HistoryView() {
  const mindId = useHistory((state) => state.mindId);
  const close = useHistory((state) => state.close);
  const dialog = useModal(mindId !== null);
  return (
    <dialog ref={dialog} onClose={close} data-testid="history" className="history">
      {mindId && <History key={mindId} mindId={mindId} onClose={close} />}
    </dialog>
  );
}

function History({ mindId, onClose }: { mindId: string; onClose(): void }) {
  const t = useT();
  const language = useLanguage();
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const [list, setList] = useState<CheckpointList | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const [comparison, setComparison] = useState<MindComparison | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [naming, setNaming] = useState(false);
  /** What had the focus when naming began, and the name's own button: where Enter and Esc go back to. */
  const namingFrom = useRef<HTMLElement | null>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const startNaming = () => {
    const active = document.activeElement;
    namingFrom.current = active instanceof HTMLElement ? active : null;
    setNaming(true);
  };
  const wasNaming = useRef(false);
  useLayoutEffect(() => {
    // The field went with the focus in it (Enter or Esc), not by a click elsewhere, which keeps it.
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (wasNaming.current && !naming && lost) {
      const from = namingFrom.current;
      (from?.isConnected ? from : nameButton.current)?.focus();
    }
    wasNaming.current = naming;
  }, [naming]);
  /** Set when a new pair of versions is chosen, so their first change is scrolled to once. */
  const scrollPending = useRef(true);

  // A Mind deleted meanwhile has no History to show.
  useEffect(() => {
    if (!mind) onClose();
  }, [mind, onClose]);

  const loadList = useCallback(() => {
    core.listCheckpoints(mindId).then(
      (loaded) => {
        setList(loaded);
        const kept = (id: string | null) => loaded.checkpoints.some((each) => each.id === id);
        // At first, and once the one chosen has thinned out, the newest version that isn't the Mind as it is now.
        setLeft((chosen) =>
          kept(chosen)
            ? chosen
            : (loaded.checkpoints.find((each) => each.id !== loaded.current)?.id ??
              loaded.checkpoints[0]?.id ??
              null),
        );
        setRight((chosen) => (kept(chosen) ? chosen : null));
      },
      (error: unknown) => setProblem(errorMessage(error, translateNow)),
    );
  }, [mindId]);

  useEffect(() => {
    loadList();
    return core.on("checkpoints.changed", (event) => {
      if (event.mindId === mindId) loadList();
    });
  }, [mindId, loadList]);

  /** The latest comparison asked for: an earlier one that answers later is left unused. */
  const asked = useRef(0);
  const compare = useCallback(() => {
    if (!left) return;
    const request = ++asked.current;
    core.compareCheckpoints({ mindId, from: left, to: right }).then(
      (compared) => {
        if (request !== asked.current) return;
        setComparison(compared);
        setProblem(null);
      },
      (error: unknown) => {
        if (request === asked.current) setProblem(errorMessage(error, translateNow));
      },
    );
  }, [mindId, left, right]);

  useEffect(() => {
    scrollPending.current = true;
    compare();
  }, [compare]);

  // The Mind now changes underneath (an Answer being written, another window): compared again.
  useEffect(() => {
    if (right !== null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = core.on("mind.update", (event) => {
      if (event.mindId !== mindId) return;
      clearTimeout(timer);
      timer = setTimeout(compare, REFRESH_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [mindId, right, compare]);

  const firstChange = useCallback((row: HTMLElement | null) => {
    if (!row || !scrollPending.current) return;
    scrollPending.current = false;
    row.scrollIntoView({ block: "center" });
  }, []);

  const checkpoints = list?.checkpoints ?? [];
  const leftCheckpoint = checkpoints.find((each) => each.id === left) ?? null;
  const rightCheckpoint = checkpoints.find((each) => each.id === right) ?? null;
  const now = new Date();
  const nameOf = (checkpoint: typeof leftCheckpoint) =>
    checkpoint ? versionLabel(checkpoint, now, language, t) : t("history.now");
  const same = comparison !== null && comparison.changes === 0;
  /** The left version reads as the Mind does now: restoring it would change nothing. */
  const nothingToRestore = same && right === null;
  const title = mind ? mindName(mind) || t("mind.untitled") : "";

  const restore = async () => {
    if (!leftCheckpoint || restoring) return;
    setRestoring(true);
    try {
      const { before, checkedLeftOut } = await core.restoreCheckpoint(mindId, leftCheckpoint.id);
      const restoredAt = new Date();
      const restoredId = leftCheckpoint.id;
      useUndo.getState().push({
        said: (t) => {
          const version = versionLabel(leftCheckpoint, restoredAt, languageNow(), t);
          if (checkedLeftOut === 0) return t("history.restored", { version });
          const params = { version, count: checkedLeftOut };
          return checkedLeftOut === 1
            ? t("history.restored.leftOut.one", params)
            : t("history.restored.leftOut", params);
        },
        name: (t) => t("history.restored.name"),
        undo: async () => {
          await core.restoreCheckpoint(mindId, before.id);
        },
        redo: async () => {
          await core.restoreCheckpoint(mindId, restoredId);
        },
      });
      onClose();
    } catch (error) {
      setProblem(errorMessage(error, translateNow));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <header className="history-bar title-bar">
        <div className="history-bar-half">
          <h1 className="history-title">
            <HistoryLineIcon className="history-icon" />
            <span className="sr-only">{t("history.title", { title })}</span>
            <span aria-hidden="true" title={title} className="min-w-0 truncate">
              {title}
            </span>
          </h1>
          {/* Enabled while the list loads, so it takes the focus as History opens. F2 names it. */}
          <VersionPicker
            side="left"
            checkpoints={checkpoints}
            chosen={left}
            onChoose={(id) => {
              setNaming(false);
              setLeft(id);
            }}
            onRename={leftCheckpoint ? startNaming : undefined}
            disabled={list !== null && checkpoints.length === 0}
          />
        </div>
        <div className="history-bar-half" data-side="right">
          <VersionPicker
            side="right"
            checkpoints={checkpoints}
            chosen={right}
            onChoose={setRight}
          />
          <span className="flex-1" />
          <button
            type="button"
            data-testid="history-restore"
            disabled={!leftCheckpoint || nothingToRestore || restoring}
            title={nothingToRestore ? t("history.restore.same") : t("history.restore.hint")}
            onClick={() => void restore()}
            className={buttonStyle("primary", "sm")}
          >
            <RestoreLineIcon className="history-icon" />
            {t("history.restore")}
          </button>
          <button
            type="button"
            data-testid="history-close"
            aria-label={t("history.close")}
            title={t("history.close")}
            onClick={onClose}
            className={iconButtonClass}
          >
            <CloseLineIcon className="size-4" />
          </button>
        </div>
      </header>
      <main
        data-testid="history-compare"
        aria-label={t("history.compared", {
          left: [nameOf(leftCheckpoint), leftCheckpoint && reasonLabel(leftCheckpoint, t)]
            .filter(Boolean)
            .join(", "),
          right: nameOf(rightCheckpoint),
        })}
        className="history-card"
      >
        {/* The left version's name, typed where it shows, and the line that takes it back. */}
        {leftCheckpoint && (
          <div className="history-version-line">
            <VersionName
              mindId={mindId}
              checkpoint={leftCheckpoint}
              naming={naming}
              button={nameButton}
              onNaming={(next) => (next ? startNaming() : setNaming(false))}
              onNamed={(named) =>
                setList(
                  (shown) =>
                    shown && {
                      ...shown,
                      checkpoints: shown.checkpoints.map((each) =>
                        each.id === named.id ? named : each,
                      ),
                    },
                )
              }
            />
            <UndoLineAt place={HISTORY_UNDO_PLACE} className="history-undo" />
          </div>
        )}
        {problem && (
          <ProblemLine testId="history-problem" className="history-note">
            {problem}
          </ProblemLine>
        )}
        {list && checkpoints.length === 0 ? (
          <p data-testid="history-empty" className="history-note">
            {t("history.empty")}
          </p>
        ) : (
          comparison && (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes the focus to scroll by keys.
            <div tabIndex={0} data-testid="history-scroller" className="history-scroller">
              {same && (
                <p role="status" data-testid="history-same" className="history-note">
                  {t("history.noChanges")}
                </p>
              )}
              <ComparedRows mindId={mindId} comparison={comparison} firstChange={firstChange} />
            </div>
          )
        )}
      </main>
    </>
  );
}
