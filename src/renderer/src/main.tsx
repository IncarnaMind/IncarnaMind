import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PanelBoundary } from "./components/PanelBoundary";
import "./commands/app";
import { files } from "./core";
import "./fonts.css";
import "./styles.css";
import "./viewer/viewer.css";
import { installErrorLog } from "./errorLog";
import { installMotion } from "./motion";
import { retryTaggingWhenOnline } from "./taggingRetry";
import { installTestHooks } from "./viewerControls";
import { installWindowMemory } from "./windowMemory";

installErrorLog();
installWindowMemory();
installTestHooks();
retryTaggingWhenOnline();
// Before the first paint: the system's Reduce motion holds until the settings say the User's choice.
installMotion();

// Which title bar the window has, and whether it's full screen, for styles.css ("The title bar").
document.documentElement.dataset.titleBar = files.titleBar;
files.onFullScreenChange((fullScreen) =>
  document.documentElement.toggleAttribute("data-full-screen", fullScreen),
);

const container = document.getElementById("root");
if (!container) throw new Error("The page has no #root element.");

const root = createRoot(container);
// At once, not in a later task: the window shows with its first paint, which then has the
// app's frame (`AppShell`) rather than an empty page.
flushSync(() =>
  root.render(
    <StrictMode>
      <PanelBoundary name="window">
        <App />
      </PanelBoundary>
    </StrictMode>,
  ),
);
