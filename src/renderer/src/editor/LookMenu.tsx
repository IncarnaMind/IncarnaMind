import type { CommandId } from "../../../shared/commands";
import type { MindLook } from "../../../shared/wordLook";
import { type CommandContext, commands } from "../commands/registry";
import { CheckLineIcon } from "../components/lineIcons";
import { menuItemClass, menuTitleClass } from "../components/ui";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { useWordLooks } from "../wordLooks";
import { missingFonts, useFontLoads } from "./wordFonts";

const LOOK_COMMANDS: Record<MindLook, CommandId> = {
  word: "mind.look.word",
  plain: "mind.look.plain",
};

/**
 * Look, in a Word Note's ⋯ menu beside Style (the board Word-Look-Menu): the Word file's look
 * or a plain note, and which of the file's fonts this computer lacks, drawn with the nearest.
 * "From {file}" in the same menu opens the original.
 */
export function LookMenuItems({ mindId, close }: { mindId: string; close(): void }) {
  const t = useT();
  const shown = useWordLooks((state) => state[mindId]);
  useFontLoads();
  if (!shown) return null;
  const ctx: CommandContext = {
    selection: [],
    focus: { kind: "mind", id: mindId },
    surface: "mind",
  };
  const run = (id: CommandId) => {
    close();
    commands.run(id, ctx).catch(useAppStore.getState().reportError);
  };
  const missing = missingFonts(shown.fonts);
  const option = (look: MindLook, label: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={shown.shown === look}
      data-testid={`look-${look}`}
      onClick={() => (shown.shown === look ? close() : run(LOOK_COMMANDS[look]))}
      className={`${menuItemClass} pl-2`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {shown.shown === look && <CheckLineIcon className="size-4" />}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
  return (
    <>
      <div className={menuTitleClass}>{t("look.title")}</div>
      {option("word", t("look.word"))}
      {option("plain", t("look.plain"))}
      {missing.length > 0 && (
        <p
          data-testid="look-fonts"
          title={missing.join(", ")}
          className="px-2 py-0.5 text-[12px] leading-5 text-ink-meta"
        >
          {missing.length === 1
            ? t("look.fonts.missing.one")
            : t("look.fonts.missing", { count: missing.length })}
        </p>
      )}
    </>
  );
}
