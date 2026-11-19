// A replacement Soniox session starts its word times at zero. Keep the exact sample at
// the last confirmed position, including when that position falls inside a capture frame.
export class SonioxReplay {
  private readonly chunks: Int16Array[] = [];
  private retained = 0;
  private end = 0;

  constructor(private readonly limit: number) {}

  push(samples: Int16Array): void {
    this.end += samples.length;
    this.chunks.push(samples);
    this.retained += samples.length;
    while (this.retained > this.limit) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.retained - this.limit;
      if (excess < first.length) {
        this.chunks[0] = first.slice(excess);
        this.retained -= excess;
      } else {
        this.chunks.shift();
        this.retained -= first.length;
      }
    }
  }

  from(sample: number): Int16Array[] | null {
    let skip = sample - (this.end - this.retained);
    if (skip < 0 || sample > this.end) return null;
    const remaining: Int16Array[] = [];
    for (const chunk of this.chunks) {
      if (skip < chunk.length) remaining.push(chunk.subarray(skip));
      skip = Math.max(0, skip - chunk.length);
    }
    return remaining;
  }
}

export function transientSonioxLoss(code?: number): boolean {
  return (
    code !== undefined &&
    [408, 413, 500, 502, 503, 504, 1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014].includes(code)
  );
}
