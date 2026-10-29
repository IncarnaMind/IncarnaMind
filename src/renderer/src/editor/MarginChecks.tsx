import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { setClaimFocus, setOpenClaim } from "../checks";
import { useT } from "../i18n";
import { motionMode, subscribeMotion } from "../motion";
import { checkStateKey } from "../unsupportedFixes";
import { ClaimMark } from "./ClaimCheckCard";
import { useCardPlace } from "./checkPlace";
import { textBlockEdited } from "./citationNumbers";
import { type ShownClaim, shownClaims } from "./claimChecks";
import type { ClaimMarkState } from "./icons";
import { OpinionCard } from "./OpinionCard";

const MARK_HEIGHT = 18;
/** Between two marks stacked because their sentences start on the same line (or nearly). */
const MARK_GAP = 4;
/** When an Answer finishes, its checks appear one after another, this far apart. */
const REVEAL_STEP_MS = 40;

interface Mark {
  /** "claim:" and the sentence check's id. */
  key: string;
  state: ClaimMarkState;
  claim: ShownClaim;
  /** The vertical middle of the sentence's first line, from the top of the column. */
  middle: number;
  top: number;
  /** How long its entrance waits, if it is appearing because its check just finished. */
  delay: number | null;
}

/**
 * Whether a change to the editor's DOM may move marks: not one in the text
 * block being typed in (`measure` checks that block), to a node removed since
 * (its removal is a change of its own), or an attribute set to the value it
 * had (the editor sets its own at every change).
 */
function mayMoveMarks(record: MutationRecord, typedIn: Node | null): boolean {
  const { target } = record;
  if (!target.isConnected || typedIn?.contains(target)) return false;
  return (
    record.type !== "attributes" ||
    record.oldValue !== (target as Element).getAttribute(record.attributeName ?? "")
  );
}

const sameMarks = (a: readonly Mark[], b: readonly Mark[]) =>
  a.length === b.length &&
  a.every((mark, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      mark.key === other.key &&
      mark.state === other.state &&
      mark.top === other.top &&
      mark.delay === other.delay &&
      mark.claim.check === other.claim.check &&
      mark.claim.sentence.text === other.claim.sentence.text
    );
  });

/**
 * The column of sentence checks in the right margin, the Mind's signature:
 * one 18px mark for each sentence that has been checked, its verdict, level
 * with the sentence's first line, so the checks can be scanned down the page
 * (see `ClaimMark`). Marks whose sentences start on one line stack under each
 * other. A Citation's own check isn't here: it shows on its marker, in the text.
 *
 * It is an overlay beside the editor that measures the sentences: again after
 * every change to the Mind, every change to the editor's DOM (Answers stream
 * in, formulas render), every resize and every font load, at most once a
 * frame. Typing in a text block with no check in it, most of what happens,
 * is the exception: it moves no mark unless the block grows or shrinks, so
 * only the block is measured then. When a check finishes, its mark appears
 * after those above it, 40ms apart (not with reduced motion: see styles.css).
 * Under 760px the column keeps to the text's 40px gutter.
 */
export function MarginChecks({
  editor,
  mind,
}: {
  editor: Editor;
  /** The Mind and its document: a card checks again there. */
  mind: { id: string; doc: Y.Doc };
}) {
  const t = useT();
  const place = useCardPlace(mind.id);
  const layer = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  /** Each mark's state as last drawn: a change from "checking" is its check finishing. */
  const seen = useRef(new Map<string, ClaimMarkState>());
  /** The entrance delays of the marks that appeared that way, by key and state. */
  const reveals = useRef(new Map<string, number>());

  useEffect(() => {
    let frame = 0;
    /** Whether the next frame measures every mark, rather than those `typedIn` may have moved. */
    let all = true;
    /** The text block typed in since the last frame, when nothing else changed (`textBlockEdited`). */
    let typedIn: HTMLElement | null = null;
    /** The text block typed in when the marks were last measured, and its height then. */
    let typed: { block: HTMLElement; height: number } | null = null;
    const measure = () => {
      frame = 0;
      const column = layer.current;
      if (!column || editor.isDestroyed) return;
      const block = typedIn;
      typedIn = null;
      const height = block?.getBoundingClientRect().height ?? 0;
      // Typing that keeps its block's height moves only the marks in that block, if any.
      const only =
        !all && block && typed?.block === block && typed.height === height ? block : null;
      if (only && !only.querySelector("[data-claim-check]")) return;
      all = false;
      typed = block ? { block, height } : null;
      const origin = column.getBoundingClientRect().top;
      const next: Mark[] = [];
      const revealed: Mark[] = [];
      for (const claim of shownClaims(editor.state)) {
        let coords: { top: number; bottom: number };
        try {
          coords = editor.view.coordsAtPos(claim.sentence.from, 1);
        } catch {
          continue;
        }
        const state = claim.shown.state;
        const mark: Mark = {
          key: `claim:${claim.check.id}`,
          state,
          claim,
          middle: (coords.top + coords.bottom) / 2 - origin,
          top: 0,
          delay: null,
        };
        if (seen.current.get(mark.key) === "checking" && state !== "checking") revealed.push(mark);
        seen.current.set(mark.key, state);
        next.push(mark);
      }
      // Top to bottom; a mark that would overlap the one above goes under it. A sentence not
      // checked yet has no mark on the page (D276): its button is only its card's anchor, so it
      // keeps its sentence's line and takes no room in the stack (#1941).
      next.sort((a, b) => a.middle - b.middle);
      let bottom = Number.NEGATIVE_INFINITY;
      for (const mark of next) {
        mark.top = Math.round(mark.middle - MARK_HEIGHT / 2);
        if (mark.state === "not-checked") continue;
        mark.top = Math.max(mark.top, bottom + MARK_GAP);
        bottom = mark.top + MARK_HEIGHT;
      }
      // Only with motion on: otherwise the marks are there at once, with no cascade to end.
      if (motionMode() === "on") {
        revealed
          .sort((a, b) => a.top - b.top)
          .forEach((mark, index) => {
            reveals.current.set(`${mark.key}:${mark.state}`, index * REVEAL_STEP_MS);
          });
      }
      for (const mark of next)
        mark.delay = reveals.current.get(`${mark.key}:${mark.state}`) ?? null;
      setMarks((drawn) => (sameMarks(drawn, next) ? drawn : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const request = () => {
      all = true;
      schedule();
    };
    request();

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const at = textBlockEdited(transaction);
      const block = at === null ? null : editor.view.nodeDOM(at);
      if (!(block instanceof HTMLElement) || (typedIn && typedIn !== block)) {
        request();
        return;
      }
      typedIn = block;
      schedule();
    };
    editor.on("transaction", onTransaction);
    const resizes = new ResizeObserver(request);
    resizes.observe(editor.view.dom);
    // React draws node views after the transaction; Answers stream in; KaTeX renders.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => mayMoveMarks(record, typedIn))) request();
    });
    mutations.observe(editor.view.dom, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style"],
    });
    document.fonts.addEventListener("loadingdone", request);
    void document.fonts.ready.then(request);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", onTransaction);
      resizes.disconnect();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", request);
    };
  }, [editor]);

  useEffect(
    () => () => {
      setOpenClaim(place, null);
      setClaimFocus(place, null);
    },
    [place],
  );

  // Motion turned to Reduced or Off stops the cascade (styles.css), so it never ends on its own:
  // its marks are simply there, and can't play it later if motion comes back on.
  useEffect(
    () =>
      subscribeMotion(() => {
        if (motionMode() === "on") return;
        reveals.current.clear();
        setMarks((drawn) =>
          drawn.some((mark) => mark.delay !== null)
            ? drawn.map((mark) => (mark.delay === null ? mark : { ...mark, delay: null }))
            : drawn,
        );
      }),
    [],
  );

  return (
    <div ref={layer} className="margin-checks" data-testid="margin-checks">
      <OpinionCard editor={editor} mindId={mind.id} doc={mind.doc} />
      {marks.map((mark) => (
        <ClaimMark
          key={mark.key}
          claim={mark.claim}
          editor={editor}
          mindId={mind.id}
          doc={mind.doc}
          label={t("claim.mark.label", { state: t(checkStateKey(editor, mark.claim)) })}
          reveal={mark.delay !== null}
          style={{ top: mark.top, "--reveal-delay": `${mark.delay ?? 0}ms` } as CSSProperties}
          onRevealed={() => {
            reveals.current.delete(`${mark.key}:${mark.state}`);
            setMarks((drawn) =>
              drawn.map((each) => (each === mark ? { ...each, delay: null } : each)),
            );
          }}
        />
      ))}
    </div>
  );
}
