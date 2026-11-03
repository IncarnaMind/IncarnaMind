/**
 * A real FFT of one power-of-two size, for the echo canceller (./echo). It
 * keeps bins 0 to size / 2 as separate real and imaginary arrays. `forward`
 * divides by the size and `inverse` doesn't, as Speex's MDF expects, so a
 * round trip gives the samples back.
 */
export function createRealFft(size: number) {
  const half = size / 2;
  if (!Number.isInteger(Math.log2(size)) || size < 4) {
    throw new Error(`The FFT size must be a power of two, not ${size}.`);
  }
  const bits = Math.log2(half);
  const reversed = new Uint32Array(half);
  for (let i = 0; i < half; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  const cosHalf = new Float64Array(half / 2);
  const sinHalf = new Float64Array(half / 2);
  for (let k = 0; k < half / 2; k++) {
    cosHalf[k] = Math.cos((2 * Math.PI * k) / half);
    sinHalf[k] = Math.sin((2 * Math.PI * k) / half);
  }
  const cosFull = new Float64Array(half + 1);
  const sinFull = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    cosFull[k] = Math.cos((2 * Math.PI * k) / size);
    sinFull[k] = Math.sin((2 * Math.PI * k) / size);
  }
  const zr = new Float64Array(half);
  const zi = new Float64Array(half);

  /** In place on `zr` and `zi`; `sign` -1 forward, +1 inverse, unscaled. */
  function complexFft(sign: number): void {
    for (let i = 0; i < half; i++) {
      const j = reversed[i] as number;
      if (j > i) {
        const r = zr[i] as number;
        zr[i] = zr[j] as number;
        zr[j] = r;
        const m = zi[i] as number;
        zi[i] = zi[j] as number;
        zi[j] = m;
      }
    }
    for (let length = 2; length <= half; length <<= 1) {
      const step = half / length;
      const span = length >> 1;
      for (let start = 0; start < half; start += length) {
        for (let k = 0; k < span; k++) {
          const wr = cosHalf[k * step] as number;
          const wi = sign * (sinHalf[k * step] as number);
          const a = start + k;
          const b = a + span;
          const br = zr[b] as number;
          const bi = zi[b] as number;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          const ar = zr[a] as number;
          const ai = zi[a] as number;
          zr[b] = ar - tr;
          zi[b] = ai - ti;
          zr[a] = ar + tr;
          zi[a] = ai + ti;
        }
      }
    }
  }

  return {
    size,
    bins: half + 1,

    /** The spectrum of `input` (`size` samples), divided by the size. */
    forward(input: Float64Array, re: Float64Array, im: Float64Array): void {
      for (let n = 0; n < half; n++) {
        zr[n] = input[2 * n] as number;
        zi[n] = input[2 * n + 1] as number;
      }
      complexFft(-1);
      const scale = 1 / size;
      for (let k = 0; k <= half; k++) {
        const a = k % half;
        const b = (half - k) % half;
        const ar = zr[a] as number;
        const ai = zi[a] as number;
        const br = zr[b] as number;
        const bi = -(zi[b] as number);
        const er = (ar + br) / 2;
        const ei = (ai + bi) / 2;
        const or = (ai - bi) / 2;
        const oi = -(ar - br) / 2;
        const wr = cosFull[k] as number;
        const wi = -(sinFull[k] as number);
        re[k] = (er + or * wr - oi * wi) * scale;
        im[k] = (ei + or * wi + oi * wr) * scale;
      }
    },

    /** The samples of a spectrum (bins 0 to size / 2), not divided by the size. */
    inverse(re: Float64Array, im: Float64Array, output: Float64Array): void {
      for (let k = 0; k < half; k++) {
        const ar = re[k] as number;
        const ai = im[k] as number;
        const br = re[half - k] as number;
        const bi = -(im[half - k] as number);
        const dr = ar - br;
        const di = ai - bi;
        const wr = cosFull[k] as number;
        const wi = sinFull[k] as number;
        const or = dr * wr - di * wi;
        const oi = dr * wi + di * wr;
        zr[k] = ar + br - oi;
        zi[k] = ai + bi + or;
      }
      complexFft(1);
      for (let n = 0; n < half; n++) {
        output[2 * n] = zr[n] as number;
        output[2 * n + 1] = zi[n] as number;
      }
    },
  };
}
