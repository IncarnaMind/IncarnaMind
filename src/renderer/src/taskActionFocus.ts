/**
 * Whether a Task action's press has left its answer with no focus: the Task changed since the
 * press, and nothing holds the focus now, so the button the User pressed went with the answer.
 * A Stop whose Task failed as it stopped takes this way too (#2125).
 */
export function focusLostAfterAction(
  pressedAt: string | null,
  updatedAt: string,
  active: Element | null,
): boolean {
  return (
    pressedAt !== null && updatedAt !== pressedAt && (active === null || active === document.body)
  );
}
