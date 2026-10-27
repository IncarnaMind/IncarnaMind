import { beforeEach, describe, expect, test } from "vitest";
import type { Language } from "../../src/core/language";
import { saidInLine } from "../../src/renderer/src/lineNames";
import {
  makeInTurn,
  nextToRedo,
  nextToUndo,
  type Undoable,
  UndoRefused,
  undoReady,
  useUndo,
} from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The session's undo stack (docs/designs/interaction-system.md, C.6): ⌘Z takes
 * the last change back, ⇧⌘Z does it again, a new change ends what can be
 * redone, and an undo the core refuses leaves the stack as it should be.
 */

/** A change that records what was done to it, in `log`. */
function change(name: string, log: string[], { redo = true } = {}): Undoable {
  return {
    said: () => `Changed ${name}`,
    name: () => name,
    undo: async () => {
      log.push(`undo ${name}`);
    },
    ...(redo && {
      redo: async () => {
        log.push(`redo ${name}`);
      },
    }),
  };
}

const undo = () => useUndo.getState().undo();
const redo = () => useUndo.getState().redo();
const push = (each: Undoable) => useUndo.getState().push(each);
const noWords = (key: MessageKey) => key;
const names = (changes: readonly Undoable[]) => changes.map((each) => each.name?.(noWords));

beforeEach(() => {
  useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
});

describe("the undo stack", () => {
  test("a change pushed shows its line, and ⌘Z takes it back", async () => {
    const log: string[] = [];
    const moved = change("Move", log);
    push(moved);
    expect(useUndo.getState().line?.change).toBe(moved);
    await undo();
    expect(log).toEqual(["undo Move"]);
    expect(useUndo.getState().line).toBeNull();
    expect(names(useUndo.getState().done)).toEqual([]);
    expect(names(useUndo.getState().undone)).toEqual(["Move"]);
  });

  test("several changes undo in reverse order and redo in order", async () => {
    const log: string[] = [];
    for (const name of ["A", "B", "C"]) push(change(name, log));
    await undo();
    await undo();
    await undo();
    await redo();
    await redo();
    expect(log).toEqual(["undo C", "undo B", "undo A", "redo A", "redo B"]);
    expect(names(useUndo.getState().done)).toEqual(["A", "B"]);
    expect(names(useUndo.getState().undone)).toEqual(["C"]);
    // Done again, a change shows its line again.
    expect(useUndo.getState().line?.change?.name?.(noWords)).toBe("B");
  });

  test("a held ⌘Z steps back change by change, each undo after the one before", async () => {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const slow: Undoable = {
      said: () => "Slow",
      name: () => "Slow",
      undo: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            log.push("undo Slow");
            resolve();
          };
        }),
    };
    push(change("A", log));
    push(slow);
    const first = undo();
    const second = undo();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // The second waits for the first.
    expect(log).toEqual([]);
    finish();
    await Promise.all([first, second]);
    expect(log).toEqual(["undo Slow", "undo A"]);
  });

  // protects=⇧⌘Z pressed while an undo still runs is offered and waits its turn, and ⌘Z during a redo too, so a fast key is never dropped (#1361 review); fails_when=the menu offers nothing while a step runs, or the key is lost; no_claim=the menu's own timing.
  test("a step asked while another runs is offered, and waits its turn", async () => {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const slow: Undoable = {
      said: () => "Slow",
      name: () => "Slow",
      undo: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            log.push("undo Slow");
            resolve();
          };
        }),
      redo: async () => {
        log.push("redo Slow");
      },
    };
    push(slow);
    const back = undo();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(nextToRedo(useUndo.getState())).toBe(slow);
    expect(nextToUndo(useUndo.getState())).toBeUndefined();
    const again = redo();
    finish();
    await Promise.all([back, again]);
    expect(log).toEqual(["undo Slow", "redo Slow"]);
    expect(nextToUndo(useUndo.getState())).toBe(slow);
    expect(useUndo.getState().running).toBeNull();
  });

  // protects=⌘Z pressed while the first change is still being made is offered, waits for it and takes it, never an older change (#1886); fails_when=an empty stack disables ⌘Z while a change is queued, or the undo runs before the change lands; no_claim=the keymap's own binding.
  test("a ⌘Z pressed while a change is still being made is offered, and waits for it", async () => {
    const log: string[] = [];
    const moved = change("Move", log);
    let land: () => void = () => undefined;
    const held = new Promise<Undoable>((resolve) => {
      land = () => resolve(moved);
    });
    const making = makeInTurn(() => held);
    try {
      // Nothing on the stack yet, but ⌘Z has something coming.
      expect(undoReady(useUndo.getState())).toBe(true);
      const back = undo();
      land();
      // As the command registry does once what a command made lands.
      push(await making);
      await back;
    } finally {
      land();
    }
    expect(log).toEqual(["undo Move"]);
    expect(names(useUndo.getState().undone)).toEqual(["Move"]);
    expect(undoReady(useUndo.getState())).toBe(false);
  });

  test("a new change ends what can be redone", async () => {
    const log: string[] = [];
    push(change("A", log));
    push(change("B", log));
    await undo();
    push(change("C", log));
    expect(names(useUndo.getState().undone)).toEqual([]);
    await redo();
    expect(log).toEqual(["undo B"]);
    expect(names(useUndo.getState().done)).toEqual(["A", "C"]);
  });

  test("the same change offered twice, by its action and by its command, is one step", () => {
    const moved = change("Move", []);
    push(moved);
    push(moved);
    expect(useUndo.getState().done).toEqual([moved]);
  });

  test("a change that can't be redone, once taken back, ends what can be redone", async () => {
    const log: string[] = [];
    push(change("A", log, { redo: false }));
    push(change("B", log));
    await undo();
    expect(names(useUndo.getState().undone)).toEqual(["B"]);
    await undo();
    expect(names(useUndo.getState().undone)).toEqual([]);
    await redo();
    expect(log).toEqual(["undo B", "undo A"]);
  });

  test("an undo the core refuses shows one problem line, and leaves the change done", async () => {
    const log: string[] = [];
    push(change("A", log));
    push({
      said: () => "Renamed",
      name: () => "Rename",
      undo: () =>
        Promise.reject(
          new Error("Error invoking remote method 'core:x': NotFoundError: It was deleted."),
        ),
    });
    await undo();
    const { line, done } = useUndo.getState();
    expect(line?.problem?.step).toBe("undo");
    expect(line?.problem?.reason(noWords)).toBe("It was deleted.");
    expect(line?.problem?.fix).toBeNull();
    // It can never be taken back: the next ⌘Z reaches the change before it.
    expect(names(done)).toEqual(["A"]);
    await undo();
    expect(log).toEqual(["undo A"]);
  });

  test("an undo refused with a fix stays on the stack; the fix lets it happen", async () => {
    const log: string[] = [];
    let folderBack = false;
    push({
      said: () => "Moved “Shortlist” to Research",
      name: () => "Move",
      undo: async () => {
        if (!folderBack)
          throw new UndoRefused(() => "“Finance” is deleted", {
            label: () => "Restore Finance",
            run: async () => {
              folderBack = true;
            },
          });
        log.push("undo Move");
      },
      redo: async () => undefined,
    });
    await undo();
    const problem = useUndo.getState().line?.problem;
    expect(problem?.reason(noWords)).toBe("“Finance” is deleted");
    expect(problem?.fix?.label(noWords)).toBe("Restore Finance");
    expect(names(useUndo.getState().done)).toEqual(["Move"]);
    await problem?.fix?.run();
    expect(log).toEqual(["undo Move"]);
    expect(names(useUndo.getState().done)).toEqual([]);
    expect(names(useUndo.getState().undone)).toEqual(["Move"]);
  });

  test("a refused redo stays undone with its fix, or leaves without one", async () => {
    const failing: Undoable = {
      said: () => "Deleted",
      name: () => "Delete",
      undo: async () => undefined,
      redo: () => Promise.reject(new Error("It isn't there.")),
    };
    push(failing);
    await undo();
    await redo();
    const problem = useUndo.getState().line?.problem;
    expect(problem?.step).toBe("redo");
    expect(problem?.reason(noWords)).toBe("It isn't there.");
    expect(problem?.fix).toBeNull();
    expect(useUndo.getState().undone).toEqual([]);
    expect(useUndo.getState().done).toEqual([]);
  });

  test("an undo refused in its own words with no fix leaves the stack, saying so", async () => {
    const log: string[] = [];
    push(change("A", log));
    push({
      said: () => "Renamed",
      name: () => "Rename",
      undo: () => Promise.reject(new UndoRefused(() => "One change couldn't be taken back.", null)),
    });
    await undo();
    expect(useUndo.getState().line?.problem?.reason(noWords)).toBe(
      "One change couldn't be taken back.",
    );
    expect(useUndo.getState().line?.problem?.fix).toBeNull();
    expect(names(useUndo.getState().done)).toEqual(["A"]);
  });

  test("a chosen change moves between the stacks without disturbing the others", async () => {
    const log: string[] = [];
    const [a, b, c] = ["A", "B", "C"].map((name) => change(name, log));
    if (!a || !b || !c) throw new Error("No changes.");
    push(a);
    push(b);
    push(c);
    await useUndo.getState().undo(b);
    expect(names(useUndo.getState().done)).toEqual(["A", "C"]);
    expect(names(useUndo.getState().undone)).toEqual(["B"]);
    await useUndo.getState().redo();
    expect(names(useUndo.getState().done)).toEqual(["A", "C", "B"]);
    expect(log).toEqual(["undo B", "redo B"]);
  });

  test("a change withdrawn while its Undo runs never comes back as Redo", async () => {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const slow: Undoable = {
      said: () => "Slow",
      name: () => "Slow",
      undo: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      redo: async () => {
        log.push("redo Slow");
      },
    };
    push(slow);
    const back = undo();
    for (let index = 0; index < 3; index++) await Promise.resolve();
    expect(useUndo.getState().running?.change).toBe(slow);
    useUndo.getState().withdraw(slow);
    finish();
    await back;
    expect(useUndo.getState().running).toBeNull();
    expect(useUndo.getState().done).toEqual([]);
    expect(useUndo.getState().undone).toEqual([]);
    await redo();
    expect(log).toEqual([]);
  });

  test("a change renewed as more of it lands goes back on top, past the User's own", async () => {
    const log: string[] = [];
    const request = change("Request", log);
    push(request);
    push(change("Mine", log));
    useUndo.getState().renew(request);
    expect(names(useUndo.getState().done)).toEqual(["Mine", "Request"]);
    expect(useUndo.getState().line?.change).toBe(request);
    await undo();
    expect(log).toEqual(["undo Request"]);
  });

  test("a change withdrawn leaves the stack and its line", () => {
    const log: string[] = [];
    const accepted = change("Accept", log);
    push(change("A", log));
    push(accepted);
    useUndo.getState().withdraw(accepted);
    expect(names(useUndo.getState().done)).toEqual(["A"]);
    expect(useUndo.getState().line).toBeNull();
  });
});

describe("the lines follow the interface language", () => {
  let language: Language;
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  const shown = () => {
    const change = useUndo.getState().line?.change;
    return change && saidInLine(t, change.said).message;
  };

  beforeEach(() => {
    language = "en";
  });

  test("a line made in English reads in Chinese once the language switches, and Undo still works", async () => {
    const log: string[] = [];
    push({
      said: (t) => t("undo.folderEdited", { name: "Tides" }),
      undo: async () => {
        log.push("undo");
      },
    });
    expect(shown()).toBe("Changed the Folder “Tides”");
    language = "zh-CN";
    expect(shown()).toBe("已修改文件夹“Tides”");
    await undo();
    expect(log).toEqual(["undo"]);
  });

  test("a name in a line is kept, and cut when it is long, in either language", () => {
    const long = "Quarterly review of harbour dues and the wider coastal levy schedule 2026";
    push({ said: (t) => t("undo.folderEdited", { name: long }), undo: async () => undefined });
    expect(shown()).toMatch(/^Changed the Folder “Quarterly.*…/u);
    language = "zh-CN";
    expect(shown()).toMatch(/^已修改文件夹“Quarterly.*…/u);
    expect(shown()).not.toContain(long);
  });

  test("the extra action's label and the Edit menu's name follow it too", () => {
    push({
      said: (t) => t("citationStyle.prompt.dismissed"),
      name: (t) => t("undo.name.rename"),
      undo: async () => undefined,
      also: { label: (t) => t("citationStyle.change"), testId: "undo-change-style", run: () => {} },
    });
    const change = useUndo.getState().line?.change;
    expect(change?.also?.label(t)).toBe("Change");
    expect(change?.name?.(t)).toBe("Rename");
    language = "zh-CN";
    expect(change?.also?.label(t)).toBe("更改");
    expect(change?.name?.(t)).toBe("重命名");
  });

  test("the Edit menu's Undo puts a name the change quotes in ‘ ’, inside its own “ ” (#1405)", () => {
    language = "zh-CN";
    const action = (key: MessageKey) => t(key, { name: "交易资料" });
    expect(t("menu.undo.named", { action: action("undo.name.linkFolder") })).toBe(
      "撤销“添加同步文件夹‘交易资料’”",
    );
    expect(t("menu.undo.named", { action: action("undo.name.move") })).toBe("撤销“移动‘交易资料’”");
    expect(t("menu.redo.named", { action: action("undo.name.delete") })).toBe(
      "重做“删除‘交易资料’”",
    );
  });

  test("a refused undo's reason and fix follow it, and stay for the fix", async () => {
    push({
      said: (t) => t("object.deleted", { name: "Plan" }),
      undo: async () => {
        throw new UndoRefused((t) => t("undo.folderGone", { name: "Finance" }), {
          label: (t) => t("undo.restoreFolder", { name: "Finance" }),
          run: async () => undefined,
        });
      },
    });
    await undo();
    const problem = useUndo.getState().line?.problem;
    expect(problem?.reason(t)).toBe("“Finance” is deleted");
    expect(problem?.fix?.label(t)).toBe("Restore Finance");
    language = "zh-CN";
    expect(problem?.reason(t)).toBe("“Finance”已删除");
    expect(problem?.fix?.label(t)).toBe("恢复“Finance”");
  });
});
