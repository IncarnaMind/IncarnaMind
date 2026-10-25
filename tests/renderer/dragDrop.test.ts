import type { DragEvent } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Dragged,
  Dropped,
  DropTarget,
  OBJECTS_TYPE as ObjectsType,
} from "../../src/renderer/src/dragDrop";
import { moveLabel } from "../../src/renderer/src/moves";
import type { ObjectRef } from "../../src/renderer/src/objects";
import { type Undoable, useUndo } from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

// The drop's picture shrinking or fading, the motion module stood in for: there is no page here.
const settled: unknown[] = [];
const faded: unknown[] = [];
vi.mock("../../src/renderer/src/motion", () => ({
  exitToward: (element: unknown) => settled.push(element),
  exit: (element: unknown) => faded.push(element),
}));

// The window's own listeners, which the layer adds once a drag starts.
const windowListeners = new Map<string, ((event: unknown) => void)[]>();
const onWindow = (type: string, event: unknown) => {
  for (const listener of windowListeners.get(type) ?? []) listener(event);
};

type Layer = typeof import("../../src/renderer/src/dragDrop");
let layer: Layer;
let OBJECTS_TYPE: typeof ObjectsType;

interface FakeElement {
  children: unknown[];
  [field: string]: unknown;
}

function fakeElement(icon: unknown = null): FakeElement {
  const element: FakeElement = {
    children: [],
    className: "",
    dataset: {},
    style: {},
    textContent: "",
    classList: { remove() {} },
    append(child: unknown) {
      element.children.push(child);
    },
    remove() {},
    querySelector: () => icon,
    setAttribute() {},
    cloneNode: () => ({ ...element, children: [...element.children] }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  return element;
}

class FakeIcon {
  constructor(readonly name: string) {}
  cloneNode() {
    return new FakeIcon(this.name);
  }
  setAttribute() {}
}

beforeAll(async () => {
  Object.assign(globalThis, {
    document: { createElement: fakeElement, body: { append() {} } },
    SVGElement: FakeIcon,
    window: {
      addEventListener(type: string, listener: (event: unknown) => void) {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
      },
    },
  });
  layer = await import("../../src/renderer/src/dragDrop");
  OBJECTS_TYPE = layer.OBJECTS_TYPE;
});

beforeEach(() => {
  useUndo.setState({ done: [], undone: [], line: null });
  layer.useDragState.setState({ over: null, at: null, source: null });
  settled.length = 0;
  faded.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function dragEvent(
  types: string[],
  {
    data = {},
    inside = false,
    taken = false,
    from = fakeElement(),
  }: { data?: Record<string, string>; inside?: boolean; taken?: boolean; from?: FakeElement } = {},
) {
  const store = { ...data };
  const event = {
    clientX: 40,
    clientY: 60,
    defaultPrevented: taken,
    relatedTarget: {},
    currentTarget: { ...from, contains: () => inside },
    dataTransfer: {
      types,
      dropEffect: "none",
      effectAllowed: "uninitialized",
      files: [],
      items: [],
      getData: (type: string) => store[type] ?? "",
      setData: (type: string, value: string) => {
        store[type] = value;
        if (!types.includes(type)) types.push(type);
      },
      setDragImage() {},
    },
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event as typeof event & DragEvent<HTMLElement>;
}

const doc = (id: string): ObjectRef => ({ kind: "document", id });
const mind = (id: string): ObjectRef => ({ kind: "mind", id });

function startDragging(refs: ObjectRef[], from = fakeElement()) {
  const start = dragEvent([], { from });
  // A plain function behind a hook's name: it holds no state, so a test may call it here.
  const { useDragSource: sourceOf } = layer;
  sourceOf(() => ({ refs, name: "Budget", from: "sidebar" })).onDragStart(start);
  return {
    types: start.dataTransfer.types,
    data: { [OBJECTS_TYPE]: start.dataTransfer.getData(OBJECTS_TYPE) },
  };
}

function change(said: string): Undoable {
  return { said: () => said, undo: async () => {} };
}

function documentsTarget(dropped: Dropped[] = []): DropTarget {
  return {
    accepts: (dragged: Dragged) =>
      dragged.kind === "objects" && dragged.refs.every((ref) => ref.kind === "document")
        ? { kind: "add", said: () => "Add the Tag Contract" }
        : null,
    drop(what) {
      dropped.push(what);
      return Promise.resolve(change("Tagged 2 Documents Contract"));
    },
  };
}

const lit = () => layer.useDragState.getState().over?.key ?? null;

describe("a drop target", () => {
  test("lights while what is dragged is what it takes, from the move that enters it, and says what its drop would do", () => {
    const { types, data } = startDragging([doc("a"), doc("b")]);
    const target = layer.dropProps("tag", documentsTarget());
    target.onDragEnter(dragEvent(types, { data }));
    expect(lit()).toBe("tag");
    const over = dragEvent(types, { data });
    target.onDragOver(over);
    expect(lit()).toBe("tag");
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(layer.useDragState.getState().over?.effect.said?.((key) => key)).toBe(
      "Add the Tag Contract",
    );
    expect(layer.useDragState.getState().at).toEqual({ x: 40, y: 60 });
  });

  test("never lights for what it would refuse: a Mind among the Documents, files, a link", () => {
    const { types, data } = startDragging([doc("a"), mind("m")]);
    const target = layer.dropProps("tag", documentsTarget());
    const over = dragEvent(types, { data });
    target.onDragOver(over);
    expect(lit()).toBeNull();
    expect(over.defaultPrevented).toBe(false);
    for (const kinds of [["Files"], ["text/uri-list", "text/plain"]]) {
      target.onDragOver(dragEvent(kinds));
      expect(lit()).toBeNull();
    }
  });

  test("one lights at a time, a target inside another first, and leaving clears it", () => {
    const { types, data } = startDragging([doc("a")]);
    const inner = layer.dropProps("tag", documentsTarget());
    const outer = layer.dropProps("folder", documentsTarget());
    const over = dragEvent(types, { data });
    inner.onDragOver(over);
    outer.onDragOver(over);
    expect(lit()).toBe("tag");
    // Onto one of its own children: still over it.
    inner.onDragLeave(dragEvent(types, { data, inside: true }));
    expect(lit()).toBe("tag");
    inner.onDragLeave(dragEvent(types, { data }));
    expect(lit()).toBeNull();
    outer.onDragOver(dragEvent(types, { data }));
    expect(lit()).toBe("folder");
  });

  test("takes the drop and puts its change on the undo stack, with its line", async () => {
    const { types, data } = startDragging([doc("a"), doc("b")]);
    const dropped: Dropped[] = [];
    const target = layer.dropProps("tag", documentsTarget(dropped));
    target.onDragOver(dragEvent(types, { data }));
    const drop = dragEvent(types, { data });
    target.onDrop(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(lit()).toBeNull();
    expect(dropped).toEqual([{ kind: "objects", refs: [doc("a"), doc("b")], from: "sidebar" }]);
    await expect.poll(() => useUndo.getState().done.length).toBe(1);
    expect(useUndo.getState().line?.change?.said(String, String)).toBe(
      "Tagged 2 Documents Contract",
    );
  });

  test("leaves a drop a target inside took, and one it would refuse", () => {
    const { types, data } = startDragging([doc("a")]);
    const dropped: Dropped[] = [];
    const target = layer.dropProps("tag", documentsTarget(dropped));
    target.onDrop(dragEvent(types, { data, taken: true }));
    target.onDrop(dragEvent(["Files"]));
    expect(dropped).toEqual([]);
  });

  test("Move to… runs the same drop without a drag, and nothing for what it would refuse", async () => {
    const dropped: Dropped[] = [];
    await layer.runDrop(documentsTarget(dropped), [mind("m")]);
    expect(dropped).toEqual([]);
    await layer.runDrop(documentsTarget(dropped), [doc("a")]);
    expect(dropped).toEqual([{ kind: "objects", refs: [doc("a")] }]);
    expect(useUndo.getState().done).toHaveLength(1);
  });

  test("a folded target opens once the drag has rested on it", () => {
    vi.useFakeTimers();
    const { types, data } = startDragging([doc("a")]);
    let opened = 0;
    layer
      .dropProps("tag", documentsTarget(), () => {
        opened++;
      })
      .onDragOver(dragEvent(types, { data }));
    vi.advanceTimersByTime(699);
    expect(opened).toBe(0);
    vi.advanceTimersByTime(1);
    expect(opened).toBe(1);
  });

  test("goes dark when it leaves the page in mid-drag, and leaves another lit one be", () => {
    const { types, data } = startDragging([doc("a")]);
    layer.dropProps("tag", documentsTarget()).onDragOver(dragEvent(types, { data }));
    layer.releaseTarget("folder");
    expect(lit()).toBe("tag");
    layer.releaseTarget("tag");
    expect(lit()).toBeNull();
    expect(layer.useDragState.getState().at).toBeNull();
  });

  test("the picture that settles into the target on the drop is the one lifted, with the row's icon", () => {
    const { types, data } = startDragging([doc("a"), doc("b")], fakeElement(new FakeIcon("row")));
    const target = layer.dropProps("tag", documentsTarget());
    const into = fakeElement(new FakeIcon("tag"));
    target.onDragOver(dragEvent(types, { data, from: into }));
    target.onDrop(dragEvent(types, { data, from: into }));
    expect(settled).toHaveLength(1);
    const [picture] = settled as FakeElement[];
    expect(picture?.children[0]).toEqual(new FakeIcon("row"));
  });
});

describe("a drag let go where nothing takes it", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("on macOS", () => {
    beforeEach(() => {
      vi.stubGlobal("navigator", { platform: "MacIntel" });
    });

    test("is taken by the window, so it ends as it is let go, its picture fading there", () => {
      const { types, data } = startDragging([mind("m")]);
      const tag = layer.dropProps("tag", documentsTarget());
      const over = dragEvent(types, { data });
      tag.onDragOver(over);
      onWindow("dragover", over);
      expect(lit()).toBeNull();
      expect(over.defaultPrevented).toBe(true);
      expect(over.dataTransfer.dropEffect).toBe("move");
      const drop = dragEvent(types, { data });
      tag.onDrop(drop);
      onWindow("drop", drop);
      expect(drop.defaultPrevented).toBe(true);
      expect(faded).toHaveLength(1);
      expect(settled).toEqual([]);
      expect(layer.draggedIn({ types })).toBeNull();
    });

    test("leaves a drop a target took to it, and a drag from another app to the window", () => {
      const { types, data } = startDragging([doc("a")]);
      const tag = layer.dropProps("tag", documentsTarget());
      const over = dragEvent(types, { data });
      tag.onDragOver(over);
      onWindow("dragover", over);
      expect(over.dataTransfer.dropEffect).toBe("copy");
      const drop = dragEvent(types, { data });
      tag.onDrop(drop);
      onWindow("drop", drop);
      expect(settled).toHaveLength(1);
      expect(faded).toEqual([]);
      const files = dragEvent(["Files"]);
      onWindow("dragover", files);
      onWindow("drop", files);
      expect(files.defaultPrevented).toBe(false);
      expect(faded).toEqual([]);
    });
  });

  for (const platform of ["Win32", "Linux x86_64"]) {
    test(`stays refused on ${platform}, with the system's no-drop cursor, and the drag still ends`, () => {
      vi.stubGlobal("navigator", { platform });
      const { types, data } = startDragging([mind("m")]);
      const tag = layer.dropProps("tag", documentsTarget());
      const over = dragEvent(types, { data });
      tag.onDragOver(over);
      onWindow("dragover", over);
      expect(over.defaultPrevented).toBe(false);
      expect(over.dataTransfer.dropEffect).toBe("none");
      const drop = dragEvent(types, { data });
      tag.onDrop(drop);
      onWindow("drop", drop);
      expect(drop.defaultPrevented).toBe(false);
      expect(faded).toEqual([]);
      expect(settled).toEqual([]);
      expect(layer.draggedIn({ types })).toBeNull();
    });
  }
});

describe("files dragged from another app", () => {
  test("are known by their types until the drop, which names them", () => {
    const word = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const item = { kind: "file", type: word } as DataTransferItem;
    expect(
      layer.draggedIn({ types: ["Files"], items: [item] as never, files: [] as never }),
    ).toEqual({
      kind: "files",
      types: [word],
      names: null,
    });
    const file = { name: "Memo.docx" } as File;
    expect(
      layer.draggedIn({ types: ["Files"], items: [item] as never, files: [file] as never }),
    ).toEqual({ kind: "files", types: [word], names: ["Memo.docx"] });
  });
});

describe("what a drop on a Folder says", () => {
  const say = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
    translate(language, key, params);

  test("one by where it goes, several by how many of what, in English and Chinese", () => {
    expect(moveLabel(say("en"), { mindIds: ["m"] }, "Finance")).toBe("Move to Finance");
    expect(moveLabel(say("en"), { documentIds: ["a", "b", "c"] }, "Finance")).toBe(
      "Move 3 Documents to Finance",
    );
    expect(moveLabel(say("en"), { mindIds: ["m"], documentIds: ["a"] }, "Finance")).toBe(
      "Move 2 items to Finance",
    );
    expect(moveLabel(say("zh-CN"), { documentIds: ["a", "b"] }, "财务")).toBe(
      "将 2 个文档移动到“财务”",
    );
  });
});
