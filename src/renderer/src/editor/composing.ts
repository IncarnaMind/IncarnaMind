import type { KeyboardEvent } from "react";

/** A key an input method is typing with: Enter then picks a candidate and is not the field's own. */
export const isComposing = (event: KeyboardEvent) =>
  event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process";
