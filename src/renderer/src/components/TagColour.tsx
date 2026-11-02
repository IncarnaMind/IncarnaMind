import { useId } from "react";
import { isTagColour, TAG_COLOURS, type TagColour } from "../../../shared/tagColours";
import { useT } from "../i18n";
import { CheckLineIcon } from "./lineIcons";

/** A chip's fill and text in a Tag's colour. Literal classes, so Tailwind finds them. */
const CHIP: Record<TagColour, string> = {
  red: "bg-tag-red text-tag-red-ink",
  orange: "bg-tag-orange text-tag-orange-ink",
  yellow: "bg-tag-yellow text-tag-yellow-ink",
  green: "bg-tag-green text-tag-green-ink",
  teal: "bg-tag-teal text-tag-teal-ink",
  blue: "bg-tag-blue text-tag-blue-ink",
  purple: "bg-tag-purple text-tag-purple-ink",
  gray: "bg-tag-gray text-tag-gray-ink",
};

/** A dot's colour, as Finder's, and its edge (a hairline darker for a light hue). */
const DOT: Record<TagColour, string> = {
  red: "bg-tag-red-dot border-tag-red-edge",
  orange: "bg-tag-orange-dot border-tag-orange-edge",
  yellow: "bg-tag-yellow-dot border-tag-yellow-edge",
  green: "bg-tag-green-dot border-tag-green-edge",
  teal: "bg-tag-teal-dot border-tag-teal-edge",
  blue: "bg-tag-blue-dot border-tag-blue-edge",
  purple: "bg-tag-purple-dot border-tag-purple-edge",
  gray: "bg-tag-gray-dot border-tag-gray-edge",
};

const known = (colour: string | undefined): TagColour => (isTagColour(colour) ? colour : "gray");

/** The classes that colour a Tag's chip. */
export const tagChipColour = (colour: string | undefined) => CHIP[known(colour)];

/**
 * A Tag as a solid round dot in its colour, as Finder shows one where there
 * is no room for its name: 10px on a row, in a menu or the picker; 11px in
 * the sidebar's Tags view. "Needs review" is a hollow ring (`ReviewRing`), so
 * it never reads as a Tag.
 */
export function TagDot({
  colour,
  size = "sm",
  className = "",
}: {
  colour: string | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="tag-dot"
      data-colour={known(colour)}
      className={`inline-block shrink-0 rounded-full border ${DOT[known(colour)]} ${
        size === "md" ? "size-[11px]" : "size-2.5"
      } ${className}`}
    />
  );
}

/**
 * A Tag awaiting the User's review, where Tags are dots (the sidebar, filter
 * menus, picker options): a hollow ring in `review`, a darker amber than the
 * orange dot, 9px with a 1.5px stroke, in a dot's 10px place. Inside a named
 * chip it is the 6px `attention` dot (`ReviewDot`).
 */
export function ReviewRing() {
  return (
    <span
      aria-hidden="true"
      data-testid="review-ring"
      className="flex size-2.5 shrink-0 items-center justify-center"
    >
      <span className="size-[9px] rounded-full border-[1.5px] border-review" />
    </span>
  );
}

/**
 * The eight colours as a row of dots, each one choice, chosen where it is: a
 * Tag's menu and the menu its dot opens. The chosen one is ringed as Finder
 * rings it. A menu item each, so the menu's arrow keys reach them.
 */
export function TagColourChoices({
  value,
  onPick,
}: {
  value: string | undefined;
  onPick(colour: TagColour): void;
}) {
  const t = useT();
  const chosen = known(value);
  return (
    <span className="flex shrink-0 items-center">
      {TAG_COLOURS.map((colour) => (
        <button
          key={colour}
          type="button"
          role="menuitemradio"
          aria-checked={chosen === colour}
          aria-label={t(`tags.colour.${colour}`)}
          title={t(`tags.colour.${colour}`)}
          data-testid="tag-colour-choice"
          data-colour={colour}
          onClick={() => onPick(colour)}
          className="flex size-[17px] shrink-0 items-center justify-center rounded-full focus-visible:outline-offset-0"
        >
          <span
            className={`flex size-[11px] items-center justify-center rounded-full ${
              chosen === colour
                ? "shadow-[0_0_0_2px_var(--color-sheet),0_0_0_3.5px_var(--color-ink)]"
                : ""
            }`}
          >
            <TagDot colour={colour} size="md" />
          </span>
        </button>
      ))}
    </span>
  );
}

/** Choosing a Tag's colour: a row of its dots, one choice, arrow keys between them. */
export function TagColourPicker({
  value,
  onChange,
}: {
  value: TagColour;
  onChange(colour: TagColour): void;
}) {
  const t = useT();
  const name = useId();
  return (
    <fieldset data-testid="tag-colour-picker" className="flex flex-col gap-1">
      <legend className="mb-1 text-[13px] leading-5 text-ink-secondary">
        {t("tags.colour.label")}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {TAG_COLOURS.map((colour) => (
          <label
            key={colour}
            title={t(`tags.colour.${colour}`)}
            className="relative cursor-pointer"
          >
            <input
              type="radio"
              name={name}
              value={colour}
              checked={value === colour}
              aria-label={t(`tags.colour.${colour}`)}
              data-testid="tag-colour"
              data-colour={colour}
              onChange={() => onChange(colour)}
              className="peer sr-only"
            />
            <span
              className={`flex size-6 items-center justify-center rounded-full border text-ink ${DOT[colour]} peer-checked:shadow-[0_0_0_2px_var(--color-sheet),0_0_0_3px_var(--color-ink-meta)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent`}
            >
              {value === colour && <CheckLineIcon className="size-3.5" />}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
