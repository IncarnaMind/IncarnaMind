/**
 * Which of a check card's actions are its buttons and which wait under its one ⋯ (#2869): the
 * action the card styles as its main one first, then Keep as my view where the verdict has it,
 * else the next action, at most two; every other action under the ⋯ in the card's own order, Open
 * the page first, none dropped.
 */
import { describe, expect, test } from "vitest";
import { type CardAction, splitActions } from "../../src/renderer/src/editor/cardActions";

const action = (testId: string, more: Partial<CardAction> = {}): CardAction => ({
  key: testId,
  testId,
  label: testId,
  onClick: () => undefined,
  ...more,
});

function split(actions: readonly CardAction[]) {
  const { buttons, menu } = splitActions(actions);
  return {
    buttons: buttons.map((each) => each.testId),
    menu: menu.map((each) => each.testId),
  };
}

describe("a check card's two buttons and its ⋯", () => {
  // protects=a sentence nothing backs shows its main action and Keep as my view, the rest under ⋯ in order; fails_when=an action is dropped, reordered, or a third button shows; no_claim=the actions' words.
  test("Not found: the main action, then Keep as my view", () => {
    expect(
      split([
        action("claim-search-all", { primary: true }),
        action("claim-check-document"),
        action("claim-choose-citation"),
        action("claim-cut-sentence"),
        action("claim-keep", { keep: true }),
        action("check.findSources"),
        action("claim-search-web"),
        action("claim-remove"),
      ]),
    ).toEqual({
      buttons: ["claim-search-all", "claim-keep"],
      menu: [
        "claim-check-document",
        "claim-choose-citation",
        "claim-cut-sentence",
        "check.findSources",
        "claim-search-web",
        "claim-remove",
      ],
    });
  });

  // protects=a contradicted sentence's fix comes first, Keep as my view second, and Open the page is the first thing under ⋯; fails_when=Open takes a button or leaves the card; no_claim=where the quote opens.
  test("Contradicted: Change to…, Keep as my view, and Open the page under ⋯", () => {
    expect(
      split([
        action("claim-correct", { primary: true }),
        action("claim-open", { menuOnly: true }),
        action("claim-keep", { keep: true }),
      ]),
    ).toEqual({ buttons: ["claim-correct", "claim-keep"], menu: ["claim-open"] });
  });

  // protects=a verdict with no Keep as my view keeps its first two actions as they were, and one with one action shows one button; fails_when=a second button is invented or the second action is hidden; no_claim=their styles.
  test("no Keep as my view: the first two actions, or the one", () => {
    expect(
      split([
        action("claim-open-unread", { primary: true }),
        action("claim-check-again", { primary: true }),
      ]),
    ).toEqual({ buttons: ["claim-open-unread", "claim-check-again"], menu: [] });
    expect(split([action("claim-remove")])).toEqual({
      buttons: ["claim-remove"],
      menu: [],
    });
  });

  // protects=a card whose every part is fine has no button, its Open and Add all under ⋯, Open first; fails_when=a ✓ card shows a button, or Open isn't first under ⋯; no_claim=the Location line's links.
  test("a ✓ card: no button, Open the page first under ⋯", () => {
    expect(
      split([
        action("claim-parts-add-all", { menuOnly: true }),
        action("claim-open", { menuOnly: true }),
      ]),
    ).toEqual({ buttons: [], menu: ["claim-open", "claim-parts-add-all"] });
  });

  // protects=the first button is the action the card styles as its main one even when it isn't first in order (a rewrite after Search all Documents); fails_when=the earlier, plain action takes the first button; no_claim=which actions a verdict has.
  test("the main action is first, wherever it is in order", () => {
    expect(
      split([
        action("claim-search-all"),
        action("claim-check-document"),
        action("claim-rewrite", { primary: true }),
        action("claim-keep", { keep: true }),
      ]),
    ).toEqual({
      buttons: ["claim-rewrite", "claim-keep"],
      menu: ["claim-search-all", "claim-check-document"],
    });
  });
});
