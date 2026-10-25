import { Fragment, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Skill } from "../../../core/api";
import { menuTitleClass } from "../components/ui";
import { useT } from "../i18n";
import { skillTitle } from "../skills";
import type { ChoiceListHandle } from "./ScopePicker";
import { matchSlashItems, type SlashItem, skillSlashItems } from "./slashItems";

/** "Research…" in the list, before the Skills (#130). */
const RESEARCH_ID = "research";

/**
 * What "/" can choose in the composer: "Research…" (with a Mind in focus),
 * then the Skills for the next Question, filtered by what follows the slash
 * as the slash menu filters them. The first is chosen; arrows move and Enter
 * or Tab chooses (see `ChoiceListHandle`).
 */
export function SkillChoiceList({
  skills,
  describe,
  query,
  onChoose,
  onResearch,
  researchHint,
  onManage,
  id,
  onSelect,
  ref,
}: {
  /** The enabled Skills. */
  skills: readonly Skill[];
  describe(skill: Skill): string;
  query: string;
  onChoose(name: string): void;
  /** "Research…", when it can be chosen. */
  onResearch?(): void;
  /** What Research does with the composer's model: the web and the Library, or the Library only and why. */
  researchHint?: string;
  /** "Manage Skills…": Settings → Skills. */
  onManage(): void;
  /** The listbox's id, and its options' (`${id}-${index}`). */
  id: string;
  /** Hears which option is chosen, by its index (-1: none). */
  onSelect(index: number): void;
  ref?: Ref<ChoiceListHandle>;
}) {
  const t = useT();
  const research: SlashItem[] = onResearch
    ? [
        {
          id: RESEARCH_ID,
          label: "research.command",
          hint: researchHint ?? t("research.command.hint"),
          keywords: ["deep", "web", "sources"],
          icon: null,
          run: () => undefined,
        },
      ]
    : [];
  const items = [
    ...research,
    ...skillSlashItems(skills, describe, undefined, (skill) => skillTitle(skill.name, t)),
  ];
  const isBuiltIn = (item: SlashItem) =>
    skills.some((skill) => `skill-${skill.name}` === item.id && skill.builtIn);
  // The User's own first, then the built-in ones, as Settings lists them.
  const shown = matchSlashItems(items, query, (item) =>
    typeof item.label === "string" ? t(item.label) : item.label.text,
  ).sort((a, b) => Number(isBuiltIn(a)) - Number(isBuiltIn(b)));
  const isSkill = (item: SlashItem | undefined) => item !== undefined && item.id !== RESEARCH_ID;
  const shownSkills = shown.filter(isSkill);
  const grouped = shownSkills.some(isBuiltIn) && shownSkills.some((item) => !isBuiltIn(item));
  // The choice belongs to a query: typing more starts again from the top.
  const [choice, setChoice] = useState({ query, index: 0 });
  const selected = choice.query === query ? Math.min(choice.index, shown.length - 1) : 0;
  const setSelected = (index: number) => setChoice({ query, index });
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const reportSelected = useRef(onSelect);
  reportSelected.current = onSelect;
  const nameOf = (index: number) => {
    const label = shown[index]?.label;
    if (!label) return null;
    return typeof label === "string" ? t(label) : label.text;
  };
  const choose = (index: number) => {
    if (shown[index]?.id === RESEARCH_ID) {
      onResearch?.();
      return;
    }
    const id = shown[index]?.id;
    if (id?.startsWith("skill-")) onChoose(id.slice("skill-".length));
  };

  useEffect(() => {
    options.current[selected]?.scrollIntoView({ block: "nearest" });
    reportSelected.current(selected);
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.isComposing || shown.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((selected + step + shown.length) % shown.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        choose(selected);
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      id={id}
      role="listbox"
      data-testid="composer-skill-picker"
      aria-label={t("composer.skills.label")}
      className="editor-menu skill-choices"
    >
      {shown.length === 0 && <p className="editor-menu-empty">{t("editor.slash.empty")}</p>}
      {shown.map((item, index) => (
        <Fragment key={item.id}>
          {grouped &&
            isSkill(item) &&
            (!isSkill(shown[index - 1]) ||
              isBuiltIn(item) !== isBuiltIn(shown[index - 1] as SlashItem)) && (
              <p className={menuTitleClass}>
                {t(isBuiltIn(item) ? "skills.settings.builtIn" : "skills.settings.yours")}
              </p>
            )}
          <button
            ref={(element) => {
              options.current[index] = element;
            }}
            id={`${id}-${index}`}
            type="button"
            role="option"
            aria-selected={index === selected}
            data-testid={`slash-item-${item.id}`}
            // The composer keeps the focus.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelected(index)}
            onClick={() => choose(index)}
            title={item.hint}
            className="editor-menu-item skill-choice"
          >
            <span className="truncate">{nameOf(index)}</span>
            <span className="skill-choice-description truncate">{item.hint}</span>
          </button>
        </Fragment>
      ))}
      <button
        type="button"
        data-testid="composer-skills-manage"
        // The composer keeps the focus until the Settings page opens.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onManage}
        className="editor-menu-item skill-choice-manage"
      >
        {t("composer.skills.manage")}
      </button>
    </div>
  );
}
