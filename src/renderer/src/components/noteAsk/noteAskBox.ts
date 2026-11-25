/**
 * The Note's input box as it is drawn on `page` (#3759): grown over the Note's foot while the
 * conversation, or a question of the AI's, opens upward from it, the folded input otherwise. What
 * stands over the Note's foot ends at its top; in the window's column it is not on the page.
 */
export const drawnNoteAskBox = (page: ParentNode): HTMLElement | null =>
  page.querySelector<HTMLElement>(".note-ask > .note-ask-box");
