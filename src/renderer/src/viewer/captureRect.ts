/** The part of an element the viewer actually shows: what a capture may take of it (#118). */
export function visiblePartOf(element: HTMLElement): DOMRect {
  const own = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  let left = Math.max(own.left, 0);
  let top = Math.max(own.top, 0);
  let right = Math.min(own.right, view?.innerWidth ?? own.right);
  let bottom = Math.min(own.bottom, view?.innerHeight ?? own.bottom);
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clips =
      style.overflowX !== "visible" ||
      style.overflowY !== "visible" ||
      style.overflow !== "visible";
    if (!clips) continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
