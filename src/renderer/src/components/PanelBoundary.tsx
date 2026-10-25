import {
  Component,
  type CSSProperties,
  createElement,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { create } from "zustand";
import type { PanelName } from "../../../shared/panels";
import { logPanelFailure } from "../errorLog";
import { translateNow } from "../i18n";
import { ProblemLine, ProblemMark } from "./ProblemLine";

/** What stands in for a panel that failed when the panel's own box is drawn by the panel. */
export interface PanelFrame {
  tag?: "aside";
  className: string;
  style?: CSSProperties | undefined;
  attributes?: Record<string, string | undefined>;
}

/** A test makes a panel fail by name (`window.incarnamindTestHooks.failPanel`). */
export const usePanelFault = create<{ failing: PanelName | null }>()(() => ({ failing: null }));

function Fault({ name }: { name: PanelName }): null {
  const failing = usePanelFault((state) => state.failing === name);
  if (failing) throw new Error(`The ${name} panel was made to fail.`);
  return null;
}

function PanelFailed({
  name,
  frame,
  onReload,
}: {
  name: PanelName;
  frame: PanelFrame | undefined;
  onReload(): void;
}) {
  const line = (
    <div
      data-testid="panel-failed"
      data-panel={name}
      className={name === "overlays" ? "" : "max-w-sm px-6 text-center"}
    >
      <ProblemLine
        action={{ label: translateNow("panel.reload"), onClick: onReload, testId: "panel-reload" }}
      >
        <ProblemMark />
        {translateNow(name === "window" ? "panel.failed.window" : "panel.failed")}
      </ProblemLine>
    </div>
  );
  if (frame) {
    return createElement(
      frame.tag ?? "div",
      {
        ...frame.attributes,
        className: `${frame.className} items-center justify-center`,
        style: frame.style,
      },
      line,
    );
  }
  if (name === "overlays") {
    return (
      <div className="fixed top-16 left-1/2 z-20 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-sheet px-4 py-2.5 shadow-popover">
        {line}
      </div>
    );
  }
  const fills = name === "window" ? "h-screen w-screen bg-frame" : "h-full w-full";
  return <div className={`flex items-center justify-center ${fills}`}>{line}</div>;
}

/**
 * One part of the window, the sidebar, the card, the assistant, the overlays or the whole
 * window, that fails while it draws and leaves the rest as it was (#1500). In its place stands
 * one line, "This panel stopped working · Reload". Reload draws the panel again in place, so
 * what the stores hold (a draft, the conversation) is kept; for the window itself it loads the
 * page again. The error goes to the log, with its stack, as one nothing caught does.
 */
export class PanelBoundary extends Component<
  { name: PanelName; children: ReactNode; frame?: PanelFrame },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    logPanelFailure(this.props.name, error, info.componentStack ?? "");
  }

  private reload = (): void => {
    usePanelFault.setState({ failing: null });
    if (this.props.name === "window") window.location.reload();
    else this.setState({ failed: false });
  };

  override render(): ReactNode {
    const { name, children, frame } = this.props;
    if (this.state.failed) return <PanelFailed name={name} frame={frame} onReload={this.reload} />;
    return (
      <>
        <Fault name={name} />
        {children}
      </>
    );
  }
}
