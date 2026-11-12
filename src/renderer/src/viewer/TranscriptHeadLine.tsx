import { useGap, useT } from "../i18n";

/**
 * What a Meeting's Transcript is, said at its head from its first line on (#1031): the app's own
 * line, never the Transcript's text. How to hear a word is said only while a click plays one.
 */
export function TranscriptHeadLine({ playable }: { playable: boolean }) {
  const t = useT();
  const gap = useGap();
  const what = t("transcript.head");
  const how = t("transcript.head.play");
  return (
    <p data-testid="transcript-head" className="transcript-head">
      {what}
      {playable && (
        <span data-testid="transcript-head-play">
          {gap(what, how)}
          {how}
        </span>
      )}
    </p>
  );
}
