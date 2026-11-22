import { useEffect, useState } from "react";
import type { CitationLocation, SharedScreenFrame } from "../../../core/api";
import type { CitationState } from "../../../shared/citations";
import { formatTime } from "../../../shared/dates";
import { formatLocation } from "../../../shared/locations";
import type { CommandContext } from "../commands/registry";
import { ScreenLineIcon } from "../components/lineIcons";
import { ObjectMenu } from "../components/ObjectMenu";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import type { ObjectRef } from "../objects";
import { useAppStore } from "../store";
import { CheckStateIcon } from "./icons";

type ScreenLocation = Extract<CitationLocation, { kind: "screen" }>;

/**
 * The card of a Citation of a Meeting's shared screen (ADR-0031): while the
 * Meeting records, the window it was read from, the screen as it was read,
 * its quote's lines outlined, the check and the quote, all from memory; once
 * the Meeting has stopped, only that it was deleted after the meeting, with
 * nothing to open. Its quote and picture are never stored with it.
 */
export function ScreenCitationCard({
  location,
  state,
  badgeText,
  menu,
}: {
  location: ScreenLocation;
  state: CitationState;
  badgeText: string;
  menu?: { target: ObjectRef; here: CommandContext["here"] };
}) {
  const t = useT();
  const language = useLanguage();
  const gone = state.reason === "screen-deleted";
  /** Undefined while asked for; null once it isn't kept any more. */
  const [frame, setFrame] = useState<SharedScreenFrame | null | undefined>(undefined);
  const { screen, from, to } = location;

  useEffect(() => {
    if (gone) {
      setFrame(null);
      return;
    }
    let shown = true;
    core.getSharedScreen({ screen, from, to }).then(
      (found) => {
        if (shown) setFrame(found);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      shown = false;
    };
  }, [gone, screen, from, to]);

  const where = formatLocation(location, t, { language });
  const kept = !gone && frame ? frame : null;
  return (
    <div
      data-testid="screen-citation-card"
      data-gone={gone || undefined}
      className={`citation-card citation-card--${state.check}`}
      contentEditable={false}
    >
      <p data-testid="screen-citation-where" className="citation-screen-where">
        <ScreenLineIcon className="citation-screen-icon" />
        {kept?.window ? (
          <>
            <span className="font-semibold text-ink">
              {t("citation.screen.window", { window: kept.window })}
            </span>
            <span className="truncate"> · {where}</span>
          </>
        ) : (
          <span className="font-semibold text-ink">{where}</span>
        )}
      </p>
      {kept?.image && (
        <figure className="citation-screen-picture">
          <img
            data-testid="screen-citation-picture"
            src={kept.image}
            alt={t("citation.screen.picture", { time: formatTime(location.at, language) })}
          />
          {kept.boxes.map(([left, top, right, bottom]) => (
            <span
              key={`${left} ${top}`}
              aria-hidden="true"
              className="citation-screen-box"
              style={{
                left: `${left * 100}%`,
                top: `${top * 100}%`,
                width: `${(right - left) * 100}%`,
                height: `${(bottom - top) * 100}%`,
              }}
            />
          ))}
        </figure>
      )}
      <p data-testid="citation-badge" data-check={state.check} className="citation-badge">
        <CheckStateIcon check={state.check} gone={gone} className="citation-badge-icon" />
        <span>{badgeText}</span>
      </p>
      {kept?.quote && state.check !== "not-found" && (
        <figure className="citation-card-quote">
          <figcaption className="sr-only">{t("citation.quote")}</figcaption>
          <blockquote>
            <span data-testid="screen-citation-quote" className="citation-card-wash">
              {kept.quote}
            </span>
          </blockquote>
        </figure>
      )}
      <p data-testid="citation-reason" className="citation-card-note">
        {gone
          ? t("citation.reason.screen-deleted")
          : state.reason === "picture"
            ? t("citation.screen.fromPicture", { time: formatTime(location.at, language) })
            : t("citation.screen.kept")}
      </p>
      {menu && (
        <div className="citation-card-actions">
          <ObjectMenu
            target={menu.target}
            label={t("citation.more")}
            here={menu.here}
            className="citation-card-action ml-auto"
          />
        </div>
      )}
    </div>
  );
}
