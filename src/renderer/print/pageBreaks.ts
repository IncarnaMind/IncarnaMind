/**
 * A block with a page break inside it (in a list item, a quote, #746): the
 * part before each break, the break, and the rest, so the break starts a page
 * as one between Blocks does. A list item cut in two keeps one number, on its
 * part before the break unless that part is empty, and an ordered list goes on
 * counting after the break from the items before it.
 */
export function apartAtBreaks(block: HTMLElement): HTMLElement[] {
  const parts: HTMLElement[] = [];
  let rest = block;
  for (
    let at = rest.querySelector<HTMLElement>(".page-break");
    at;
    at = rest.querySelector<HTMLElement>(".page-break")
  ) {
    parts.push(rest, at);
    rest = cutBefore(at, rest);
  }
  parts.push(rest);
  return parts;
}

/**
 * Takes `at` out of `block`, and what follows it into a copy of each element
 * it was in, down from `block`: returns the copy of `block`.
 */
function cutBefore(at: HTMLElement, block: HTMLElement): HTMLElement {
  let below: Element = at;
  let copied: HTMLElement | null = null;
  let numbered = false;
  let emptied: Element | null = null;
  for (
    let holder = at.parentElement;
    holder;
    holder = holder === block ? null : holder.parentElement
  ) {
    const copy = holder.cloneNode(false) as HTMLElement;
    if (copied) copy.append(copied);
    while (below.nextSibling) copy.append(below.nextSibling);
    if (below === at) at.remove();
    emptied?.remove();
    emptied = null;
    if (holder.localName === "li") {
      numbered = holder.childElementCount > 0 || (holder.textContent ?? "").trim() !== "";
      // A continued item has no marker (print.css): the number stays with the part that has text.
      if (numbered) copy.classList.add("continued");
      else emptied = holder;
    } else if (holder.localName === "ol") {
      const before = [...holder.children].filter((each) => each.localName === "li").length;
      const start = Number(holder.getAttribute("start") ?? "1");
      copy.setAttribute("start", String(start + before - (numbered ? 1 : 0)));
    } else copy.classList.add("continued");
    copied = copy;
    below = holder;
  }
  emptied?.remove();
  return copied ?? block;
}
