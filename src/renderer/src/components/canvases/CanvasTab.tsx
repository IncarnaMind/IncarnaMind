import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasFrame } from "../../../../core/api";
import { CANVAS_PARTITION, type CanvasKey, canvasHostOf } from "../../../../shared/canvases";
import { drawnCanvas, useCanvases } from "../../canvases";
import { core, files } from "../../core";
import { useT } from "../../i18n";
import { openCited } from "../../openCited";
import { useOwnAiPillShown } from "../../ownAiPanel";
import { useQuietAssistant } from "../../quietAssistant";
import { useAppStore } from "../../store";
import { siteOf } from "../../webPages";
import { ProblemLine } from "../ProblemLine";
import { useTabPlace } from "../tabs/tabItems";

/**
 * A Canvas in its tab (#3406), drawn as the agent designed it, in a `<webview>` the main process
 * guards (src/main/canvases.ts); it scrolls inside its tab. The window only listens: a Citation the
 * User pressed opens its Passage beside the Canvas, as a note's does; one of the window's own keys
 * pressed there is pressed here; a website it would open is offered to the User; and it may have
 * stopped. It shows its newest version, which can't be edited here.
 */
export function CanvasTab({ canvasId }: { canvasId: string }) {
  const t = useT();
  const report = useAppStore((state) => state.reportError);
  const place = useTabPlace();
  const canvas = useCanvases(
    (state) => state.canvases.find((each) => each.id === canvasId) ?? null,
  );
  const newest = canvas?.version ?? null;
  const [frame, setFrame] = useState<CanvasFrame | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [stopped, setStopped] = useState<"memory" | "crashed" | null>(null);
  const view = useRef<HTMLElement | null>(null);
  // An Ask pill floats at the card's foot (#3373): the page stops above it, as a Note's text fades.
  const ownAiPill = useOwnAiPillShown();
  const quietPill = useQuietAssistant();

  useEffect(() => {
    if (newest === null) return;
    let current = true;
    core.showCanvas(canvasId).then((shown) => {
      if (!current) return;
      setFrame(shown);
      setStopped(null);
    }, report);
    return () => {
      current = false;
    };
  }, [canvasId, newest, report]);

  const frameUrl = frame?.url ?? null;
  useEffect(() => (frameUrl ? drawnCanvas(canvasId, frameUrl) : undefined), [canvasId, frameUrl]);

  const host = frameUrl ? canvasHostOf(frameUrl) : null;
  const groupId = place?.groupId;
  useEffect(
    () =>
      files.onCanvasFrame((news) => {
        if (news.host !== host || !frameUrl) return;
        if (news.kind === "link") setLink(news.url);
        else if (news.kind === "stopped") setStopped(news.reason);
        else if (news.kind === "key") pressHere(view.current, news);
        else {
          core.canvasCitation(frameUrl, news.token).then((cited) => {
            if (!cited) return;
            const { check, checkReason, number, ...citation } = cited;
            openCited(citation, {
              origin: "note",
              check,
              ...(checkReason && { checkReason }),
              withQuote: true,
              number,
              ...(groupId && { from: groupId }),
            });
          }, report);
        }
      }),
    [host, frameUrl, groupId, report],
  );

  if (!canvas) {
    return (
      <div data-testid="canvas-view" className="flex min-h-0 flex-1 flex-col bg-sheet p-6">
        <ProblemLine role="status" testId="canvas-deleted">
          {t("canvas.deleted")}
        </ProblemLine>
      </div>
    );
  }
  return (
    <div
      data-testid="canvas-view"
      data-canvas-id={canvasId}
      data-canvas-version={frame?.version}
      className="relative flex min-h-0 min-w-0 flex-1 bg-sheet"
    >
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${ownAiPill || quietPill ? "pb-[68px]" : ""}`}
      >
        <p
          data-testid="canvas-unchecked"
          className="shrink-0 border-b border-rule px-4 py-2 text-[13px] leading-5 text-ink-meta"
        >
          {t("canvas.unchecked", { agent: canvas.agent })}
        </p>
        {link && (
          <ProblemLine
            role="status"
            testId="canvas-link"
            className="shrink-0 border-b border-rule px-4 py-2"
            action={{
              label: t("canvas.link.open"),
              testId: "canvas-link-open",
              onClick: () => {
                window.open(link, "_blank", "noopener,noreferrer");
                setLink(null);
              },
            }}
            also={{ label: t("canvas.link.dismiss"), onClick: () => setLink(null) }}
          >
            {t("canvas.link", { site: siteOf(link) || link })}
          </ProblemLine>
        )}
        {stopped ? (
          <ProblemLine
            testId="canvas-stopped"
            className="px-6 py-6"
            action={{
              label: t("canvas.stopped.again"),
              testId: "canvas-show-again",
              onClick: () => {
                core.showCanvas(canvasId).then((shown) => {
                  setFrame(shown);
                  setStopped(null);
                }, report);
              },
            }}
          >
            {t(stopped === "memory" ? "canvas.stopped.memory" : "canvas.stopped.crashed")}
          </ProblemLine>
        ) : (
          frame && (
            <CanvasFrameView
              key={frame.url}
              url={frame.url}
              title={t("canvas.frame", { title: canvas.title, agent: canvas.agent })}
              view={view}
            />
          )
        )}
      </div>
    </div>
  );
}

/** Presses a key here that the User pressed in the Canvas: the window's own keymap takes it. */
function pressHere(element: HTMLElement | null, key: CanvasKey): void {
  (element ?? window).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: key.key,
      code: key.code,
      metaKey: key.meta,
      ctrlKey: key.ctrl,
      altKey: key.alt,
      shiftKey: key.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * The `<webview>` itself, made by hand: its attributes are all in place before it is attached, and
 * `allowpopups` is one React would leave out. It lets a page's new window reach the main process,
 * which refuses it and offers its address to the User.
 */
function CanvasFrameView({
  url,
  title,
  view,
}: {
  url: string;
  title: string;
  view: { current: HTMLElement | null };
}) {
  const holder = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = document.createElement("webview");
    element.setAttribute("partition", CANVAS_PARTITION);
    element.setAttribute("allowpopups", "");
    element.setAttribute("title", title);
    element.dataset.testid = "canvas-frame";
    element.className = "flex h-full w-full";
    element.setAttribute("src", url);
    holder.current?.append(element);
    view.current = element;
    return () => {
      element.remove();
      if (view.current === element) view.current = null;
    };
  }, [url, title, view]);
  return <div ref={holder} className="flex min-h-0 min-w-0 flex-1" />;
}
