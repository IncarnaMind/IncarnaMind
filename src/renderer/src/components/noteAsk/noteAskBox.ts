/**
 * The Note's input box as it is drawn on `page` (#3759): grown over the Note's foot while the
 * conversation, or a question of the AI's, opens upward from it, the folded input otherwise. What
 * stands over the Note's foot ends at its top; in the window's column it is not on the page.
 */
export const drawnNoteAskBox = (page: ParentNode): HTMLElement | null =>
  page.querySelector<HTMLElement>(".note-ask > .note-ask-box");

/**
 * Calls `changed` whenever the box `drawnNoteAskBox` finds on `page` changes size, when one comes
 * onto the page, leaves it or is replaced, as the conversation moves to the window's column and
 * back, and when the Note's end has made room for it. Returns the stop.
 */
export function watchDrawnNoteAskBox(page: ParentNode, changed: () => void): () => void {
  const foot = page.querySelector(".note-ask-foot");
  if (!foot) return () => {};
  let box: HTMLElement | null = null;
  const sizes = new ResizeObserver(changed);
  const follow = () => {
    const next = drawnNoteAskBox(page);
    if (next === box) return;
    if (box) sizes.unobserve(box);
    box = next;
    // Observing calls `changed` once the box is laid out.
    if (box) sizes.observe(box);
    else changed();
  };
  const mounts = new MutationObserver(follow);
  mounts.observe(foot, { childList: true, subtree: true });
  // The Note's end makes room for the box (`--note-ask-over` on its scroller) only after the box
  // has grown: until then nothing at the Note's end can scroll above it.
  const room = new MutationObserver(changed);
  const scroller = page.querySelector(".mind-scroller");
  if (scroller) room.observe(scroller, { attributeFilter: ["style"] });
  follow();
  return () => {
    mounts.disconnect();
    room.disconnect();
    sizes.disconnect();
  };
}
