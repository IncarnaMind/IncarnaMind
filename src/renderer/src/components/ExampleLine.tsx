import { useEffect } from "react";
import { useAgentsToAskRead, useNoModel, useReadAgentsToAsk } from "../askYourAi";
import { useGap, useT } from "../i18n";
import { allExamples, useAppStore } from "../store";
import { useAddYourDocuments } from "./AddYourDocuments";
import { ProblemLine } from "./ProblemLine";

/**
 * The example's one line, just above its input (#3791): that it is an example, the credit paper's
 * with the one figure its source contradicts, and the way to the User's own files. With no AI app
 * connected and no model set up, the input can't show, and the same block says to connect one, on
 * the same edge, line under line.
 */
export function ExampleLine({ mindId }: { mindId: string }) {
  const t = useT();
  const gap = useGap();
  const addMenu = useAddYourDocuments("example-add");
  const hasCheck = useAppStore((state) => {
    const group = allExamples(state).find((each) => each.mindId === mindId)?.group;
    return group !== undefined && group !== "tea";
  });
  const unseen = useAppStore((state) => state.settings?.device.gettingStarted.seen === false);
  const updateGettingStarted = useAppStore((state) => state.updateGettingStarted);
  const openSettings = useAppStore((state) => state.openSettings);
  const noModel = useNoModel();
  useReadAgentsToAsk(null);
  const connected = useAgentsToAskRead(null);
  // Shown, the example has been seen: an empty note of the User's own keeps no guide after that (#1940).
  useEffect(() => {
    if (unseen) updateGettingStarted({ seen: true });
  }, [unseen, updateGettingStarted]);
  const said = t(hasCheck ? "examples.line.credit" : "examples.line");
  return (
    <div data-mind-id={mindId} className="mind-measure example-line">
      <p data-testid="example-line">
        {said}
        {gap(said, t("examples.line.add"))}
        <button
          {...addMenu.buttonProps}
          type="button"
          data-testid="example-add-own"
          className="rounded-sm text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0"
        >
          {t("examples.line.add")}
        </button>
      </p>
      {noAiFor(noModel, connected) && (
        <ProblemLine
          role="status"
          testId="note-ask-no-ai"
          action={{
            label: t("noteAsk.connect"),
            testId: "note-ask-connect",
            onClick: () => openSettings("ai"),
          }}
        >
          {t("noteAsk.connectToAsk")}
        </ProblemLine>
      )}
      {addMenu.menu}
    </div>
  );
}

/** No way to ask in the example: no model set up, and no AI app connected (once that is read). */
export const noAiFor = (noModel: boolean, connected: readonly unknown[] | null): boolean =>
  noModel && connected !== null && connected.length === 0;
