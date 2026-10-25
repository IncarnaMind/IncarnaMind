import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";

export interface WavHeader {
  channels: number;
  rate: number;
  bits: 16 | 32;
  float: boolean;
  dataOffset: number;
  dataBytes: number;
}

/** Reads a RIFF/WAVE header from the start of `bytes`; the data chunk need not be there yet. */
export function wavHeader(bytes: Uint8Array, name = "audio"): WavHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error(`${name} isn't a WAV file.`);
  }
  let format: { code: number; channels: number; rate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      const extensible = view.getUint16(at + 8, true) === 0xfffe && size >= 40;
      format = {
        code: view.getUint16(at + (extensible ? 32 : 8), true),
        channels: view.getUint16(at + 10, true),
        rate: view.getUint32(at + 12, true),
        bits: view.getUint16(at + 22, true),
      };
    } else if (id === "data") {
      const float = format?.code === 3 && format.bits === 32;
      const pcm = format?.code === 1 && format.bits === 16;
      if (!format || !(float || pcm)) {
        throw new Error(
          `${name} isn't 16-bit PCM or 32-bit float audio: ${JSON.stringify(format)}`,
        );
      }
      return {
        channels: format.channels,
        rate: format.rate,
        bits: float ? 32 : 16,
        float,
        dataOffset: at + 8,
        dataBytes: size,
      };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${name} has no audio.`);
}

export function monoSamples(bytes: Uint8Array, name = "audio"): Float32Array {
  const header = wavHeader(bytes, name);
  if (header.channels !== 1 || header.rate !== MEETING_SAMPLE_RATE) {
    throw new Error(
      `${name} isn't mono ${MEETING_SAMPLE_RATE / 1000} kHz audio we read: ${header.channels} channels at ${header.rate} Hz`,
    );
  }
  const width = header.bits / 8;
  const available = Math.min(header.dataBytes, bytes.length - header.dataOffset);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(available / width));
  for (let i = 0; i < out.length; i++) {
    const at = header.dataOffset + i * width;
    out[i] = header.float ? view.getFloat32(at, true) : view.getInt16(at, true) / 32768;
  }
  return out;
}

export function toPcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, (sample) =>
    Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
  );
}

export function encodeWav(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(MEETING_SAMPLE_RATE, 24);
  out.writeUInt32LE(MEETING_SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(out, 44);
  return out;
}
