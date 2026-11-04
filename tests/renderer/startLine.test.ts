import { expect, test, vi } from "vitest";
import type { CoreBridge, Mind } from "../../src/core/api";
import type { FilesBridge, UnexpectedEnd } from "../../src/shared/bridge";

/** An answer the test gives when it chooses, as the main process does in its own time. */
function later<T>() {
  let give: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    give = resolve;
  });
  return { promise, give };
}

const answers = vi.hoisted(() => ({
  lost: null as unknown as { promise: Promise<number | null>; give(value: number | null): void },
  ended: null as unknown as {
    promise: Promise<UnexpectedEnd | null>;
    give(value: UnexpectedEnd | null): void;
  },
  minds: [] as Pick<Mind, "id" | "title" | "autoTitle">[],
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    unsavedChanges: async () => null,
    takeLostChanges: () => answers.lost.promise,
    listMinds: async () => answers.minds,
  } satisfies Partial<Record<keyof CoreBridge, unknown>>,
  files: {
    takeUnexpectedEnd: () => answers.ended.promise,
  } satisfies Partial<FilesBridge>,
}));
vi.mock("../../src/renderer/src/notices", () => ({
  useNotices: { getState: () => ({ showError: (error: unknown) => Promise.reject(error) }) },
}));

/** The lines the window would show, in order, from its start until every answer is in. */
async function linesShown(answer: () => void) {
  vi.resetModules();
  answers.lost = later();
  answers.ended = later();
  const { useUnsavedChanges } = await import("../../src/renderer/src/unsavedChanges");
  const { lastRunLine } = await import("../../src/renderer/src/lastRunLine");
  const shown: (string | null)[] = [lastRunLine(useUnsavedChanges.getState())?.key ?? null];
  useUnsavedChanges.subscribe((state) => {
    const key = lastRunLine(state)?.key ?? null;
    if (key !== shown.at(-1)) shown.push(key);
  });
  answer();
  await vi.waitFor(() => expect(useUnsavedChanges.getState().ended).not.toBeNull());
  return { shown, state: useUnsavedChanges.getState() };
}

// protects=the start-up line is one statement, said once every answer is in (#2309); fails_when=the window shows "may not have been saved" and then switches to how many were lost, two claims a screen reader reads both of; no_claim=what each line says.
test("the start-up line waits for both answers, so it never says one thing and then another", async () => {
  const { shown } = await linesShown(() => {
    answers.ended.give({ kind: "app" });
    setTimeout(() => answers.lost.give(3));
  });
  expect(shown).toEqual([null, "unsaved.lost"]);
});

// protects=a session's end that left its changes in one Note names it, looked up as the line is shown, with Open (#2309); fails_when=the line shows the count alone before the name arrives, or names a Note it doesn't know; no_claim=how Open opens it.
test("a session's end in one Note waits for its name too, and opens it", async () => {
  answers.minds = [{ id: "mind-1", title: "", autoTitle: "Lease review" }];
  const { shown, state } = await linesShown(() => {
    answers.lost.give(2);
    answers.ended.give({ kind: "session", unsaved: 2, minds: [{ mindId: "mind-1", count: 2 }] });
  });
  expect(shown).toEqual([null, "unexpectedEnd.session.note"]);
  expect(state.note).toEqual({ mindId: "mind-1", name: "Lease review" });

  answers.minds = [];
  const gone = await linesShown(() => {
    answers.lost.give(2);
    answers.ended.give({ kind: "session", unsaved: 2, minds: [{ mindId: "mind-1", count: 2 }] });
  });
  expect(gone.shown).toEqual([null, "unexpectedEnd.session"]);
});
