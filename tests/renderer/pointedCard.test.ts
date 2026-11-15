import { describe, expect, test } from "vitest";
import { onPeek, pointedCard } from "../../src/renderer/src/editor/peek";

/*
 * The card a pointer over a Citation's marker asks for, its own or, in the cluster the marker
 * draws, a neighbour's, when the keyboard's focus takes over (#3102).
 */

function cluster() {
  const own = new EventTarget();
  const neighbour = new EventTarget();
  const asked: string[] = [];
  onPeek(neighbour, ({ source, on }) => asked.push(`${source} ${on ? "on" : "off"}`));
  const held: string[] = [];
  const pointer = pointedCard(
    () => own,
    (source, on) => held.push(`${source} ${on ? "on" : "off"}`),
  );
  return { own, neighbour, asked, held, pointer };
}

describe("a pointer over a neighbour's words in a cluster", () => {
  // protects=focus on the marker that draws the cluster lets go of the neighbour's card the pointer rested on, so the next move over the neighbour's words asks for it again; the marker's own hold is untouched (#3102); fails_when=a move over the same words after the focus came asks for nothing; no_claim=which card shows on screen.
  test("asks for the neighbour's card again on its next move after the focus came to the marker", () => {
    const { neighbour, asked, held, pointer } = cluster();
    pointer.pointAt(neighbour);
    pointer.keyboardTookOver(false);
    pointer.pointAt(neighbour);
    expect(asked).toEqual(["cluster on", "cluster off", "cluster on"]);
    expect(held).toEqual([]);
  });

  // protects=focus on another control lets go of the neighbour's card too, and a later move asks again (#3102); fails_when=the neighbour's card is kept, or not asked for again; no_claim=the marker's own hold, which its caller drops.
  test("asks for it again after the focus went to another control", () => {
    const { neighbour, asked, pointer } = cluster();
    pointer.pointAt(neighbour);
    pointer.keyboardTookOver(true);
    pointer.pointAt(neighbour);
    expect(asked).toEqual(["cluster on", "cluster off", "cluster on"]);
  });

  // protects=over the marker's own words, focus on the marker keeps the pointer's hold, so leaving its words still lets the card go (#3102); fails_when=the marker's own hold is never let go; no_claim=a neighbour's card.
  test("keeps the marker's own hold when the focus came to it, and lets it go when the pointer leaves", () => {
    const { own, held, pointer } = cluster();
    pointer.pointAt(own);
    pointer.keyboardTookOver(false);
    pointer.pointAt(null);
    expect(held).toEqual(["pointer on", "pointer off"]);
  });
});
