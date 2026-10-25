import type { AudioSource } from "../../../core/api";
import { useT } from "../i18n";

/** The pane to open in System Settings, as the system names it. */
export function GuideWhere({ source }: { source: AudioSource }) {
  const t = useT();
  return <p className="text-ink-meta">{t(`meetings.guide.where.${source}`)}</p>;
}

/** What to click, step by step. */
export function GuideSteps({
  source,
  status,
}: {
  source: AudioSource;
  status: "waiting" | "granted";
}) {
  const t = useT();
  return (
    <>
      <GuideWhere source={source} />
      <ol className="flex list-none flex-col gap-1.5 p-0">
        {(["meetings.guide.step1", "meetings.guide.step2"] as const).map((key, index) => (
          <li key={key} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-chip text-[11px] font-bold text-ink-meta"
            >
              {index + 1}
            </span>
            <span className={status === "granted" ? "text-ink-meta" : undefined}>{t(key)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The row to switch on, as System Settings draws it. */
export function GuideRow({ on }: { on: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="my-1 flex h-10 items-center gap-2 rounded-lg bg-frame px-2.5 text-ink"
    >
      <span className="inline-flex size-6 items-center justify-center rounded-md bg-ink text-[10px] font-bold text-white">
        IM
      </span>
      <span className="grow">IncarnaMind</span>
      <span
        data-on={on}
        className="relative inline-block h-5 w-9 rounded-full bg-chip ring-2 ring-sheet outline-2 outline-accent data-[on=true]:bg-accent"
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow ${on ? "left-[18px]" : "left-0.5"}`}
        />
      </span>
    </div>
  );
}
