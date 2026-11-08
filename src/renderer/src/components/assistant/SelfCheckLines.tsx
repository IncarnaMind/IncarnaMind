import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useState } from "react";
import type { ConversationAnswer } from "../../../../core/api";
import { mindCheckOf } from "../../../../shared/mindCheck";
import { setCheckCardOpen, setOpenClaim } from "../../checks";
import { useChecksWaitForConsent } from "../../checksConsent";
import { originOf } from "../../editor/blockOrigins";
import { markOf, type ShownClaim, shownClaims } from "../../editor/claimChecks";
import { type SentencePlace, toCheckRanges } from "../../editor/healthCounts";
import { mindEditor, whenMindEditor } from "../../editor/openEditors";
import { opinionSentenceRanges } from "../../editor/opinionLocations";
import { editorDoc } from "../../editor/proposalReview";
import { useLanguage, useT } from "../../i18n";
import { frontTabOfMind, groupsMerged } from "../../layoutSlice";
import { startCheckAsking } from "../../mindCheck";
import { type SelfCheck, selfCheckLines, selfChecksOf } from "../../selfChecks";
import { useAppStore } from "../../store";
import { useWrittenProgress } from "../../writtenChecks";
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
  return toCheckRanges(
    editor.state,
    skipped,
    inWrite(editor, blocks),
    opinionSentenceRanges(editor.state.doc, doc),
  );
}

/** The claims this write still has to check, live from its Blocks; null while its Note isn't open. */
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

/** Whether a sentence's check found it needs a look: unsupported or contradicted. */
const needsLook = (claim: ShownClaim) =>
  markOf(claim) === "unsupported" || claim.shown.state === "contradicted";

/** The sentences this write's check found need a look, live from its Note; null while its Note isn't open. */
function useWriteLook(mindId: string, request: string): number | null {
  const [look, setLook] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    let detach: (() => void) | undefined;
    const attach = (editor: Editor) => {
      const count = () =>
        setLook(
          shownClaims(editor.state).filter(
            (claim) => claim.check.request === request && needsLook(claim),
          ).length,
        );
      count();
      editor.on("transaction", count);
      detach = () => editor.off("transaction", count);
    };
    const open = mindEditor(mindId);
    if (open) attach(open);
    else {
      void whenMindEditor(mindId, OPEN_WAIT_MS).then((editor) => {
        if (editor && current) attach(editor);
      });
    }
    return () => {
      current = false;
      detach?.();
    };
  }, [mindId, request]);
  return look;
}

/** Opens the Note at the next sentence of this write that needs a look, with its card open. */
async function showLook(mindId: string, request: string): Promise<void> {
  useAppStore.getState().openMind(mindId);
  const editor = mindEditor(mindId) ?? (await whenMindEditor(mindId, OPEN_WAIT_MS));
  if (!editor || editor.isDestroyed) return;
  const looks = shownClaims(editor.state).filter(
    (claim) => claim.check.request === request && needsLook(claim),
  );
  const head = editor.state.selection.head;
  const next = looks.find((claim) => claim.sentence.from > head) ?? looks[0];
  if (!next) return;
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.near(editor.state.doc.resolve(next.sentence.from)))
      .scrollIntoView(),
  );
  editor.view.focus();
  const place = frontTabOfMind(useAppStore.getState().layout, mindId, groupsMerged())?.id ?? mindId;
  setCheckCardOpen(place, false);
  setOpenClaim(place, next.check.id);
}

/**
 * Under an Answer that wrote into a Note (#1111, #2830): while the check of
 * what it wrote runs, how far it is ("Checking 5 of 40 sentences"); then how
 * many it checked and how many need a look, with Show; how many it couldn't
 * check, with the one Check, or why not (the spending cap, with Change the
 * cap; a plan's limit, with when it resumes). The lines count this write's own
 * Blocks alone; the Note's other text is the one Check's.
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
  const look = useWriteLook(check.mindId, check.request);
  const progress = useWrittenProgress(check.request);
  const consentWaiting = useChecksWaitForConsent();
  const report = useAppStore.getState().reportError;
  const checkNow =
    blocksKey === ""
      ? null
      : () => {
          void startCheckAsking(check.mindId).catch(report);
        };
  const does = {
    show: () => void showLook(check.mindId, check.request).catch(report),
    check: checkNow,
    "change-cap": () => useAppStore.getState().openSettings("general"),
  };
  return (
    <div>
      {selfCheckLines(check, t, language, new Date(), left, consentWaiting, progress, look).map(
        (line) => {
          const onClick = line.action && does[line.action.does];
          const action =
            line.action && onClick
              ? { label: line.action.label, testId: `self-check-${line.kind}-action`, onClick }
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
        },
      )}
    </div>
  );
}
