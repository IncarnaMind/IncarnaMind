import { useEffect, useId, useRef, useState } from "react";
import {
  SKILL_LIMITS,
  SKILL_SCRIPT_LIMITS,
  type Skill,
  type SkillDraft,
  type SkillImportError,
  type SkillImportPreview,
} from "../../../core/api";
import { newestReads } from "../../../core/newest";
import type { SkillPickKind } from "../../../shared/bridge";
import { core, files } from "../core";
import { errorMessage } from "../errors";
import { showFileLabelKey } from "../fileInfo";
import { useT } from "../i18n";
import { savedFolderLabel } from "../outputFiles";
import { formatSize, pickSkill, skillDescription, skillShortLine, skillTitle } from "../skills";
import { useAppStore } from "../store";
import { DetailsLine } from "./DetailsLine";
import { ExportLineIcon, MoreLineIcon, PlusLineIcon } from "./lineIcons";
import { MetaLine } from "./MetaLine";
import { ProblemLine, ProblemMark } from "./ProblemLine";
import { SkillEditor } from "./SkillEditor";
import {
  buttonClass,
  errorTextClass,
  ghostButtonClass,
  iconButtonClass,
  menuClass,
  menuItemClass,
  menuRuleClass,
  noticeClass,
  pageIntroClass,
  primaryButtonClass,
  rowStatusClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRow,
  ruledRowClass,
  sectionNoteClass,
  sectionTitleClass,
} from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/** What the editor in Settings is for: a new Skill, or changing one of the User's. */
type Editing = { kind: "new" } | { kind: "edit"; skill: Skill; draft: SkillDraft };

/** How the last Export as zip went. */
type Exported =
  | { kind: "saved"; name: string; path: string; folder: string; inDefaultFolder: boolean }
  | { kind: "not-allowed"; skill: Skill; linkedFolderId: string; folder: string }
  | { kind: "failed"; message: string };

const NEW_SKILL: SkillDraft = { name: "", description: "", steps: "" };

/**
 * Settings → Skills: Yours and Built-in, each turned on or off, with a ⋯ menu
 * (Edit, Export as zip, Remove). New Skill… writes one, in place; Import… reads
 * one from a folder or a zip, shown first for the User to check. Built-in
 * Skills can be duplicated as the User's own and, once removed, restored.
 */
export function SkillsSettings() {
  const t = useT();
  const skills = useAppStore((state) => state.skills);
  const restoreBuiltInSkills = useAppStore((state) => state.restoreBuiltInSkills);
  const removedBuiltIns = useRemovedBuiltIns();
  const importMenu = usePopoverMenu();
  const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [error, setError] = useState<SkillImportError | string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  // The editor the User chose last stays open: a Skill's draft read before that choice doesn't
  // replace it (#2302).
  const [editorChoice] = useState(() => newestReads());
  const openEditor = (next: Editing | null) => {
    editorChoice();
    setEditing(next);
  };
  const [exported, setExported] = useState<Exported | null>(null);
  // A preview left open when Settings closes is forgotten.
  const pending = useRef<string | null>(null);
  pending.current = preview?.importId ?? null;
  useEffect(
    () => () => {
      if (pending.current) core.cancelSkillImport(pending.current).catch(() => undefined);
    },
    [],
  );

  const choose = async (kind: SkillPickKind) => {
    setError(null);
    let path: string | null;
    try {
      path = await pickSkill(kind);
    } catch (failure) {
      setError(errorMessage(failure, t));
      return;
    }
    if (!path) return;
    if (preview) core.cancelSkillImport(preview.importId).catch(() => undefined);
    setPreview(null);
    setBusy("reading");
    try {
      const check = await core.previewSkillImport(path);
      if (check.ok) setPreview(check.preview);
      else setError(check.error);
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (importId: string) => {
    setBusy("importing");
    try {
      await core.importSkill(importId);
      setPreview(null);
    } catch (failure) {
      setPreview(null);
      setError(errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const cancel = (importId: string) => {
    core.cancelSkillImport(importId).catch(() => undefined);
    setPreview(null);
  };

  const edit = async (skill: Skill) => {
    const newest = editorChoice();
    setError(null);
    try {
      const draft = await core.getSkillDraft(skill.id);
      if (newest()) setEditing({ kind: "edit", skill, draft });
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  const exportZip = async (skill: Skill) => {
    setExported(null);
    try {
      const result = await core.saveSkillExport(skill.id);
      if (result.status === "saved") {
        const { name, path, folder, inDefaultFolder } = result.file;
        setExported({ kind: "saved", name, path, folder, inDefaultFolder });
      } else if (result.status === "not-allowed") {
        setExported({
          kind: "not-allowed",
          skill,
          linkedFolderId: result.linkedFolderId,
          folder: result.linkedFolderPath.split(/[\\/]/).at(-1) ?? result.linkedFolderPath,
        });
      }
      // "cancelled": the User didn't choose where new files go, so nothing was saved.
    } catch (failure) {
      setExported({ kind: "failed", message: errorMessage(failure, t) });
    }
  };

  const yours = skills.filter((skill) => !skill.builtIn);
  const builtIn = skills.filter((skill) => skill.builtIn);
  const row = (skill: Skill) =>
    editing?.kind === "edit" && editing.skill.id === skill.id ? (
      <li key={skill.id} className="py-3.5">
        <SkillEditor
          testId="skill-editor"
          initial={editing.draft}
          title={t("skills.edit.edit", { name: skillTitle(skill.name, t) })}
          save={(draft) => core.updateSkill(skill.id, draft)}
          onSaved={() => openEditor(null)}
          onCancel={() => openEditor(null)}
        />
      </li>
    ) : (
      <SkillRow
        key={skill.id}
        skill={skill}
        onEdit={(each) => void edit(each)}
        onExport={exportZip}
      />
    );

  return (
    <section data-testid="skills-settings" className="flex flex-col gap-4">
      <p className={pageIntroClass}>{t("skills.settings.body")}</p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="skill-new"
          disabled={editing?.kind === "new"}
          onClick={() => openEditor({ kind: "new" })}
          className={buttonClass}
        >
          <PlusLineIcon className="size-4" />
          {t("skills.settings.new")}
        </button>
        <button
          {...importMenu.buttonProps}
          type="button"
          data-testid="skill-import"
          disabled={busy !== null || preview !== null}
          className={buttonClass}
        >
          <ExportLineIcon className="size-4" />
          {t("skills.settings.import")}
        </button>
        <div
          {...importMenu.menuProps}
          role="menu"
          aria-label={t("skills.settings.import")}
          data-testid="skill-import-menu"
          className={menuClass}
        >
          {importMenu.open && (
            <>
              <button
                type="button"
                role="menuitem"
                data-testid="skill-import-folder"
                onClick={() => {
                  importMenu.close();
                  void choose("folder");
                }}
                className={`${menuItemClass} pl-2`}
              >
                {t("skills.import.folder")}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="skill-import-zip"
                onClick={() => {
                  importMenu.close();
                  void choose("zip");
                }}
                className={`${menuItemClass} pl-2`}
              >
                {t("skills.import.zip")}
              </button>
            </>
          )}
        </div>
      </div>
      {busy === "reading" && (
        <p className="text-[13px] leading-5 text-ink-meta">{t("skills.import.reading")}</p>
      )}
      {error && <ImportError error={error} />}
      {exported && <ExportStatus exported={exported} onExport={exportZip} />}
      {preview && (
        <SkillPreview
          preview={preview}
          importing={busy === "importing"}
          onImport={() => void confirm(preview.importId)}
          onCancel={() => cancel(preview.importId)}
        />
      )}
      {editing?.kind === "new" && (
        <SkillEditor
          testId="skill-editor"
          initial={NEW_SKILL}
          title={t("skills.edit.new")}
          save={(draft) => core.createSkill(draft)}
          onSaved={() => openEditor(null)}
          onCancel={() => openEditor(null)}
        />
      )}

      <section data-testid="skills-yours" className="flex flex-col">
        <h4 className={`mb-2 ${sectionTitleClass}`}>{t("skills.settings.yours")}</h4>
        {yours.length === 0 ? (
          <p className={`${rowStatusClass} border-y border-rule py-3.5`}>
            {t("skills.settings.yours.empty")}
          </p>
        ) : (
          <ul className={ruledListClass}>{yours.map(row)}</ul>
        )}
      </section>

      <section data-testid="skills-built-in" className="flex flex-col">
        <h4 className={sectionTitleClass}>{t("skills.settings.builtIn")}</h4>
        <p className={sectionNoteClass}>{t("skills.settings.builtIn.hint")}</p>
        {builtIn.length > 0 && <ul className={ruledListClass}>{builtIn.map(row)}</ul>}
        {removedBuiltIns.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              data-testid="skill-restore-built-ins"
              title={t("skills.settings.restoreBuiltIns.hint", {
                names: removedBuiltIns.map((name) => skillTitle(name, t)).join(", "),
              })}
              disabled={busy !== null}
              onClick={() => void restoreBuiltInSkills()}
              className={buttonClass}
            >
              {t("skills.settings.restoreBuiltIns")}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

/** Where the zip went, with a way to see it there; or why it didn't, with the one thing that helps. */
function ExportStatus({
  exported,
  onExport,
}: {
  exported: Exported;
  onExport(skill: Skill): void;
}) {
  const t = useT();
  if (exported.kind === "saved") {
    return (
      <ProblemLine
        role="status"
        testId="skill-export-done"
        title={exported.path}
        action={{
          label: t(showFileLabelKey(navigator.platform)),
          testId: "skill-export-show",
          onClick: () =>
            void files.showSavedFile(exported.path).catch(useAppStore.getState().reportError),
        }}
      >
        {t("skills.settings.exported", {
          name: exported.name,
          folder: savedFolderLabel(exported, t),
        })}
      </ProblemLine>
    );
  }
  if (exported.kind === "not-allowed") {
    const { linkedFolderId, skill } = exported;
    return (
      <ProblemLine
        testId="skill-export-problem"
        action={{
          label: t("skills.settings.exportAllow"),
          onClick: () =>
            void core.setLinkedFolderWriting(linkedFolderId, true).then(() => onExport(skill)),
        }}
      >
        {t("skills.settings.exportFailed", {
          reason: t("skills.settings.exportNotAllowed", { folder: exported.folder }),
        })}
      </ProblemLine>
    );
  }
  return (
    <ProblemLine testId="skill-export-problem">
      {t("skills.settings.exportFailed", { reason: exported.message })}
    </ProblemLine>
  );
}

/**
 * Settings → Skills → Skill scripts: the switch that lets Skills run their scripts at
 * all (each run still asks, unless the Skill's scripts always run), with
 * what a script can reach here (`Settings.scriptSandbox`), and how long a
 * script may run before it is stopped. Both belong to this device.
 */
export function SkillScriptsSettings() {
  const t = useT();
  const enabled = useAppStore((state) => state.settings?.device.skillScriptsEnabled);
  const sandboxed = useAppStore((state) => state.settings?.scriptSandbox === "os");
  const timeout = useAppStore((state) => state.settings?.device.skillScriptTimeoutSeconds);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const timeoutId = useId();
  const enabledId = useId();
  if (enabled === undefined || timeout === undefined) return null;

  const { minTimeoutSeconds: min, maxTimeoutSeconds: max } = SKILL_SCRIPT_LIMITS;
  const commit = () => {
    if (draft === null) return;
    const seconds = Number(draft);
    setDraft(null);
    if (Number.isInteger(seconds) && seconds >= min && seconds <= max && seconds !== timeout) {
      void updateSettings({ device: { skillScriptTimeoutSeconds: seconds } });
    }
  };

  return (
    <section data-testid="skill-scripts-settings" className="flex flex-col">
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t("scripts.settings.title")}</h4>
      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={enabledId} className={rowTitleClass}>
              {t("scripts.settings.enabled")}
            </label>
            <div
              id={`${enabledId}-description`}
              data-testid="skill-scripts-sandbox"
              data-sandbox={sandboxed ? "os" : "none"}
              className={rowTextClass}
            >
              {sandboxed ? (
                <DetailsLine
                  testId="skill-scripts-reach"
                  details={t("scripts.settings.bodySandboxed.details")}
                >
                  {t("scripts.settings.bodySandboxed")}
                </DetailsLine>
              ) : (
                <p>{t("scripts.settings.body")}</p>
              )}
            </div>
          </div>
          <input
            id={enabledId}
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            aria-describedby={`${enabledId}-description`}
            data-testid="skill-scripts-enabled"
            checked={enabled}
            onChange={(event) =>
              void updateSettings({ device: { skillScriptsEnabled: event.target.checked } })
            }
            className="switch"
          />
        </div>
        <div className={ruledRow("center")}>
          <label
            htmlFor={timeoutId}
            className={enabled ? "text-ui text-ink" : "text-ui text-ink-placeholder"}
          >
            {t("scripts.settings.timeout")}
          </label>
          <span className="flex items-center gap-2 text-[13px] leading-5 text-ink-meta">
            <input
              id={timeoutId}
              type="number"
              data-testid="skill-scripts-timeout"
              min={min}
              max={max}
              step={1}
              disabled={!enabled}
              value={draft ?? String(timeout)}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
              }}
              className="h-8 w-20 rounded-sm border border-rule-strong bg-sheet px-2 text-ui text-ink focus:border-accent focus:outline-1 focus:outline-offset-0 focus:outline-accent disabled:opacity-60"
            />
            {t("scripts.settings.seconds")}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * The names of the built-in Skills the User removed, asked again whenever the
 * Skills change (a removal, a restore). Empty until the core answers.
 */
function useRemovedBuiltIns(): string[] {
  const [removed, setRemoved] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      core
        .listRemovedBuiltInSkills()
        .then((names) => {
          if (current) setRemoved(names);
        })
        .catch(() => undefined);
    };
    refresh();
    const stop = core.on("skills.changed", refresh);
    return () => {
      current = false;
      stop();
    };
  }, []);
  return removed;
}

/**
 * One Skill: what it's for, its licence and scripts, a ⋯ menu (Edit, Export
 * as zip, Duplicate a built-in one as your own, Remove) and the switch that
 * turns it on or off.
 */
function SkillRow({
  skill,
  onEdit,
  onExport,
}: {
  skill: Skill;
  onEdit(skill: Skill): void;
  onExport(skill: Skill): void;
}) {
  const t = useT();
  const menu = usePopoverMenu();
  const setSkillEnabled = useAppStore((state) => state.setSkillEnabled);
  const removeSkill = useAppStore((state) => state.removeSkill);
  const duplicateSkill = useAppStore((state) => state.duplicateSkill);
  const scripts = skill.files.filter((file) => file.script).length;
  const details = [
    skill.license && t("skills.settings.license", { license: skill.license }),
    scripts === 1
      ? t("skills.settings.scripts.one")
      : scripts > 1
        ? t("skills.settings.scripts", { count: scripts })
        : null,
  ].filter(Boolean);
  const short = skillShortLine(skill, t);
  const label = t("skills.settings.actions", { name: skillTitle(skill.name, t) });
  const choose = (action: () => void) => () => {
    menu.close();
    action();
  };
  const item = (testId: string, text: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={choose(action)}
      className={`${menuItemClass} pl-2`}
    >
      {text}
    </button>
  );

  return (
    <li
      data-testid="skill-item"
      data-skill-name={skill.name}
      data-enabled={skill.enabled}
      data-built-in={skill.builtIn}
      className={ruledRowClass}
    >
      <div className={`flex min-w-0 flex-col gap-0.5 ${skill.enabled ? "" : "opacity-60"}`}>
        <p className={`truncate ${rowTitleClass}`}>{skillTitle(skill.name, t)}</p>
        {short ? (
          <DetailsLine
            testId={`skill-description-${skill.name}`}
            className={rowTextClass}
            details={<p>{skillDescription(skill, t)}</p>}
          >
            {short}
          </DetailsLine>
        ) : (
          <p className={`line-clamp-1 ${rowTextClass}`} title={skillDescription(skill, t)}>
            {skillDescription(skill, t)}
          </p>
        )}
        {details.length > 0 && (
          <MetaLine parts={details} className="text-[12px] leading-[18px] text-ink-meta" />
        )}
      </div>
      {/* 28px buttons and the switch, centred on the name's 20px line. */}
      <div className="-my-1 flex items-center gap-1">
        <button
          {...menu.buttonProps}
          type="button"
          data-testid="skill-menu"
          aria-label={label}
          title={label}
          className={iconButtonClass}
        >
          <MoreLineIcon className="size-4" />
        </button>
        <div
          {...menu.menuProps}
          role="menu"
          aria-label={label}
          data-testid="skill-actions"
          className={menuClass}
        >
          {menu.open && (
            <>
              {!skill.builtIn && item("skill-edit", t("skills.settings.edit"), () => onEdit(skill))}
              {item("skill-export", t("skills.settings.export"), () => onExport(skill))}
              {skill.builtIn &&
                item("skill-duplicate", t("skills.settings.duplicate"), () => {
                  void duplicateSkill(skill.id);
                })}
              <div className={menuRuleClass} />
              {item("skill-remove", t("skills.settings.remove"), () => {
                void removeSkill(skill.id);
              })}
            </>
          )}
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-checked={skill.enabled}
          data-testid="skill-enabled"
          aria-label={t("skills.settings.enabled", { name: skillTitle(skill.name, t) })}
          checked={skill.enabled}
          onChange={(event) => void setSkillEnabled(skill.id, event.target.checked)}
          className="switch ml-2"
        />
      </div>
    </li>
  );
}

/** What importing would add: the Skill's frontmatter and its files, to import or cancel. */
function SkillPreview({
  preview,
  importing,
  onImport,
  onCancel,
}: {
  preview: SkillImportPreview;
  importing: boolean;
  onImport(): void;
  onCancel(): void;
}) {
  const t = useT();
  const size = formatSize(preview.totalBytes, t);
  return (
    <div
      data-testid="skill-preview"
      className="flex flex-col gap-3 rounded-lg border border-rule p-4 text-ui text-ink"
    >
      <p className="text-label font-semibold text-ink-meta">{t("skills.preview.title")}</p>
      <div className="flex flex-col gap-0.5">
        <p data-testid="skill-preview-name" className={rowTitleClass}>
          {skillTitle(preview.name, t)}
        </p>
        <p data-testid="skill-preview-description" className={rowTextClass}>
          {preview.description}
        </p>
        {preview.license && (
          <p className="text-[12px] leading-[18px] text-ink-meta">
            {t("skills.preview.license", { license: preview.license })}
          </p>
        )}
        {preview.compatibility && (
          <p className="text-[12px] leading-[18px] text-ink-meta">
            {t("skills.preview.compatibility", { compatibility: preview.compatibility })}
          </p>
        )}
      </div>
      {preview.replaces && (
        <p data-testid="skill-preview-replaces" className={noticeClass}>
          {t("skills.preview.replaces", { name: skillTitle(preview.replaces.name, t) })}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-[13px] leading-5 text-ink-secondary select-none hover:text-ink">
          {preview.files.length === 1
            ? t("skills.preview.files.one", { size })
            : t("skills.preview.files", { count: preview.files.length, size })}
        </summary>
        <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-[12px] leading-5 text-ink-secondary">
          {preview.files.map((file) => (
            <li key={file.path} data-testid="skill-preview-file" className="flex gap-2">
              <span className="truncate">{file.path}</span>
              <span className="shrink-0 text-ink-meta">{formatSize(file.size, t)}</span>
              {file.script && (
                <span className="shrink-0 font-sans font-semibold text-ink">
                  {t("skills.preview.script")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </details>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="skill-import-confirm"
          disabled={importing}
          onClick={onImport}
          className={primaryButtonClass}
        >
          {importing ? t("skills.preview.importing") : t("skills.preview.import")}
        </button>
        <button type="button" disabled={importing} onClick={onCancel} className={ghostButtonClass}>
          {t("skills.preview.cancel")}
        </button>
      </div>
    </div>
  );
}

/** Why a Skill can't be imported, in words, with the technical detail underneath. */
function ImportError({ error }: { error: SkillImportError | string }) {
  const t = useT();
  if (typeof error === "string") {
    return (
      <p role="alert" data-testid="skill-import-error" className={errorTextClass}>
        <ProblemMark />
        {t("error.action", { message: error })}
      </p>
    );
  }
  const path = error.path ?? "";
  const message =
    error.kind === "too-large"
      ? t("skills.error.too-large", {
          size: formatSize(SKILL_LIMITS.maxBytes, t),
          instructions: formatSize(SKILL_LIMITS.maxInstructionsBytes, t),
        })
      : error.kind === "too-many-files"
        ? t("skills.error.too-many-files", { count: SKILL_LIMITS.maxFiles })
        : t(`skills.error.${error.kind}`, { path });
  return (
    <div
      role="alert"
      data-testid="skill-import-error"
      data-kind={error.kind}
      className="flex flex-col gap-1 text-[13px] leading-5 text-ink"
    >
      <p>
        <ProblemMark />
        {message}
      </p>
      <details className="text-[12px] text-ink-meta">
        <summary className="cursor-pointer">{t("skills.error.details")}</summary>
        <p className="mt-1 break-words">{error.message}</p>
      </details>
    </div>
  );
}
