import { formatLongDay, partOfDay } from "../../../../shared/dates";
import { useHomeNeeds, useOwnMinds } from "../../home";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";

const linkClass =
  "rounded-sm text-ink underline-offset-2 hover:underline hover:decoration-rule-strong";

export function HomeHeader({ now }: { now: Date }) {
  const t = useT();
  const language = useLanguage();
  const own = useOwnMinds().length;
  const { reading } = useHomeNeeds();
  const needs = [
    ...(reading > 0
      ? [
          {
            id: "reading",
            label: reading === 1 ? t("home.reading.one") : t("home.reading", { count: reading }),
          },
        ]
      : []),
  ];

  return (
    <header className="mt-2 mb-6 flex items-start gap-4 @max-[480px]/home:flex-col">
      <div className="min-w-0 flex-1">
        <h1
          data-testid="home-greeting"
          className="text-title leading-[42px] font-semibold tracking-[-0.01em] text-ink"
        >
          {t(`home.greeting.${partOfDay(now)}`)}
        </h1>
        <p
          data-testid="home-line"
          className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui text-ink-secondary"
        >
          {own === 0 ? (
            t("home.welcome")
          ) : (
            <>
              <span>{formatLongDay(now, language, { now })}</span>
              {needs.map((need) => (
                <span key={need.id} className="contents">
                  <span aria-hidden="true" className="text-ink-placeholder">
                    ·
                  </span>
                  <button
                    type="button"
                    data-testid={`home-need-${need.id}`}
                    onClick={() => useAppStore.getState().openLibrary("all")}
                    className={linkClass}
                  >
                    {need.label}
                  </button>
                </span>
              ))}
            </>
          )}
        </p>
      </div>
    </header>
  );
}
