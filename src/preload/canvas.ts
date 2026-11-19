/**
 * The preload of a Canvas an outside agent wrote (#3406), in a world of its own beside the page's:
 * when the User presses a Citation's marker (one IncarnaMind wrote in when it served the page), it
 * sends the marker's token, the one message of `CANVAS_CHANNEL`. Only the User's own click or key
 * counts: a page's script can make no event that does, and it gets nothing from here. The main
 * process checks the message again, and the app opens a token only from that Canvas's own Citations.
 */
import { ipcRenderer } from "electron";
import { CANVAS_CHANNEL } from "../shared/canvases";

const MARKER = "incarnamind-cite[data-token]";

function pressed(event: Event): void {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  const marker = event.target.closest(MARKER);
  if (!marker) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send(CANVAS_CHANNEL, { kind: "cite", token: marker.getAttribute("data-token") });
}

window.addEventListener("click", pressed, true);
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Enter" || event.key === " ") pressed(event);
  },
  true,
);
