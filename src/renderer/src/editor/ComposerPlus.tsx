import { Fragment, type ReactNode, useEffect, useRef } from "react";
import type { Skill } from "../../../core/api";
import { type CommandContext, commands, labelOf, offered } from "../commands/registry";
import {
  AtLineIcon,
  ChevronRightLineIcon,
  PlusLineIcon,
  SearchLineIcon,
  SettingsLineIcon,
  SparkLineIcon,
  UploadLineIcon,
} from "../components/lineIcons";
import { menuClass, menuItemClass, menuRuleClass, menuTitleClass } from "../components/ui";
import { usePopoverMenu, useSubmenu } from "../components/usePopoverMenu";
import { useT } from "../i18n";
import { skillDescription, skillTitle } from "../skills";
import { useAppStore } from "../store";
import { type PlusRow, type PlusRowId, plusRows, plusSkillItems } from "./composerPlusRows";
import { TableIcon } from "./icons";

const COMPARE = "comparison.start";
const WINDOW: CommandContext = { selection: [], focus: null, surface: "mind" };

const iconClass = "size-4 shrink-0 text-ink-meta";
const keyClass = "pl-4 text-[13px] text-ink-meta";

/**
 * The + at the left of the composer's row (#2924). Each row calls what "/", "@" or ⌘K already
 * call (the composer's own choices are passed in), never an implementation of its own; the keys on
 * the rows only teach "@" and "/".
 */
export function ComposerPlus({
  skills,
  researchHint,
  onFiles,
  onNote,
  onResearch,
  onSkill,
  onManageSkills,
  onOpen,
}: {
  skills: readonly Skill[];
  /** What Research does with the composer's model, as "/" says it. */
  researchHint: string;
  onFiles(): void;
  onNote(): void;
  onResearch(): void;
  onSkill(name: string): void;
  onManageSkills(): void;
  /** The menu opened: a picker open beside it closes. */
  onOpen(): void;
}) {
  const t = useT();
  const menu = usePopoverMenu({ side: "above" });
  const skillsMenu = useSubmenu();
  const picking = useAppStore((state) => state.pickingDocuments);
  const compare = commands.get(COMPARE);

  const opened = useRef(onOpen);
  opened.current = onOpen;
  useEffect(() => {
    if (menu.open) opened.current();
  }, [menu.open]);

  const choose = (action: () => void) => () => {
    menu.close();
    action();
  };
  const rows = plusRows({
    picking,
    compare: menu.open && compare !== undefined && offered(compare, WINDOW),
  });

  const rowOf = (
    id: Exclude<PlusRowId, "skills">,
  ): { label: string; icon: ReactNode; run(): void } => {
    switch (id) {
      case "files":
        return {
          label: t("composer.plus.files"),
          icon: <UploadLineIcon className={iconClass} />,
          run: onFiles,
        };
      case "note":
        return {
          label: t("composer.plus.note"),
          icon: <AtLineIcon className={iconClass} />,
          run: onNote,
        };
      case "research":
        return {
          label: t("research.command"),
          icon: <SearchLineIcon className={iconClass} />,
          run: onResearch,
        };
      case "compare":
        return {
          label: compare ? labelOf(compare, WINDOW, t) : "",
          icon: <TableIcon className={iconClass} />,
          run: () => void commands.run(COMPARE, WINDOW).catch(useAppStore.getState().reportError),
        };
    }
  };

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="composer-plus"
        aria-label={t("composer.plus")}
        title={t("composer.plus")}
        className="composer-plus"
      >
        <PlusLineIcon className="size-3.5" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("composer.plus")}
        data-testid="composer-plus-menu"
        className={menuClass}
      >
        {menu.open &&
          rows.map((row) => (
            <Fragment key={row.id}>
              {row.ruleBefore && <div className={menuRuleClass} />}
              {row.id === "skills" ? (
                <button
                  {...skillsMenu.itemProps}
                  type="button"
                  data-testid="composer-plus-skills"
                  className={`${menuItemClass} pl-2 aria-expanded:bg-hover`}
                >
                  <SparkLineIcon className={iconClass} />
                  <span className="flex-1">{t("composer.skills.label")}</span>
                  <span className={keyClass}>{row.key}</span>
                  <ChevronRightLineIcon className="size-3.5 text-ink-meta" />
                </button>
              ) : (
                <PlusRowButton
                  row={row}
                  {...rowOf(row.id)}
                  title={row.id === "research" ? researchHint : undefined}
                  choose={choose}
                />
              )}
            </Fragment>
          ))}
      </div>
      <div
        {...skillsMenu.menuProps}
        role="menu"
        aria-label={t("composer.skills.label")}
        data-testid="composer-plus-skills-menu"
        className={menuClass}
      >
        {menu.open && (
          <>
            {plusSkillItems(skills).map((item) =>
              item.kind === "heading" ? (
                <p key={item.of} className={menuTitleClass}>
                  {t(item.of === "builtIn" ? "skills.settings.builtIn" : "skills.settings.yours")}
                </p>
              ) : (
                <button
                  key={item.skill.name}
                  type="button"
                  role="menuitem"
                  data-testid={`composer-plus-skill-${item.skill.name}`}
                  title={skillDescription(item.skill, t)}
                  onClick={choose(() => onSkill(item.skill.name))}
                  className={`${menuItemClass} pl-2`}
                >
                  <SparkLineIcon className={iconClass} />
                  <span className="truncate">{skillTitle(item.skill.name, t)}</span>
                </button>
              ),
            )}
            {skills.some((skill) => skill.enabled) && <div className={menuRuleClass} />}
            <button
              type="button"
              role="menuitem"
              data-testid="composer-plus-manage-skills"
              onClick={choose(onManageSkills)}
              className={`${menuItemClass} pl-2`}
            >
              <SettingsLineIcon className={iconClass} />
              {t("composer.skills.manage")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function PlusRowButton({
  row,
  label,
  icon,
  run,
  title,
  choose,
}: {
  row: PlusRow;
  label: string;
  icon: ReactNode;
  run(): void;
  title: string | undefined;
  choose(action: () => void): () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={`composer-plus-${row.id}`}
      disabled={row.disabled}
      title={title}
      onClick={choose(run)}
      className={`${menuItemClass} pl-2`}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {row.key && <span className={keyClass}>{row.key}</span>}
    </button>
  );
}
