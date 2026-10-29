/** The recording's captions against the scenes they belong to: a caption may not run into
 * another scene, and every filmed scene's own caption must sit at that scene's mark. */
export interface CaptionTime {
  at: number;
  text: string | null;
}

/** A caption is set on the frame after its scene's mark: a few milliseconds, never a scene. */
const FRAME = 0.05;

export interface FilmedScene {
  name: string;
  film: boolean;
}

export interface ExpectedCaption {
  scene: string;
  at: number;
  text: string;
}

export function assertCaptionsAtScenes(
  captions: readonly CaptionTime[],
  marks: Readonly<Record<string, number>>,
  scenes: readonly FilmedScene[],
  expected: readonly ExpectedCaption[],
  total: number,
): void {
  const filmed = scenes
    .filter((scene) => scene.film)
    .flatMap((scene) => {
      const at = marks[scene.name];
      return at === undefined ? [] : [{ name: scene.name, at }];
    })
    .sort((one, other) => one.at - other.at);
  if (filmed.length === 0) return;
  for (const [index, caption] of captions.entries()) {
    const end = captions[index + 1]?.at ?? total;
    const at = filmed.findLastIndex((scene) => scene.at <= caption.at + FRAME);
    const scene = filmed[at];
    if (!scene) {
      throw new Error(`A caption at ${caption.at.toFixed(2)} s is before the first filmed scene.`);
    }
    const next = filmed[at + 1]?.at ?? total;
    if (end > next + FRAME) {
      throw new Error(
        `The caption "${caption.text ?? "none"}" runs to ${end.toFixed(2)} s, past ${scene.name}'s end at ${next.toFixed(2)} s.`,
      );
    }
  }
  for (const want of expected) {
    const found = captions.some(
      (caption) => Math.abs(caption.at - want.at) <= FRAME && caption.text === want.text,
    );
    if (!found) {
      throw new Error(
        `"${want.scene}" has no caption "${want.text}" at its mark (${want.at.toFixed(2)} s).`,
      );
    }
  }
}
