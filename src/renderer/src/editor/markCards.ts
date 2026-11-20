/**
 * The one card a mark drawn in an Answer's text opens: an unchecked figure's "?" (#535), an uncited
 * sentence's check (#3410). It sits under its mark, inside the window; a press outside it or Esc
 * closes it, and so does the next card.
 */

let shown: { element: HTMLElement; dismiss: (event: Event) => void } | null = null;

export function hideMarkCard(): void {
  if (!shown) return;
  document.removeEventListener("pointerdown", shown.dismiss, true);
  document.removeEventListener("keydown", shown.dismiss, true);
  shown.element.remove();
  shown = null;
}

export function showMarkCard(anchor: HTMLElement, card: HTMLElement): void {
  hideMarkCard();
  document.body.append(card);
  const box = anchor.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(window.innerWidth - card.offsetWidth - 8, box.left))}px`;
  card.style.top = `${Math.min(window.innerHeight - card.offsetHeight - 8, box.bottom + 6)}px`;
  const dismiss = (event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (event.key !== "Escape") return;
    } else if (event.target instanceof Node && card.contains(event.target)) return;
    hideMarkCard();
  };
  document.addEventListener("pointerdown", dismiss, true);
  document.addEventListener("keydown", dismiss, true);
  shown = { element: card, dismiss };
}
