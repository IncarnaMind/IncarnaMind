import { useLayoutEffect, useRef } from "react";
import { useHomeView, useMinuteClock, useOwnMinds } from "../../home";
import { useT } from "../../i18n";
import { rowsIn, useSelectionOrder } from "../../selection";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { ComingUp } from "./ComingUp";
import { FolderCards } from "./FolderCards";
import { HomeHeader } from "./HomeHeader";
import { RecentMinds } from "./RecentMinds";

export function HomePane() {
  const t = useT();
  const now = useMinuteClock();
  const documents = useAppStore((state) => state.documents.length);
  const folders = useAppStore((state) => state.library?.groups.length ?? 0);
  const minds = useOwnMinds().length;
  const empty = documents === 0 && folders === 0 && minds === 0;
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = useHomeView.getState().scrollTop;
  }, []);
  // ⌘A takes the list the focus is in: Recent or the Folders.
  useSelectionOrder("home", () => {
    const list = document.activeElement?.closest("[aria-multiselectable]");
    return rowsIn(list && scroller.current?.contains(list) ? list : scroller.current);
  });
  return (
    <section
      data-testid="home"
      data-surface="home"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet text-ui text-ink"
    >
      <div
        ref={scroller}
        data-testid="home-scroller"
        onScroll={(event) => useHomeView.setState({ scrollTop: event.currentTarget.scrollTop })}
        className="@container/home min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[760px] px-6 pt-10 pb-24 @max-[760px]/home:px-4 @max-[760px]/home:pt-8">
          <HomeHeader now={now} />
          {empty && (
            <ProblemLine
              role="status"
              testId="home-empty"
              className="mb-7"
              action={{
                label: t("startGuide.documents.addFiles"),
                testId: "home-empty-add-files",
                onClick: () => void useAppStore.getState().pickDocuments(),
              }}
              also={{
                label: t("startGuide.documents.linkFolder"),
                testId: "home-empty-link-folder",
                onClick: () => void useAppStore.getState().addLinkedFolder(),
              }}
            >
              {t("library.none")}
            </ProblemLine>
          )}
          <ComingUp now={now} />
          <RecentMinds now={now} />
          <FolderCards now={now} />
        </div>
      </div>
    </section>
  );
}
