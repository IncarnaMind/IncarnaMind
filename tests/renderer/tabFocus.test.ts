import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stubEditorDom } from "../helpers/editorDom";

/*
 * A click on a Note's tab, or a shortcut that shows it, puts the focus in its text (#3115): the
 * editor drawn for the tab takes it, whether it is drawn before the ask or after, and a place the
 * User focused meanwhile keeps it.
 */

stubEditorDom();
const { focusShownContent, focusTab, takeContentFocus } = await import(
  "../../src/renderer/src/tabFocus"
);

beforeEach(() => {
  stubEditorDom();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Where the page has the focus now, as the test says. */
function focusOn(element: unknown): void {
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => element });
}

describe("the focus asked of a Note's tab", () => {
  // protects=the Note's text takes the focus a click or shortcut asked of its tab, drawn before the ask or after it, once, also when the content the ask came from has gone with the switch (#3115); fails_when=a Note shown by a click leaves the focus off its text, or takes it twice; no_claim=the window's drawing, which the smoke spec shows.
  test("goes to the Note's text drawn after the ask, or at once to one already drawn", () => {
    const tab = {};
    focusOn(tab);
    const later = vi.fn();
    focusShownContent("tab-1", "mind");
    const stop = takeContentFocus("tab-1", later);
    expect(later).toHaveBeenCalledTimes(1);
    focusShownContent("tab-1", "mind");
    expect(later).toHaveBeenCalledTimes(2);
    stop();

    const editor = {};
    focusOn(editor);
    focusShownContent("tab-2", "mind");
    focusOn(document.body);
    const drawn = vi.fn();
    const stopDrawn = takeContentFocus("tab-2", drawn);
    expect(drawn).toHaveBeenCalledTimes(1);
    stopDrawn();
    const elsewhere = takeContentFocus("tab-3", vi.fn());
    elsewhere();
  });

  // protects=a place the User focused before the Note is drawn keeps the focus, and an ask for another tab replaces the last (#3115); fails_when=the Note's text takes the focus from where the User moved it meanwhile; no_claim=which place the User moved to.
  test("a place focused before the Note is drawn, or an ask for another tab, leaves the focus alone", () => {
    const taken = vi.fn();
    focusOn({});
    focusShownContent("tab-1", "mind");
    focusOn({});
    takeContentFocus("tab-1", taken)();

    focusShownContent("tab-1", "mind");
    focusShownContent("tab-2", "mind");
    takeContentFocus("tab-1", taken)();
    expect(taken).not.toHaveBeenCalled();
  });

  // protects=a click on a Note's tab whose text was never drawn, as when its copy couldn't open yet, asks nothing more once the keyboard is on the tabs: the Note drawn later, reached by the arrow keys, leaves the focus on the tab list (#3115); fails_when=the Note reached by keyboard takes the focus from the tab list because of the earlier click; no_claim=the tab strip's keys, which the smoke spec presses.
  test("the keyboard on the tabs drops what an earlier click asked of a tab's text", async () => {
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    const tab = {};
    focusOn(tab);
    focusShownContent("tab-1", "mind");
    focusTab("tab-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const taken = vi.fn();
    takeContentFocus("tab-1", taken)();
    expect(taken).not.toHaveBeenCalled();
  });
});
