/**
 * The guide beside System Settings (#1105): what to click for a permission the User must add by
 * hand, in a small window next to it (src/main/meetings/guide.ts).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { core } from "../core";
import { installErrorLog } from "../errorLog";
import "../fonts.css";
import { installMotion, setMotionPreference } from "../motion";
import { useAppStore } from "../store";
import "../styles.css";
import { PermissionGuide } from "./PermissionGuide";
import "./permissionGuide.css";

installErrorLog();
installMotion();

core.getSettings().then(
  (settings) => useAppStore.setState({ settings }),
  (error: unknown) => useAppStore.getState().reportError(error),
);
core.on("settings.changed", (settings) => useAppStore.setState({ settings }));
useAppStore.subscribe((state, before) => {
  const motion = state.settings?.device.motion;
  if (motion && motion !== before.settings?.device.motion) setMotionPreference(motion);
});

const container = document.getElementById("root");
if (!container) throw new Error("The page has no #root element.");
createRoot(container).render(
  <StrictMode>
    <PermissionGuide />
  </StrictMode>,
);
