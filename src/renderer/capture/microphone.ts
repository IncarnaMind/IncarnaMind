/**
 * Whether the capture page's microphone is open, from what the User wants (on, or paused for a
 * Meeting) and what happens to the device (opening, a default input that changes). One queue runs
 * every change in order and each one looks at what is wanted when its turn comes, so a pause
 * that arrives while the page is still starting is never overtaken by an open that was already
 * queued: the microphone, and the system's indicator for it, are on only while it is wanted.
 */
import type { CaptureStart } from "../../shared/capture";

export interface MicrophoneDevice {
  isOpen(): boolean;
  /** Opens it, or leaves it closed when `stillWanted()` turns false while it is being granted. */
  open(stillWanted: () => boolean): Promise<void>;
  close(): Promise<void>;
}

type InputInfo = Pick<MediaDeviceInfo, "kind" | "deviceId" | "groupId" | "label">;
type InputTrack = Pick<MediaStreamTrack, "getSettings" | "label" | "readyState" | "muted">;

function concreteId(id: string): boolean {
  return id !== "default" && id !== "communications";
}

export function isRecordingDefaultMicrophone(
  track: InputTrack,
  devices: readonly InputInfo[],
): boolean {
  if (track.readyState !== "live" || track.muted) return false;
  const input = devices.find((device) => device.kind === "audioinput");
  const { deviceId, groupId } = track.getSettings();
  if (!input?.deviceId || !deviceId) return false;
  if (concreteId(deviceId) && concreteId(input.deviceId)) return deviceId === input.deviceId;

  // Chromium's default alias can keep its ID when it moves to another microphone.
  if (!groupId || groupId !== input.groupId) return false;
  const physical = devices.filter(
    (device) =>
      device.kind === "audioinput" &&
      device.groupId === groupId &&
      device.deviceId &&
      concreteId(device.deviceId),
  );
  if (physical.length !== 1) return false;
  if (concreteId(deviceId)) return physical[0]?.deviceId === deviceId;
  if (concreteId(input.deviceId)) return physical[0]?.deviceId === input.deviceId;
  return deviceId === input.deviceId && !!track.label && track.label === input.label;
}

export function startMicrophone(
  microphone: { start(on: boolean): Promise<void> },
  request: CaptureStart,
): Promise<void> {
  return request.microphone ? microphone.start(request.microphoneOn) : Promise.resolve();
}

export function createMicrophone(device: MicrophoneDevice) {
  let wanted = true;
  let running = false;
  let turn: Promise<void> = Promise.resolve();

  const stillWanted = () => running && wanted;

  async function settle(): Promise<void> {
    if (stillWanted() && !device.isOpen()) await device.open(stillWanted);
    if (running && !wanted && device.isOpen()) await device.close();
  }

  function queue(change: () => Promise<void>): Promise<void> {
    turn = turn.then(change).catch((error: unknown) => {
      console.error(error);
    });
    return turn;
  }

  return {
    start(on: boolean): Promise<void> {
      wanted = on;
      running = true;
      return queue(settle);
    },

    set(on: boolean): Promise<void> {
      wanted = on;
      return queue(settle);
    },

    /** The default input changed, or the device went: closed and opened again, if it is open and wanted. */
    reopen(isCurrent: () => boolean): Promise<void> {
      return queue(async () => {
        if (!running || !device.isOpen() || !isCurrent()) return;
        await device.close();
        await settle();
      });
    },

    /** The capture is over: whatever was queued has run, and nothing opens after it. */
    stop(): Promise<void> {
      running = false;
      return turn;
    },
  };
}
