/**
 * PulseAudio's recording streams, as `pactl` lists them (#208): on Linux, a call app recording is
 * a source output that isn't corked. PipeWire answers `pactl` the same way through pipewire-pulse.
 */

export interface RecordingStream {
  binary: string | null;
  name: string | null;
  pid: number | null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const pidOf = (value: unknown): number | null => {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/** `pactl -f json list source-outputs` (pactl 16 and later): the streams that record now. */
export function streamsOfJson(output: string): RecordingStream[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("pactl's list isn't an array.");
  const streams: RecordingStream[] = [];
  for (const each of parsed) {
    if (typeof each !== "object" || each === null) continue;
    const stream = each as { corked?: unknown; properties?: unknown };
    if (stream.corked === true) continue;
    const properties = (
      typeof stream.properties === "object" && stream.properties !== null ? stream.properties : {}
    ) as Record<string, unknown>;
    streams.push({
      binary: text(properties["application.process.binary"]),
      name: text(properties["application.name"]),
      pid: pidOf(properties["application.process.id"]),
    });
  }
  return streams;
}

/** `pactl list source-outputs` in its text form, as older pactl prints it in any language's C locale. */
export function streamsOfText(output: string): RecordingStream[] {
  const streams: RecordingStream[] = [];
  for (const block of output.split(/^Source Output #/m).slice(1)) {
    if (/^\s*Corked:\s*yes\s*$/m.test(block)) continue;
    const property = (key: string) => {
      const found = block.match(
        new RegExp(`^\\s*${key.replaceAll(".", "\\.")} = "(.*)"\\s*$`, "m"),
      );
      return found ? found[1] : undefined;
    };
    streams.push({
      binary: text(property("application.process.binary")),
      name: text(property("application.name")),
      pid: pidOf(property("application.process.id")),
    });
  }
  return streams;
}

/** Whether a line of `pactl subscribe` is about a recording stream starting, changing or ending. */
export const isRecordingEvent = (line: string): boolean => /\bon source-output #\d+/.test(line);
