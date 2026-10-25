import { useState } from "react";
import type { ConversationAnswer } from "../../../../core/api";
import { mindCheckOf } from "../../../../shared/mindCheck";
import { checkSentences } from "../../checks";
import { toCheckRanges } from "../../editor/healthCounts";
import { mindEditor, whenMindEditor } from "../../editor/openEditors";
import { editorDoc } from "../../editor/proposalReview";
import { useLanguage, useT } from "../../i18n";
import { selfCheckLines, selfChecksOf } from "../../selfChecks";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";

const OPEN_WAIT_MS = 10_000;

/** Checks every sentence the Mind still has to check (#1909), so the badge's count closes. */
async function checkLeft(mindId: string): Promise<void> {
  useAppStore.getState().openMind(mindId);
  const editor = mindEditor(mindId) ?? (await whenMindEditor(mindId, OPEN_WAIT_MS));
  const doc = editor && editorDoc(editor);
  if (!editor || !doc) return;
  const skipped = new Set(mindCheckOf(doc)?.skipped ?? []);
  const ranges = toCheckRanges(editor.state, skipped);
  if (ranges.length > 0) {
    await checkSentences(editor, mindId, doc, "check-against-documents", { ranges });
  }
}

/**
 * Under an Answer that wrote sentences with Citations into a Mind (#1111):
 * how many its check couldn't check, with Check again, or why not (the
 * spending cap, with Change the cap; a plan's limit, with when it resumes),
 * and how many it checked when there were more than one write checks, with
 * Check the rest. Check again and Check the rest check those left in their Mind now.
 */
export function SelfCheckLines({ answer }: { answer: Pick<ConversationAnswer, "toolCalls"> }) {
  const t = useT();
  const language = useLanguage();
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  return selfChecksOf(answer.toolCalls).map((check) => {
    const { mindId, request } = check;
    if (asked.has(request)) return null;
    const checkNow = () => {
      setAsked((before) => new Set([...before, request]));
      checkLeft(mindId).catch(useAppStore.getState().reportError);
    };
    return (
      <div key={request}>
        {selfCheckLines(check, t, language).map((line) => (
          <ProblemLine
            key={line.kind}
            role="status"
            testId={`self-check-${line.kind}`}
            details={line.details}
            action={
              line.action
                ? {
                    label: line.action.label,
                    testId: `self-check-${line.kind}-action`,
                    onClick:
                      line.action.does === "check"
                        ? checkNow
                        : () => useAppStore.getState().openSettings("general"),
                  }
                : undefined
            }
          >
            {line.text}
          </ProblemLine>
        ))}
      </div>
    );
  });
}
