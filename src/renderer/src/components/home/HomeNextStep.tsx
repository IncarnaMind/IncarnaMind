import { useCallback, useMemo, useRef, useState } from "react";
import { formatDateTime } from "../../../../shared/dates";
import { mindName } from "../../../../shared/naming";
import { addAnswer } from "../../addToNote";
import { notesToAdd } from "../../answerEditors";
import { homeNextHandle, useHandle } from "../../commands/handles";
import { commands } from "../../commands/registry";
import { conversationById, openConversation, useConversations } from "../../conversations";
import { files } from "../../core";
import { exportMind, useExports } from "../../exports";
import type { HomeNextStep as Step } from "../../homeNextStep";
import { useLanguage, useT } from "../../i18n";
import { saidInLine } from "../../lineNames";
import { showCheckCard, startCheckThisMind } from "../../mindCheck";
import { useAppStore } from "../../store";

/** Opens the Mind where Home is, once its tab is in the layout: its card and result line need it there. */
const openInPlace = async (mindId: string): Promise<void> => {
  await useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "place" },
  });
};

export function HomeNextStep({ step }: { step: Step }) {
  const t = useT();
  const language = useLanguage();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const said = saidInLine(t, (t) => {
    const note = "note" in step ? step.note : null;
    const state = note?.state;
    // Amber for an unread file in the check's own scope, with no claim to look at: the badge's words.
    if (step.kind === "look" && state && state.look === 0 && state.unread > 0) {
      return t("home.next.unread", {
        mind: mindName(note.mind) || t("mind.untitled"),
        files: t(state.unread === 1 ? "unread.count.one" : "unread.count", {
          count: new Intl.NumberFormat(language).format(state.unread),
        }),
      });
    }
    return t(`home.next.${step.kind}`, {
      mind: note ? mindName(note.mind) || t("mind.untitled") : "",
      count:
        "count" in step
          ? step.kind === "check"
            ? t(step.count === 1 ? "health.toCheck.one" : "health.toCheck", {
                count: new Intl.NumberFormat(language).format(step.count),
              })
            : new Intl.NumberFormat(language).format(step.count)
          : "",
      time: step.kind === "exported" ? formatDateTime(step.saved.at, language) : "",
    });
  });
  const label = said.fullMessage ?? said.message;
  const run = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const store = useAppStore.getState();
    try {
      switch (step.kind) {
        case "add":
          await store.pickDocuments();
          break;
        case "ask":
          await commands.run("composer.focus");
          break;
        case "write": {
          await openConversation(step.answer.conversationId, step.answer.id);
          const current = useConversations.getState();
          const answer = current.messages.find((message) => message.id === step.answer.id);
          if (
            current.openId !== step.answer.conversationId ||
            answer?.kind !== "answer" ||
            answer.status !== "done"
          )
            break;
          await addAnswer(
            {
              answer,
              conversation: conversationById(answer.conversationId),
              blocks: notesToAdd(answer),
            },
            { kind: "new" },
          );
          break;
        }
        case "check":
          await startCheckThisMind(step.note.mind.id);
          break;
        case "look":
          await openInPlace(step.note.mind.id);
          showCheckCard(step.note.mind.id);
          break;
        case "export":
          await openInPlace(step.note.mind.id);
          await exportMind(step.note.mind.id, "docx");
          break;
        case "exported":
          await files.openSavedFile(step.saved.path);
          useExports.getState().dismiss();
          break;
      }
    } catch (error) {
      store.reportError(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [step]);
  const handle = useMemo(() => ({ label, busy, run }), [label, busy, run]);
  useHandle(homeNextHandle, handle);
  return (
    <button
      type="button"
      data-testid="home-next-step"
      data-step={step.kind}
      disabled={busy}
      aria-label={label}
      title={label}
      onClick={() => void run()}
      className="max-w-full min-w-0 rounded-sm text-left font-semibold break-words text-ink underline-offset-2 hover:underline hover:decoration-rule-strong disabled:opacity-50"
    >
      {said.message}
    </button>
  );
}
