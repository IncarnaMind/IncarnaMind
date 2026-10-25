import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import type { ConversationAnswer } from "../../../../core/api";
import { mindCheckOf } from "../../../../shared/mindCheck";
import { checkSentences } from "../../checks";
import { originOf } from "../../editor/blockOrigins";
import { type SentencePlace, toCheckRanges } from "../../editor/healthCounts";
import { mindEditor, whenMindEditor } from "../../editor/openEditors";
import { editorDoc } from "../../editor/proposalReview";
import { useLanguage, useT } from "../../i18n";
import { type SelfCheck, selfCheckLines, selfChecksOf } from "../../selfChecks";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";

const OPEN_WAIT_MS = 10_000;

/** A sentence this write left: in one of its Blocks, still carrying its origin (#1909). */
function inWrite(editor: Editor, blocks: ReadonlySet<string>) {
  return (place: SentencePlace) =>
    typeof place.blockId === "string" &&
    blocks.has(place.blockId) &&
    originOf(editor.state, place.blockId) !== null;
}

/** The sentences this write still has to check now, by the one count. */
function writeRanges(editor: Editor, blocks: ReadonlySet<string>): { from: number; to: number }[] {
  const doc = editorDoc(editor);
  if (!doc) return [];
  const skipped = new Set(mindCheckOf(doc)?.skipped ?? []);
  return toCheckRanges(editor.state, skipped, inWrite(editor, blocks));
}

/** Checks the sentences this write left, and nothing of the Mind's own older text. */
async function checkLeft(mindId: string, blocks: ReadonlySet<string>): Promise<void> {
  useAppStore.getState().openMind(mindId);
  const editor = mindEditor(mindId) ?? (await whenMindEditor(mindId, OPEN_WAIT_MS));
  const doc = editor && editorDoc(editor);
  if (!editor || !doc) return;
  const ranges = writeRanges(editor, blocks);
  if (ranges.length > 0) {
    await checkSentences(editor, mindId, doc, "check-against-documents", { ranges });
  }
}

/** The claims this write still has to check, live from its Blocks; null while its Mind isn't open. */
function useWriteLeft(mindId: string, blocksKey: string): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (blocksKey === "") {
      setLeft(null);
      return;
    }
    const blocks = new Set(blocksKey.split(" "));
    let current = true;
    let listening: Editor | null = null;
    let known: Editor | null = null;
    const compute = () => {
      if (current && known) setLeft(writeRanges(known, blocks).length);
    };
    const attach = (editor: Editor) => {
      if (!current) return;
      known = editor;
      listening = editor;
      compute();
      editor.on("transaction", compute);
    };
    const open = mindEditor(mindId);
    if (open) attach(open);
    else {
      void whenMindEditor(mindId, OPEN_WAIT_MS).then((editor) => {
        if (editor) attach(editor);
      });
    }
    return () => {
      current = false;
      listening?.off("transaction", compute);
    };
  }, [mindId, blocksKey]);
  return left;
}

/**
 * Under an Answer that wrote sentences with Citations into a Mind (#1111):
 * how many its check couldn't check, with Check again, or why not (the
 * spending cap, with Change the cap; a plan's limit, with when it resumes),
 * and how many it left, with Check the rest. Both act on this write's own
 * Blocks alone, and its left count is the badge's count for those sentences;
 * the Mind's other text is Check this Mind's.
 */
export function SelfCheckLines({ answer }: { answer: Pick<ConversationAnswer, "toolCalls"> }) {
  return (
    <>
      {selfChecksOf(answer.toolCalls).map((check) => (
        <SelfCheckGroup key={check.request} check={check} />
      ))}
    </>
  );
}

function SelfCheckGroup({ check }: { check: SelfCheck }) {
  const t = useT();
  const language = useLanguage();
  const blocksKey = check.blocks?.join(" ") ?? "";
  const left = useWriteLeft(check.mindId, blocksKey);
  const checkNow =
    blocksKey === ""
      ? null
      : () => {
          void checkLeft(check.mindId, new Set(blocksKey.split(" "))).catch(
            useAppStore.getState().reportError,
          );
        };
  return (
    <div>
      {selfCheckLines(check, t, language, new Date(), left).map((line) => {
        const action =
          line.action && line.action.does === "check" && checkNow
            ? {
                label: line.action.label,
                testId: `self-check-${line.kind}-action`,
                onClick: checkNow,
              }
            : line.action && line.action.does !== "check"
              ? {
                  label: line.action.label,
                  testId: `self-check-${line.kind}-action`,
                  onClick: () => useAppStore.getState().openSettings("general"),
                }
              : undefined;
        return (
          <ProblemLine
            key={line.kind}
            role="status"
            testId={`self-check-${line.kind}`}
            details={line.details}
            action={action}
          >
            {line.text}
          </ProblemLine>
        );
      })}
    </div>
  );
}
