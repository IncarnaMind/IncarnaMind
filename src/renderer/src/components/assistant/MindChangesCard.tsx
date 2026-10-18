import { useMemo } from "react";
import type { ConversationAnswer, ConversationQuestion } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { useAskedChanges } from "../../askedChanges";
import { type ChangedMind, changedMinds } from "../../changedMinds";
import { changeFact, leftText } from "../../changeFacts";
import { askInAssistant } from "../../conversations";
import { useT } from "../../i18n";
import { resolveAllChanges, showChanges, useWaitingChanges, type Waiting } from "../../mindChanges";
import type { Translate } from "../../objects";
import { useAppStore } from "../../store";
import { MindLineIcon, PencilLineIcon } from "../lineIcons";
import { AskedChangesCard } from "./AskedChangesCard";

/** The names of Minds seen in a card, for a row whose Mind has since been removed. */
const seenNames = new Map<string, string>();

/** What an Answer did in one Mind, from its calls: the same counts the Mind's own line shows. */
function factText(t: Translate, row: ChangedMind, name: string, waiting: Waiting) {
  if (waiting === "gone") return t("mindChanges.one.removed", { mind: name });
  return changeFact(t, row, name);
}

/** What of its tables was kept as text, and what sources were left out, after its count; null when nothing was. */
function keptText(t: Translate, row: ChangedMind): string | null {
  const notes = [
    ...(row.unlinkedSources === 1
      ? [t("mindChanges.unlinked.one")]
      : row.unlinkedSources > 1
        ? [t("mindChanges.unlinked", { count: row.unlinkedSources })]
        : []),
    ...(row.droppedSources === 1
      ? [t("mindChanges.dropped.one")]
      : row.droppedSources > 1
        ? [t("mindChanges.dropped", { count: row.droppedSources })]
        : []),
    ...(row.extraCells === 1
      ? [t("mindChanges.extraCells.one")]
      : row.extraCells > 1
        ? [t("mindChanges.extraCells", { count: row.extraCells })]
        : []),
  ];
  return notes.length > 0 ? notes.join(" ") : null;
}

/**
 * The card under the reply of an Answer that changed Minds (#202, D148):
 * what its calls did, from their record rather than the reply's words.
 * "2 Minds changed · Review", a row for each Mind ("Edited: Q3 review · 4
 * waiting") with Open, then Accept all · Reject all while changes wait. For
 * one Mind, its row is the card's head: "Changed 3 places in “Q3 review” · 3
 * waiting · Review". Review and Open show the Mind at its first change;
 * Accept all and Reject all offer Undo on the Answer's line. Rejecting a Mind
 * the Answer made removes it.
 */
export function MindChangesCard({
  answer,
  streaming,
}: {
  answer: Pick<ConversationAnswer, "id" | "toolCalls">;
  /** Changes may still come: Accept all and Reject all wait for the Answer to end. */
  streaming: boolean;
}) {
  const t = useT();
  const rows = useMemo(() => changedMinds(answer), [answer]);
  const waiting = useWaitingChanges(rows);
  const minds = useAppStore((state) => state.minds);
  const asked = useAskedChanges((state) => state.outcomes[answer.id]);
  if (rows.length === 0) return null;

  const nameOf = (row: ChangedMind) => {
    const mind = minds.find((each) => each.id === row.mindId);
    const name = (mind && mindName(mind)) || seenNames.get(row.mindId) || t("mind.untitled");
    if (mind) seenNames.set(row.mindId, name);
    return name;
  };
  if (asked) {
    return (
      <AskedChangesCard
        answerId={answer.id}
        rows={rows}
        outcomes={asked}
        waiting={waiting}
        nameOf={nameOf}
      />
    );
  }
  const counted = (index: number) => {
    const count = waiting[index];
    return typeof count === "number" ? count : 0;
  };
  const total = rows.reduce((sum, _, index) => sum + counted(index), 0);
  const first = rows.find((_, index) => counted(index) > 0);
  const [only] = rows;
  const head =
    rows.length === 1 && only
      ? factText(t, only, nameOf(only), waiting[0] ?? null)
      : t("mindChanges.minds", { count: rows.length });
  const headLeft = rows.length === 1 && only ? leftText(t, only, waiting[0] ?? null) : null;
  const headKept = rows.length === 1 && only ? keptText(t, only) : null;

  return (
    <section
      aria-label={[head, headLeft, headKept].filter(Boolean).join(" ")}
      data-testid="mind-changes"
      className="mind-changes"
    >
      <div className="mind-changes-head">
        <PencilLineIcon aria-hidden="true" className="mind-changes-icon" />
        <p className="mind-changes-line">
          <span data-testid="mind-changes-title" className="mind-changes-title">
            {head}
          </span>
          {headLeft && (
            <>
              {" "}
              <span data-testid="mind-changes-left" className="mind-changes-count">
                {headLeft}
              </span>
            </>
          )}
          {headKept && (
            <>
              {" "}
              <span data-testid="mind-changes-kept" className="mind-changes-count">
                {headKept}
              </span>
            </>
          )}
          {first && (
            <>
              <span aria-hidden="true" className="mind-changes-dot">
                {" · "}
              </span>
              <button
                type="button"
                data-testid="mind-changes-review"
                onClick={() => showChanges(first)}
                className="mind-changes-review"
              >
                {t("mindChanges.review")}
              </button>
            </>
          )}
        </p>
      </div>
      {rows.length > 1 &&
        rows.map((row, index) => {
          const count = waiting[index] ?? null;
          const name = nameOf(row);
          // Its name first, so a narrow panel cuts the verb rather than the name; the fact is on hover.
          const label =
            count === "gone"
              ? t("mindChanges.row.removed", { mind: name })
              : t(row.created ? "mindChanges.row.created" : "mindChanges.row.edited", {
                  mind: name,
                });
          const kept = keptText(t, row);
          const fact = [factText(t, row, name, count), kept].filter(Boolean).join(" ");
          const left = leftText(t, row, count);
          return (
            <div
              key={row.mindId}
              data-testid="mind-changes-row"
              data-created={row.created || undefined}
              className="mind-changes-row"
            >
              <MindLineIcon aria-hidden="true" className="mind-changes-icon" />
              <span className="mind-changes-name" title={fact}>
                {label}
              </span>
              {left && (
                <span data-testid="mind-changes-left" className="mind-changes-count">
                  {left}
                </span>
              )}
              <span className="flex-1" />
              {count !== "gone" && (
                <button
                  type="button"
                  data-testid="mind-changes-open"
                  aria-label={`${t("mindChanges.open")} ${name}`}
                  onClick={() => showChanges(row)}
                  className="mind-changes-action"
                >
                  {t("mindChanges.open")}
                </button>
              )}
            </div>
          );
        })}
      {total > 0 && !streaming && (
        <div className="mind-changes-foot">
          <button
            type="button"
            data-testid="mind-changes-accept-all"
            onClick={() => void resolveAllChanges(answer.id, rows, "accept")}
            className="mind-changes-accept"
          >
            {t("proposal.acceptAll")}
          </button>
          <button
            type="button"
            data-testid="mind-changes-reject-all"
            onClick={() => void resolveAllChanges(answer.id, rows, "reject")}
            className="mind-changes-action"
          >
            {t("proposal.rejectAll")}
          </button>
        </div>
      )}
    </section>
  );
}

/** Whether an Answer tried to change the Mind in focus, and there was none. */
export function wantedAMind(answer: Pick<ConversationAnswer, "toolCalls">): boolean {
  return answer.toolCalls.some(
    (call) =>
      call.source === "minds" &&
      call.status === "failed" &&
      (call.tool === "edit_mind" || call.tool === "add_to_mind") &&
      typeof call.input.mind !== "string",
  );
}

/**
 * Under an Answer asked with no Mind in focus that tried to change one
 * (#202): it says so, and offers New Mind, which makes one (in the Folder of
 * the Question's Search scope, when that is one Folder) and asks the
 * Question again from it, so the change goes there.
 */
export function NoMindLine({ question }: { question: ConversationQuestion }) {
  const t = useT();
  const { scope } = question;
  const folderId =
    scope && scope.folderIds.length === 1 && scope.tagIds.length + scope.documentIds.length === 0
      ? (scope.folderIds[0] ?? null)
      : null;
  const askInNewMind = () =>
    void useAppStore.getState().createMind({
      folderId,
      made: (mindId) =>
        void askInAssistant({
          mindId,
          text: question.text,
          scope,
          model: question.model,
          forcedSkill: question.forcedSkill,
        }),
    });
  return (
    <p data-testid="mind-changes-no-mind" className="mind-changes-no-mind">
      {t("mindChanges.noMind")}
      <button
        type="button"
        data-testid="mind-changes-new-mind"
        onClick={askInNewMind}
        className="mind-changes-review"
      >
        {t("sidebar.newMind")}
      </button>
    </p>
  );
}
