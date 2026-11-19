import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasFrame } from "../../../../core/api";
import { CANVAS_PARTITION, canvasHostOf } from "../../../../shared/canvases";
import { useCanvases } from "../../canvases";
import { core, files } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { siteOf } from "../../webPages";
import { ProblemLine } from "../ProblemLine";

/**
 * A Canvas in its tab (#3406), drawn as the agent designed it, in a `<webview>` the main process
 * guards (src/main/canvases.ts). The window only listens: its height, a website it would open,
 * which the User may open in their browser, and that it stopped. The page can't be edited here.
 */
export function CanvasTab({ canvasId }: { canvasId: string }) {
  const t = useT();
  const report = useAppStore((state) => state.reportError);
  const canvas = useCanvases(
    (state) => state.canvases.find((each) => each.id === canvasId) ?? null,
  );
  const version = canvas?.version ?? null;
  const [frame, setFrame] = useState<CanvasFrame | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [stopped, setStopped] = useState<"memory" | "crashed" | null>(null);
  const shown = (frame: CanvasFrame) => {
    setFrame(frame);
    setStopped(null);
  };

  useEffect(() => {
    if (version === null) return;
    let current = true;
    core.showCanvas(canvasId).then((frame) => {
      if (!current) return;
      setFrame(frame);
      setStopped(null);
    }, report);
    return () => {
      current = false;
    };
  }, [canvasId, version, report]);

  const host = frame ? canvasHostOf(frame.url) : null;
  useEffect(
    () =>
      files.onCanvasFrame((news) => {
        if (news.host !== host) return;
        if (news.kind === "height") setHeight(news.height);
        else if (news.kind === "link") setLink(news.url);
        else if (news.kind === "stopped") setStopped(news.reason);
      }),
    [host],
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
      data-canvas-height={height ?? undefined}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet"
    >
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
              core.showCanvas(canvasId).then(shown, report);
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
          />
        )
      )}
    </div>
  );
}

/**
 * The `<webview>` itself, made by hand: its attributes are all in place before it is attached, and
 * `allowpopups` is one React would leave out. It lets a page's new window reach the main process,
 * which refuses it and offers its address to the User.
 */
function CanvasFrameView({ url, title }: { url: string; title: string }) {
  const holder = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = document.createElement("webview");
    view.setAttribute("partition", CANVAS_PARTITION);
    view.setAttribute("allowpopups", "");
    view.setAttribute("title", title);
    view.dataset.testid = "canvas-frame";
    view.className = "flex h-full w-full";
    view.setAttribute("src", url);
    holder.current?.append(view);
    return () => view.remove();
  }, [url, title]);
  return <div ref={holder} className="flex min-h-0 min-w-0 flex-1" />;
}
