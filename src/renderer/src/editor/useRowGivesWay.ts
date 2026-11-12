import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/** What the composer's controls have given up so far, as the row ran short. */
export interface RowGivesWay {
  /** How many Search scope chips are kept (see `ScopeChips`' `shown`): fewer, folded into the count. */
  most: number;
  /** The "· empty" on a Folder's chip is shown. */
  hints: boolean;
  /** The model's name may be cut. */
  model: boolean;
}

interface State extends RowGivesWay {
  key: string;
  /** What the chips said when this was decided (their `data-chips`). */
  chips: string;
  stacked: boolean;
}

/**
 * Whether a name's box is narrower than its text, by any part of a pixel: the ellipsis shows then,
 * though `scrollWidth` and `clientWidth`, which are whole pixels, can still read the same.
 */
function shortOfItsText(box: HTMLElement): boolean {
  const text = document.createRange();
  text.selectNodeContents(box);
  // A DOM with no layout (the unit tests') has no rectangle for a range, and nothing is cut there.
  if (typeof text.getBoundingClientRect !== "function") return false;
  return text.getBoundingClientRect().width > box.getBoundingClientRect().width + 0.05;
}

/**
 * The order the row gives way in, when its controls don't fit, always the same: the "· empty" on a
 * Folder's chip goes whole; then each chip's name shortens (its floor, `useChipFloors`); then the
 * chips that can't keep that fold into the count; only then is the model's name cut, and a lone
 * chip folds after it. + and Ask never change, and "All Documents" is never cut. Each step is
 * taken before the row is drawn, and measured again, until the controls fit.
 *
 * Starts over when the row's width changes, when the controls move under the text (`stacked`: they
 * have the whole row then), or when what they hold does: `key`, or the chips' names (their list's
 * `data-chips`), which arrive after their ids. Moving back beside the text keeps what was given up:
 * the controls fit there only because they gave it.
 */
export function useRowGivesWay({
  controls,
  row,
  key,
  most,
  stacked,
}: {
  controls: RefObject<HTMLElement | null>;
  row: RefObject<HTMLElement | null>;
  key: string;
  /** The most chips shown while there is room. */
  most: number;
  stacked: boolean;
}): RowGivesWay {
  const fresh: State = { key, chips: "", stacked, most, hints: true, model: false };
  const [state, setState] = useState(fresh);
  const now = state.key === key ? state : fresh;

  useLayoutEffect(() => {
    const element = controls.current;
    if (!element) return;
    const list = element.querySelector<HTMLElement>(".composer-scope");
    const chips = list?.dataset.chips ?? "";
    if (now.chips !== chips || (stacked && !now.stacked)) {
      setState({ ...fresh, chips });
      return;
    }
    if (now.stacked !== stacked) {
      setState({ ...now, stacked });
      return;
    }
    const cut = (box: HTMLElement) => box.scrollWidth > box.clientWidth + 1;
    const tight = cut(element) || (list !== null && cut(list));
    const hinted = element.querySelector(".scope-chip-empty") !== null;
    const nameCut = Array.from(element.querySelectorAll<HTMLElement>(".scope-chip .truncate")).some(
      shortOfItsText,
    );
    if (now.hints && hinted && (tight || nameCut)) setState({ ...now, hints: false });
    else if (!tight) return;
    else if (list !== null && now.most > 1) setState({ ...now, most: now.most - 1 });
    else if (!now.model) setState({ ...now, model: true });
    // A lone chip's count says less than its name and saves little: it folds only once the model's
    // name is as short as it goes.
    else if (list !== null && now.most > 0) setState({ ...now, most: 0 });
  });

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    // The controls folding can flip the row between one line and two: only its width is the room.
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      setState((was) => ({
        key,
        chips: was.chips,
        stacked: was.stacked,
        most,
        hints: true,
        model: false,
      }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [row, key, most]);

  return now;
}
