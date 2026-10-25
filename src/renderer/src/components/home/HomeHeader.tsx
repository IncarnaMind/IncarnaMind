import { formatLongDay, partOfDay } from "../../../../shared/dates";
import { menuKeysLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { useHomeNeeds, useOwnMinds } from "../../home";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { PencilLineIcon } from "../lineIcons";
import { NewMenu } from "../NewMenu";
import { primaryButtonClass } from "../ui";

const linkClass =
  "rounded-sm font-semibold text-ink underline-offset-2 hover:underline hover:decoration-rule-strong";

export function HomeHeader({ now }: { now: Date }) {
  const t = useT();
  const language = useLanguage();
  const own = useOwnMinds().length;
  const { reading, suggestions } = useHomeNeeds();
  const command = commands.get("mind.new");
  const keys = command ? menuKeysLabel(command) : null;
  const newMind = t("menu.newMind");
  const needs = [
    ...(reading > 0
      ? [
          {
            id: "reading",
            label: reading === 1 ? t("home.reading.one") : t("home.reading", { count: reading }),
          },
        ]
      : []),
    ...(suggestions > 0
      ? [
          {
            id: "suggestions",
            label:
              suggestions === 1
                ? t("home.suggestions.one")
                : t("home.suggestions", { count: suggestions }),
          },
        ]
      : []),
  ];

  return (
    <header className="mt-2 mb-8 flex items-start gap-4 @max-[480px]/home:flex-col">
      <div className="min-w-0 flex-1">
        <h1
          data-testid="home-greeting"
          className="text-[34px] leading-[42px] font-semibold tracking-[-0.01em] text-ink"
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
                    onClick={() =>
                      useAppStore
                        .getState()
                        .openLibrary(need.id === "suggestions" ? "review" : "all")
                    }
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
      <div className="mt-1.5 flex shrink-0 gap-px">
        <button
          type="button"
          data-testid="home-new-mind"
          title={keys ? `${newMind} (${keys})` : newMind}
          onClick={() => void commands.run("mind.new").catch(useAppStore.getState().reportError)}
          className={`${primaryButtonClass} rounded-r-none`}
        >
          <PencilLineIcon className="size-3.5" />
          {newMind}
        </button>
        <NewMenu place="home" />
      </div>
    </header>
  );
}
