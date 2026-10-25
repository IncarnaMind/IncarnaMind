import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  GUIDE_WIDTH,
  PERMISSION_GUIDE_BRIDGE_KEY,
  type PermissionGuideBridge,
  type PermissionGuideState,
} from "../../../shared/permissionGuide";
import { CloseLineIcon } from "../components/lineIcons";
import { CheckMarkIcon } from "../editor/icons";
import { useT } from "../i18n";
import { GuideRow, GuideSteps } from "./GuideSteps";

declare global {
  interface Window {
    readonly [PERMISSION_GUIDE_BRIDGE_KEY]: PermissionGuideBridge;
  }
}

const bridge = window[PERMISSION_GUIDE_BRIDGE_KEY];

/**
 * The guide beside System Settings: the permission to allow, the two steps, the row to switch on,
 * and whether the system has granted it, in which case what to do next. The main process closes
 * it once it is granted; ✕, or Esc once it has the focus, closes it sooner.
 */
export function PermissionGuide() {
  const t = useT();
  const [state, setState] = useState<PermissionGuideState | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void bridge.state().then(setState);
    return bridge.onState(setState);
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") bridge.close();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const tell = () => {
      const box = element.getBoundingClientRect();
      bridge.resize(box.width, box.height);
    };
    tell();
    const observer = new ResizeObserver(tell);
    observer.observe(element);
    return () => observer.disconnect();
  });

  if (!state) return null;
  const { source, status } = state;
  const title = t(`meetings.guide.title.${source}`);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={title}
      data-testid="permission-guide"
      data-source={source}
      data-status={status}
      style={{ width: GUIDE_WIDTH }}
      className="guide-root flex flex-col gap-1.5 px-3.5 py-3 text-[13px] leading-5 text-ink-secondary"
    >
      <div className="guide-drag flex items-center gap-2 text-[14px] text-ink">
        <b className="grow font-semibold">{title}</b>
        <button
          type="button"
          data-testid="permission-guide-close"
          title={t("meetings.guide.close")}
          aria-label={t("meetings.guide.close")}
          onClick={() => bridge.close()}
          className="flex size-6 items-center justify-center rounded-md text-ink-meta hover:bg-hover hover:text-ink"
        >
          <CloseLineIcon className="size-3.5" />
        </button>
      </div>
      <GuideSteps source={source} status={status} />
      <GuideRow on={status === "granted"} />
      <div className="flex items-center gap-2 text-[12px] text-ink-meta">
        {status === "granted" ? (
          <>
            <CheckMarkIcon check="found" className="size-3.5 shrink-0 text-success" />
            <span data-testid="permission-guide-status" className="grow">
              {t(`meetings.guide.done.${source}`)}
            </span>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
            <span data-testid="permission-guide-status" className="grow">
              {t("meetings.guide.waiting")}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
