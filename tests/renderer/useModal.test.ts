import { describe, expect, test } from "vitest";
import { type EscCloseDialog, watchEscClose } from "../../src/renderer/src/components/useModal";

/*
 * What a dialog's own `close` means at the shared Esc rule (#2121). The browser follows the
 * close-watcher rules: Esc on a dialog the app showed itself, or after a cancel already used the
 * activation, closes the dialog without a `cancel` first. That close must reach the dialog's own
 * `onClose` as it always did, and nothing may show the dialog again; only a close that finds the
 * dialog shown again is old news.
 */

/** A dialog standing in for the native one, running capture listeners before bubble ones. */
class FakeDialog implements EscCloseDialog {
  open = true;
  shown = 0;
  private listeners: { type: string; listener: (event: Event) => void; capture: boolean }[] = [];

  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.listeners.push({ type, listener, capture: options === true });
  }

  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const capture = options === true;
    this.listeners = this.listeners.filter(
      (each) => !(each.type === type && each.listener === listener && each.capture === capture),
    );
  }

  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, "target", { value: this, configurable: true });
    Object.defineProperty(event, "currentTarget", { value: this, configurable: true });
    let stopped = false;
    const stop = event.stopImmediatePropagation.bind(event);
    Object.defineProperty(event, "stopImmediatePropagation", {
      value: () => {
        stopped = true;
        stop();
      },
      configurable: true,
    });
    const listeners = this.listeners.filter((each) => each.type === event.type);
    for (const each of [
      ...listeners.filter((one) => one.capture),
      ...listeners.filter((one) => !one.capture),
    ]) {
      if (stopped) break;
      each.listener.call(this, event);
    }
    return !event.defaultPrevented;
  }

  showModal(): void {
    this.open = true;
    this.shown += 1;
  }
}

describe("the Esc rule on a native dialog", () => {
  test("a close with no cancel before it closes the dialog's own store, and shows it no more", () => {
    const dialog = new FakeDialog();
    let storeOpen = true;
    dialog.addEventListener("close", () => {
      storeOpen = false;
    });
    const stop = watchEscClose(dialog);

    // The browser closed it itself, as it does on an Esc without history-action activation.
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));

    expect(storeOpen).toBe(false);
    expect(dialog.shown).toBe(0);
    stop();
  });

  test("an Esc nothing prevented reports the close while the dialog is still open", () => {
    const dialog = new FakeDialog();
    const closed = { whileOpen: 0 };
    dialog.addEventListener("close", () => {
      if (dialog.open) closed.whileOpen += 1;
    });
    const stop = watchEscClose(dialog);

    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

    expect(closed.whileOpen).toBe(1);
    stop();
  });

  test("a close that finds the dialog shown again is old news", () => {
    const dialog = new FakeDialog();
    let closes = 0;
    dialog.addEventListener("close", () => {
      closes += 1;
    });
    const stop = watchEscClose(dialog);

    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(closes).toBe(1);

    // The ask that followed the Esc showed it again before the browser's own close was heard.
    dialog.showModal();
    dialog.dispatchEvent(new Event("close"));
    expect(closes).toBe(1);
    stop();
  });

  test("an Esc the dialog prevents is left alone", () => {
    const dialog = new FakeDialog();
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    let closes = 0;
    dialog.addEventListener("close", () => {
      closes += 1;
    });
    const stop = watchEscClose(dialog);

    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

    expect(closes).toBe(0);
    expect(dialog.open).toBe(true);
    stop();
  });
});
