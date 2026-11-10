/**
 * The floating panel during a call: the ask bar with the help prompts and the latest
 * suggestion, in a small window above the meeting app (src/main/meetings/panel.ts).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { showAppearance } from "../appearance";
import { core } from "../core";
import { installErrorLog } from "../errorLog";
import "../fonts.css";
import { useMeetings } from "../meetings";
import { installMotion, setMotionPreference } from "../motion";
import { useAppStore } from "../store";
import "../styles.css";
import { MeetingPanel } from "./MeetingPanel";
import "./meetingPanel.css";

installErrorLog();
installMotion();

const report = (error: unknown) => useAppStore.getState().reportError(error);
core.getSettings().then((settings) => useAppStore.setState({ settings }), report);
core.getChatReadiness().then((chatReadiness) => useAppStore.setState({ chatReadiness }), report);
void useMeetings.getState().load();
useAppStore.subscribe((state, before) => {
  const motion = state.settings?.device.motion;
  if (motion && motion !== before.settings?.device.motion) setMotionPreference(motion);
  const appearance = state.settings?.device.appearance;
  if (appearance && appearance !== before.settings?.device.appearance) showAppearance(appearance);
});

const container = document.getElementById("root");
if (!container) throw new Error("The page has no #root element.");
createRoot(container).render(
  <StrictMode>
    <MeetingPanel />
  </StrictMode>,
);
