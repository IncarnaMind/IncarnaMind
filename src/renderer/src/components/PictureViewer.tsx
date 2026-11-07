import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { files } from "../core";
import { useT } from "../i18n";
import { enterFrom, exitToward, useFade } from "../motion";
import { useNotices } from "../notices";
import {
  type PictureViewerTarget,
  pictureFileName,
  usePictureViewer,
  viewerActions,
} from "../pictureViewer";
import { useAppStore } from "../store";
import { createWheelZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from "../viewer/zoom";
import { CloseLineIcon } from "./lineIcons";
import { buttonStyle, iconButtonClass } from "./ui";
import { useModal } from "./useModal";

/** The space the picture keeps clear of the window's edges, as DESIGN.md has it. */
const MARGIN = 48;
/** The bar above the picture, and the gap under it. */
const BAR = 44;
const GAP = 8;
/** A press on the scrim this soon after opening is the second click of a double-click on the picture. */
const SETTLED_MS = 400;

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** A picture's own size, and which picture it was measured for. */
interface Natural {
  index: number;
  width: number;
  height: number;
}

/** Whether a picture at `size` is larger than the room it has, so a drag pans it. */
const overflows = (
  size: { width: number; height: number } | null,
  room: { width: number; height: number },
) => size !== null && (size.width > room.width + 0.5 || size.height > room.height + 0.5);

/**
 * A picture at full size (#2377): over the window on the dialogs' scrim, with
 * the caption or source, its place among the pictures it belongs to, Copy,
 * Save picture… and ✕ over it. It grows out of the picture and shrinks back
 * into it, the next picture cross-fades, and under reduced motion both fade.
 */
export function PictureViewer() {
  const t = useT();
  const target = usePictureViewer((state) => state.target);
  const close = usePictureViewer((state) => state.close);
  const step = usePictureViewer((state) => state.step);
  const open = target !== null;
  const dialog = useModal(open, { focusDialog: true });
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const current = useRef<PictureViewerTarget | null>(null);
  current.current = target;
  const openedAt = useRef(0);
  const shown = useRef(false);
  const captionId = useId();
  const [natural, setNatural] = useState<Natural | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomNow = useRef(1);
  zoomNow.current = zoom;
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  // Opened: it grows out of the picture; the scrim is the dialog's own.
  useEffect(() => {
    if (!open) {
      shown.current = false;
      return;
    }
    if (shown.current) return;
    shown.current = true;
    openedAt.current = performance.now();
    const element = panel.current;
    if (element)
      enterFrom(element, current.current?.source ?? null, undefined, { spring: "smooth" });
  }, [open]);

  // Each picture stepped to starts fitted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the picture changes, not when the zoom does
  useEffect(() => {
    setZoom(1);
  }, [target?.index]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  const finish = useCallback(() => {
    // A copy of the panel shrinks toward the picture while it hides; the focus goes back to the picture.
    if (panel.current) exitToward(panel.current, current.current?.source ?? null);
    close();
  }, [close]);

  // A press on the scrim closes it, as the dialogs do; a double-click's second press just opened it.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onPress = (event: MouseEvent) => {
      if (event.target !== element) return;
      if (performance.now() - openedAt.current < SETTLED_MS) return;
      finish();
    };
    element.addEventListener("mousedown", onPress);
    return () => element.removeEventListener("mousedown", onPress);
  }, [dialog, finish]);

  const room = {
    width: viewport.width - 2 * MARGIN,
    height: viewport.height - 2 * MARGIN - BAR - GAP,
  };
  const measured = natural && target && natural.index === target.index ? natural : null;
  const fit = measured
    ? Math.min(room.width / measured.width, room.height / measured.height, 2)
    : 1;
  const size = measured
    ? {
        width: Math.max(1, Math.round(measured.width * fit * zoom)),
        height: Math.max(1, Math.round(measured.height * fit * zoom)),
      }
    : null;

  const zoomTo = useCallback((next: number, pointer?: { x: number; y: number }) => {
    const bounded = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
    const element = scroller.current;
    const from = zoomNow.current;
    if (!element || !pointer) {
      setZoom(bounded);
      return;
    }
    const box = element.getBoundingClientRect();
    const x = pointer.x - box.left;
    const y = pointer.y - box.top;
    const contentX = element.scrollLeft + x;
    const contentY = element.scrollTop + y;
    setZoom(bounded);
    const ratio = bounded / from;
    requestAnimationFrame(() => {
      element.scrollLeft = contentX * ratio - x;
      element.scrollTop = contentY * ratio - y;
    });
  }, []);

  const zoomSteps = useCallback(
    (steps: number) => {
      const element = scroller.current;
      const box = element?.getBoundingClientRect();
      zoomTo(
        stepZoom(zoomNow.current, steps),
        box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : undefined,
      );
    },
    [zoomTo],
  );

  // Ctrl (or ⌘ on macOS) with the wheel and a pinch zoom about the pointer; a plain wheel scrolls.
  useEffect(() => {
    const element = scroller.current;
    if (!open || !element) return;
    const gesture = createWheelZoom({ mac: IS_MAC });
    const onKey = (event: KeyboardEvent) => gesture.keyChanged(event);
    const onBlur = () => gesture.blur();
    const onWheel = (event: WheelEvent) => {
      if (!gesture.isZoom(event)) return;
      event.preventDefault();
      event.stopPropagation();
      zoomTo(gesture.zoom(event, zoomNow.current), { x: event.clientX, y: event.clientY });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      element.removeEventListener("wheel", onWheel);
    };
  }, [open, zoomTo]);

  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const canPan = overflows(size, room);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!element || event.button !== 0 || !canPan) return;
    element.setPointerCapture(event.pointerId);
    pan.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = scroller.current;
    const start = pan.current;
    if (!element || !start) return;
    element.scrollLeft = start.left - (event.clientX - start.x);
    element.scrollTop = start.top - (event.clientY - start.y);
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    pan.current = null;
    scroller.current?.releasePointerCapture(event.pointerId);
  };

  /** What the picture is, at its own pixels, as a PNG. */
  const picturePng = useCallback(async (): Promise<Blob> => {
    const element = image.current;
    if (!element || element.naturalWidth === 0) throw new Error("The picture isn't shown.");
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The picture has no canvas to be drawn on.");
    context.drawImage(element, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The picture couldn't be made into a PNG.");
    return blob;
  }, []);

  const copy = useCallback(async () => {
    try {
      const blob = await picturePng();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      useNotices.getState().confirm("info.copied");
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  }, [picturePng]);

  /** Copies the picture once: the Edit menu's Copy and the page's own copy event may both ask. */
  const copiedAt = useRef(0);
  const copyOnce = useCallback(() => {
    const now = performance.now();
    if (now - copiedAt.current < 50) return;
    copiedAt.current = now;
    void copy();
  }, [copy]);

  // The menu's Copy reaches the page as a copy event on the dialog; the picture goes as an image.
  useEffect(() => {
    if (!open) return;
    const onCopy = (event: ClipboardEvent) => {
      const focused = event.target;
      if (
        focused instanceof Element &&
        focused.closest("input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      copyOnce();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [open, copyOnce]);

  // View's own zoom items step aside while the viewer is open, so ⌘+, ⌘− and ⌘0 reach the picture;
  // the Edit menu's Copy becomes the picture's.
  useEffect(() => {
    files.setPictureViewer(open);
    viewerActions.copy = open ? copyOnce : () => {};
    return () => {
      files.setPictureViewer(false);
      viewerActions.copy = () => {};
    };
  }, [open, copyOnce]);

  const save = async () => {
    if (!target) return;
    try {
      const blob = await picturePng();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await files.savePicture(pictureFileName(target, t), bytes);
      if (saved) useNotices.getState().confirm("pictureViewer.saved");
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };

  const source = !target
    ? ""
    : target.group.kind === "answer"
      ? t("pictureViewer.plotInAnswer", { number: target.index + 1 })
      : target.group.kind === "note"
        ? target.pictures[target.index]?.description ||
          t("pictureViewer.pictureInNote", { number: target.index + 1 })
        : (() => {
            const place = target.pictures[target.index]?.place;
            return place
              ? t("pictureViewer.documentSource", { document: target.group.name, place })
              : target.group.name || t("pictureViewer.picture");
          })();

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (!target) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      zoomSteps(1);
      return;
    }
    if (mod && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      zoomSteps(-1);
      return;
    }
    if (mod && event.key === "0") {
      event.preventDefault();
      setZoom(1);
      return;
    }
    if (mod && event.key.toLowerCase() === "c") {
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      copyOnce();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === " " && !mod && !event.altKey) {
      const focused = event.target;
      // A focused button takes Space as a press, as every button does.
      if (focused instanceof Element && focused.closest("button, input, select, textarea, a"))
        return;
      event.preventDefault();
      finish();
    }
  };

  return (
    <dialog
      ref={dialog}
      data-testid="picture-viewer"
      tabIndex={-1}
      aria-labelledby={captionId}
      onCancel={(event) => {
        // Closed here, not by the browser, so it shrinks back into the picture first.
        event.preventDefault();
        finish();
      }}
      onClose={() => {
        if (usePictureViewer.getState().target) close();
      }}
      onKeyDown={onKeyDown}
      className="m-auto max-h-none max-w-none overflow-visible rounded-none bg-transparent p-0 shadow-none outline-none backdrop:bg-scrim focus-visible:outline-none"
    >
      {target && (
        <div
          ref={panel}
          className="flex w-max max-w-[calc(100vw-96px)] flex-col gap-2"
          data-picture-viewer-panel=""
        >
          <div
            data-testid="picture-viewer-bar"
            className="flex h-11 w-full min-w-[280px] items-center gap-1.5 rounded-lg bg-sheet px-2.5 text-ui shadow-dialog"
          >
            <p
              id={captionId}
              data-testid="picture-viewer-source"
              className="mr-auto min-w-0 truncate text-[13px] leading-5 text-ink-secondary"
              title={source}
            >
              {source}
            </p>
            {target.pictures.length > 1 && (
              <span
                data-testid="picture-viewer-count"
                className="shrink-0 pr-1 text-[13px] leading-5 text-ink-meta"
              >
                {t("pictureViewer.count", {
                  at: target.index + 1,
                  total: target.pictures.length,
                })}
              </span>
            )}
            <button
              type="button"
              data-testid="picture-viewer-copy"
              className={buttonStyle("ghost", "sm")}
              onClick={() => void copy()}
            >
              {t("pictureViewer.copy")}
            </button>
            <button
              type="button"
              data-testid="picture-viewer-save"
              className={buttonStyle("ghost", "sm")}
              onClick={() => void save()}
            >
              {t("pictureViewer.save")}
            </button>
            <button
              type="button"
              data-testid="picture-viewer-close"
              aria-label={t("pictureViewer.close")}
              title={t("pictureViewer.close")}
              onClick={finish}
              className={iconButtonClass}
            >
              <CloseLineIcon className="size-4" />
            </button>
          </div>
          <div
            ref={scroller}
            data-testid="picture-viewer-scroll"
            className="relative overflow-auto [overflow-anchor:none]"
            style={{
              maxWidth: `calc(100vw - ${2 * MARGIN}px)`,
              maxHeight: `calc(100vh - ${2 * MARGIN + BAR + GAP}px)`,
              cursor: canPan ? "grab" : "default",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div
              className="flex items-center justify-center"
              style={{
                width: "max-content",
                height: "max-content",
                minWidth: "100%",
                minHeight: "100%",
              }}
            >
              <ViewerImage
                key={target.index}
                picture={target.pictures[target.index]}
                size={size}
                image={image}
                onNatural={(width, height) => setNatural({ index: target.index, width, height })}
              />
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}

function ViewerImage({
  picture,
  size,
  image,
  onNatural,
}: {
  picture: PictureViewerTarget["pictures"][number] | undefined;
  size: { width: number; height: number } | null;
  image: RefObject<HTMLImageElement | null>;
  onNatural(width: number, height: number): void;
}) {
  useFade(image);
  if (!picture) return null;
  return (
    <img
      ref={image}
      src={picture.src}
      alt={picture.description}
      draggable={false}
      data-testid="picture-viewer-image"
      className="block max-w-none select-none"
      style={
        size
          ? { width: size.width, height: size.height }
          : {
              maxWidth: `calc(100vw - ${2 * MARGIN}px)`,
              maxHeight: `calc(100vh - ${2 * MARGIN + BAR + GAP}px)`,
            }
      }
      onDragStart={(event) => event.preventDefault()}
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth > 0) {
          onNatural(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
        }
      }}
    />
  );
}
