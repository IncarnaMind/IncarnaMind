import type { Meeting, Skill } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { translate } from "../../../../shared/i18n";
import { core } from "../../core";
import type { SlashItem } from "../../editor/slashItems";
import { useT } from "../../i18n";
import { skillsInListOrder, skillTitle } from "../../skillText";
import { useAppStore } from "../../store";
import { CheckLineIcon, ChevronDownLineIcon } from "../lineIcons";
import { menuFrameClass, menuItemClass, menuRuleClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

export const meetingWriteupSkills = (skills: readonly Skill[]) =>
  skillsInListOrder(skills.filter((skill) => skill.enabled && skill.meetingTemplate));

export function canChooseMeetingTemplate(meeting: Meeting): boolean {
  return (
    meeting.kind === "meeting" &&
    (meeting.status !== "stopped" ||
      (meeting.transcript?.state === "saved" &&
        meeting.fill?.state !== "waiting" &&
        meeting.fill?.state !== "filling"))
  );
}

export async function applyMeetingWriteupTemplate(
  meetingId: string,
  templateId: string | null,
): Promise<boolean> {
  try {
    await core.setMeetingWriteupTemplate(meetingId, templateId);
    return true;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
}

export function meetingTemplateSlashItems(
  meeting: Meeting | undefined,
  skills: readonly Skill[],
  language: Language,
): SlashItem[] {
  if (meeting?.status !== "stopped" || !canChooseMeetingTemplate(meeting)) return [];
  return meetingWriteupSkills(skills).map((skill) => ({
    id: `meeting-template-${skill.name}`,
    label: { text: skillTitle(skill.name, (key, params) => translate(language, key, params)) },
    section: "skills.settings.meetings",
    keywords: ["meeting", "template", "会议", "模板"],
    icon: "≡",
    run(editor, range) {
      editor.chain().focus().deleteRange(range).run();
      void applyMeetingWriteupTemplate(meeting.id, skill.id);
    },
  }));
}

export function MeetingTemplateRows({
  meeting,
  onChoose,
}: {
  meeting: Meeting;
  onChoose(templateId: string | null): void;
}) {
  const t = useT();
  const choices = meetingWriteupSkills(useAppStore((state) => state.skills));
  const chosen = choices.find((skill) => skill.id === meeting.writeupTemplateId);
  const rows = [
    { id: null, title: t("meetings.template.none") },
    ...choices.map((skill) => ({
      id: skill.id,
      title: skillTitle(skill.name, t),
      name: skill.name,
    })),
  ];
  return (
    <>
      {rows.map((row) => {
        const selected = row.id === (chosen?.id ?? null);
        return (
          <button
            key={row.id ?? "default"}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            data-testid={`meeting-writeup-${"name" in row ? row.name : "default"}`}
            className={`${menuItemClass} pl-2`}
            onClick={() => onChoose(row.id)}
          >
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
              {selected && <CheckLineIcon className="size-4" />}
            </span>
            <span className="min-w-0 truncate">{row.title}</span>
          </button>
        );
      })}
      {meeting.status === "stopped" && (
        <>
          <hr className={menuRuleClass} />
          <button
            type="button"
            role="menuitem"
            data-testid="meeting-writeup-again"
            className={`${menuItemClass} pl-7`}
            onClick={() => onChoose(chosen?.id ?? null)}
          >
            {t("meetings.template.fillAgain")}
          </button>
        </>
      )}
    </>
  );
}

export function useMeetingTemplateLabel(meeting: Meeting): string {
  const t = useT();
  const skill = useAppStore((state) =>
    state.skills.find(
      (skill) => skill.id === meeting.writeupTemplateId && skill.enabled && skill.meetingTemplate,
    ),
  );
  return t("meetings.template.selection", {
    name: skill ? skillTitle(skill.name, t) : t("meetings.template.none"),
  });
}

export function MeetingTemplatePicker({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const label = useMeetingTemplateLabel(meeting);
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  const available = useAppStore((state) =>
    state.skills.some((skill) => skill.meetingTemplate && skill.enabled),
  );
  if (!available) return null;

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="meeting-writeup-template"
        data-fold="template"
        aria-label={label}
        title={label}
        className="meeting-button meeting-button--words max-w-40"
      >
        <span className="meeting-button-label">{label}</span>
        <ChevronDownLineIcon className="size-3 shrink-0" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("skills.settings.meetings")}
        className={`${menuFrameClass} w-64 max-w-[calc(100vw-16px)]`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("meetings.template.chip")}</p>
            <MeetingTemplateRows
              meeting={meeting}
              onChoose={(id) => {
                menu.close();
                void applyMeetingWriteupTemplate(meeting.id, id);
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
