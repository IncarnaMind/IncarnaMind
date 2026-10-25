/**
 * Films the built app for the README: the window's frames from Chromium's screencast at twice the
 * pixel density, the pointer and a ring at each click drawn in the page, the captions on a band
 * under the window, smooth zooms as camera moves over the frames, and ffmpeg to make the master,
 * the GIF and the MP4. The app is never retouched: a cut only leaves out what happens between two
 * frames, and a zoom only magnifies the pixels the app drew.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

/** The width the captions and the pointer are sized for: the README shows its GIF this wide. */
export const DESIGN_WIDTH = 880;
/** The recording is made at twice the pixel density, so text is crisp. */
export const PIXEL_RATIO = 2;
/** What the recording is filmed at, as the window's content: the captions have a band under it. */
export const CAPTION_BAND = 56;
export const FILMED = { width: 1100, height: 700 - CAPTION_BAND };
/** The band's colour: DESIGN.md's `frame`, so a white pill shows on it. */
const BAND = "F4F5F7";
/** The accent of DESIGN.md, as the click ring's colour. */
const ACCENT = "42, 91, 215";
/** How far the pointer travels in a second, in the window's pixels: slow enough to follow. */
const POINTER_SPEED = 500;
/** The master and the MP4 are made at this many frames a second. */
const FRAME_RATE = 30;
/** A zoom eases in and out over this long, and goes no further than this. */
export const ZOOM = { seconds: 0.6, most: 1.6 };
/** What a zoom leaves round the part it is onto, in the window's pixels. */
const MARGIN = 14;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Frame {
  file: string;
  at: number;
  end?: number;
  speed: number;
}

interface Zoom {
  at: number;
  out: number | null;
  factor: number;
  /** The point of the window that stays where it is while the zoom runs, in the window's pixels. */
  anchor: { x: number; y: number };
}

const seconds = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** The caption pills as pictures with a clear background, by their text, in the app's own fonts. */
export async function renderPills(texts: readonly string[], folder: string) {
  await mkdir(folder, { recursive: true });
  const fonts = resolve(__dirname, "../../node_modules/@fontsource-variable/source-sans-3/files");
  // Sizes are given as they read at the GIF's width: 15px at 880 wide.
  const unit = (FILMED.width * PIXEL_RATIO) / DESIGN_WIDTH;
  const page = `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: "Source Sans 3"; font-weight: 200 900;
      src: url("file://${fonts}/source-sans-3-latin-wght-normal.woff2") format("woff2");
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122; }
    @font-face { font-family: "Source Sans 3"; font-weight: 200 900;
      src: url("file://${fonts}/source-sans-3-latin-ext-wght-normal.woff2") format("woff2");
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF; }
    body { margin: 0; background: transparent; }
    #frame { display: inline-block; padding: ${14 * unit}px; }
    #pill { display: inline-block; white-space: nowrap; background: #fff; color: #17191c;
      border-radius: 999px; padding: ${6 * unit}px ${16 * unit}px;
      font: 500 ${15 * unit}px/${22 * unit}px "Source Sans 3", "PingFang SC", "Hiragino Sans GB",
        "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      box-shadow: 0 ${2 * unit}px ${10 * unit}px rgba(23,25,28,.18), 0 0 0 ${unit}px rgba(23,25,28,.08); }
  </style><div id="frame"><div id="pill"></div></div>`;
  const file = join(folder, "pill.html");
  await writeFile(file, page);
  const browser = await chromium.launch();
  const pills = new Map<string, string>();
  try {
    const tab = await browser.newPage({ deviceScaleFactor: 1 });
    await tab.goto(`file://${file}`);
    for (const [index, text] of texts.entries()) {
      await tab.evaluate((value) => {
        const pill = document.getElementById("pill");
        if (pill) pill.textContent = value;
      }, text);
      await tab.evaluate(() => document.fonts.ready);
      const path = join(folder, `pill-${index}.png`);
      await tab.locator("#frame").screenshot({ path, omitBackground: true });
      pills.set(text, path);
    }
  } finally {
    await browser.close();
  }
  return pills;
}

/** Cubic ease in and out, the same curve in the page's pointer and in the filter. */
const easeExpression = (u: string) => `if(lt(${u},0.5),4*pow(${u},3),1-pow(-2*${u}+2,3)/2)`;

/**
 * The window's frames as Chromium paints them. Frames are kept only between `keep(true)` and
 * `keep(false)`, so what the model took to answer, or a screen the next scene replaces, is a
 * straight cut. `speed` plays what is kept faster, never more than twice.
 */
export class Film {
  private frames: Frame[] = [];
  private pending: Promise<void>[] = [];
  private latest: { data: string; at: number } | null = null;
  private keeping = false;
  private since = 0;
  private rate = 1;
  private count = 0;
  private arrived = 0;
  private readonly captions: { at: number; text: string | null }[] = [];
  private readonly zooms: Zoom[] = [];
  private readonly marks = new Map<string, number>();

  private constructor(
    private readonly session: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>,
    readonly folder: string,
    private readonly pills: ReadonlyMap<string, string>,
  ) {}

  static async start(
    page: Page,
    folder: string,
    pills: ReadonlyMap<string, string>,
  ): Promise<Film> {
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    const session = await page.context().newCDPSession(page);
    const film = new Film(session, folder, pills);
    session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      film.take(data, metadata.timestamp ?? seconds());
      void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    });
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 95,
      maxWidth: FILMED.width * PIXEL_RATIO,
      maxHeight: FILMED.height * PIXEL_RATIO,
      everyNthFrame: 1,
    });
    return film;
  }

  private take(data: string, at: number): void {
    this.arrived++;
    this.latest = { data, at };
    if (this.keeping && at >= this.since) this.add(data, at);
  }

  private add(data: string, at: number): void {
    const previous = this.frames.at(-1);
    if (previous && previous.end === undefined) previous.end = at;
    const file = `${String(this.count++).padStart(6, "0")}.jpg`;
    this.frames.push({ file, at, speed: this.rate });
    this.pending.push(writeFile(join(this.folder, file), Buffer.from(data, "base64")));
  }

  /** Resolves once the page has painted a frame after this call, or after `timeoutMs`. */
  async nextFrame(timeoutMs: number): Promise<void> {
    const seen = this.arrived;
    const until = Date.now() + timeoutMs;
    while (this.arrived === seen && Date.now() < until) await sleep(15);
  }

  /** Starts or stops keeping frames. Starting keeps what is on screen at once. */
  keep(on: boolean): void {
    if (on === this.keeping) return;
    const now = seconds();
    this.keeping = on;
    if (on) {
      this.since = now;
      if (this.latest) this.add(this.latest.data, now);
    } else {
      const last = this.frames.at(-1);
      if (last && last.end === undefined) last.end = now;
    }
  }

  /** Plays what is kept from now on this many times faster (at most 2). */
  speed(rate: number): void {
    this.rate = Math.min(Math.max(rate, 1), 2);
  }

  /** How long the recording is so far, in seconds as it plays. */
  get kept(): number {
    return this.frames.reduce(
      (sum, frame) => sum + ((frame.end ?? seconds()) - frame.at) / frame.speed,
      0,
    );
  }

  /** The caption from this moment of the recording on; null for none. */
  caption(text: string | null): void {
    this.captions.push({ at: this.kept, text });
  }

  /** Names this moment of the recording, so a cut of it can be made between two names. */
  mark(name: string): void {
    this.marks.set(name, this.kept);
  }

  /** Every mark and the second of the recording it names. */
  markTimes(): Record<string, number> {
    return Object.fromEntries(this.marks);
  }

  /**
   * Starts a zoom onto a part of the window, easing in over `ZOOM.seconds`: the window's pixels
   * magnified by `factor` (never more than `ZOOM.most`) about the point that keeps `rect` in view.
   */
  zoomIn(rect: Rect, factor: number): number {
    if (this.zooms.at(-1)?.out === null) throw new Error("A zoom is already in.");
    const { width, height } = FILMED;
    // Never closer than keeps the whole rectangle, and a margin round it, in the frame.
    const fits = Math.min(width / (rect.width + 2 * MARGIN), height / (rect.height + 2 * MARGIN));
    const f = clamp(Math.min(factor, fits), 1.05, ZOOM.most);
    const left = clamp(rect.x + rect.width / 2 - width / (2 * f), 0, width - width / f);
    const top = clamp(rect.y + rect.height / 2 - height / (2 * f), 0, height - height / f);
    this.zooms.push({
      at: this.kept,
      out: null,
      factor: f,
      anchor: { x: left / (1 - 1 / f), y: top / (1 - 1 / f) },
    });
    return f;
  }

  /** Starts the zoom out, easing over `ZOOM.seconds`. */
  zoomOut(): void {
    const open = this.zooms.at(-1);
    if (open && open.out === null) open.out = this.kept;
  }

  async stop(): Promise<void> {
    this.keep(false);
    this.zoomOut();
    await this.session.send("Page.stopScreencast").catch(() => undefined);
    await this.session.detach().catch(() => undefined);
    await Promise.all(this.pending);
    const last = this.frames.at(-1);
    if (last && last.end === undefined) last.end = last.at + 0.1;
  }

  /** The kept frames, each held for how long it was on screen, as ffmpeg's concat list. */
  private async list(): Promise<string> {
    const lines = this.frames.flatMap((frame) => [
      `file '${frame.file}'`,
      `duration ${Math.max(((frame.end ?? frame.at) - frame.at) / frame.speed, 0.001).toFixed(4)}`,
    ]);
    const last = this.frames.at(-1);
    if (last) lines.push(`file '${last.file}'`);
    const path = join(this.folder, "frames.txt");
    await writeFile(path, `${lines.join("\n")}\n`);
    return path;
  }

  /** The seconds each caption is up, from its first words to the next caption. */
  private intervals(): Map<string, [number, number][]> {
    const total = this.kept;
    const shown = new Map<string, [number, number][]>();
    for (const [index, { at, text }] of this.captions.entries()) {
      if (text === null) continue;
      const until = this.captions[index + 1]?.at ?? total;
      shown.set(text, [...(shown.get(text) ?? []), [at, until]]);
    }
    return shown;
  }

  /** The zoompan filter for every zoom of the recording; null when there is none. */
  private zoomFilter(): string | null {
    if (this.zooms.length === 0) return null;
    const time = `(on/${FRAME_RATE})`;
    const ramps = this.zooms.map((zoom) => {
      const out = zoom.out ?? this.kept;
      const rising = `clip((${time}-${zoom.at.toFixed(3)})/${ZOOM.seconds},0,1)`;
      const falling = `clip((${time}-${out.toFixed(3)})/${ZOOM.seconds},0,1)`;
      return {
        zoom,
        weight: `((${easeExpression(rising)})*(1-(${easeExpression(falling)})))`,
      };
    });
    const factor = `1+${ramps.map(({ zoom, weight }) => `${(zoom.factor - 1).toFixed(4)}*${weight}`).join("+")}`;
    const anchor = (axis: "x" | "y") =>
      ramps
        .map(
          ({ zoom, weight }) => `${(zoom.anchor[axis] * PIXEL_RATIO).toFixed(2)}*gt(${weight},0)`,
        )
        .join("+");
    return (
      `zoompan=z='${factor}':x='(${anchor("x")})*(1-1/zoom)':y='(${anchor("y")})*(1-1/zoom)':` +
      `d=1:s=${FILMED.width * PIXEL_RATIO}x${FILMED.height * PIXEL_RATIO}:fps=${FRAME_RATE}`
    );
  }

  /**
   * The master: every frame, zoomed as the recording asks, on a canvas with the caption band, the
   * captions laid over it in their turns. The GIF and the MP4 are made from it, so both show the
   * same pixels. Returns its size in bytes.
   */
  async master(output: string): Promise<number> {
    const list = await this.list();
    const total = this.kept + 1;
    const shown = [...this.intervals()].flatMap(([text, spans]) => {
      const path = this.pills.get(text);
      return path ? [{ path, spans }] : [];
    });
    const width = FILMED.width * PIXEL_RATIO;
    const height = FILMED.height * PIXEL_RATIO;
    const band = CAPTION_BAND * PIXEL_RATIO;
    const stages = shown.map(({ spans }, index) => {
      const enable = spans.map(([from, to]) => `between(t,${from.toFixed(3)},${to.toFixed(3)})`);
      return (
        `[v${index}][${index + 1}:v]overlay=x=(main_w-overlay_w)/2:` +
        `y=${height}+(${band}-overlay_h)/2:shortest=1:enable='${enable.join("+")}'[v${index + 1}]`
      );
    });
    const zoom = this.zoomFilter();
    const graph = [
      `[0:v]fps=${FRAME_RATE}${zoom ? `,${zoom}` : ""},pad=${width}:${height + band}:0:0:color=0x${BAND}[v0]`,
      ...stages,
      `[v${shown.length}]format=gbrp[out]`,
    ].join(";");
    await ffmpeg([
      ...["-f", "concat", "-safe", "0", "-i", list],
      ...shown.flatMap(({ path }) => [
        ...["-loop", "1", "-framerate", String(FRAME_RATE), "-t", total.toFixed(2), "-i", path],
      ]),
      ...["-filter_complex", graph, "-map", "[out]"],
      ...["-c:v", "libx264rgb", "-preset", "veryfast", "-crf", "6", "-an"],
      output,
    ]);
    return (await stat(output)).size;
  }
}

export interface GifEncoding {
  fps: number;
  /** The GIF's width in pixels. */
  width: number;
  /** Fewer colours make a smaller GIF. */
  colors?: number;
}

/**
 * The README's GIF: the given spans of the master, one after another with straight cuts, at a
 * palette made for them. Returns its size in bytes.
 */
export async function encodeGif(
  master: string,
  output: string,
  spans: readonly [number, number][],
  { fps, width, colors = 256 }: GifEncoding,
): Promise<number> {
  const pieces = spans.map(
    ([from, to], index) =>
      `[0:v]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS[s${index}]`,
  );
  const joined = spans.map((_, index) => `[s${index}]`).join("");
  const graph = [
    ...pieces,
    `${joined}concat=n=${spans.length}:v=1:a=0[c]`,
    `[c]fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b]`,
    `[a]palettegen=max_colors=${colors}:stats_mode=diff[p]`,
    `[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]`,
  ].join(";");
  await ffmpeg([
    ...["-i", master],
    ...["-filter_complex", graph, "-map", "[out]"],
    ...["-loop", "0"],
    output,
  ]);
  return (await stat(output)).size;
}

/** The README's full story: H.264, yuv420p, no audio, 1920 px wide, 30 frames a second. Returns its size in bytes. */
export async function encodeMp4(master: string, output: string, crf = 22): Promise<number> {
  await ffmpeg([
    ...["-i", master],
    ...["-vf", "scale=1920:-2:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p"],
    ...["-r", String(FRAME_RATE)],
    ...["-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-profile:v", "high"],
    ...["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"],
    ...["-color_range", "tv"],
    ...["-movflags", "+faststart", "-an"],
    output,
  ]);
  return (await stat(output)).size;
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg stopped with ${code}`)),
    );
  });
}

interface OverlayApi {
  /** Changes a pixel nobody can see, so the page paints a frame now. */
  nudge(): void;
  /** Keeps the pointer and the click ring the size they read at while the camera zooms. */
  zoom(to: number, ms: number): void;
  endCard(card: { icon: string; lines: string[] } | null): void;
}

/**
 * Draws the recording's own layer over the page, above a modal dialog and the app's popovers
 * too: the pointer, a ring at every click and the end card. It exists only in the recording.
 */
export async function installOverlay(page: Page): Promise<void> {
  await page.evaluate(
    ({ accent, unit, band }) => {
      if (document.getElementById("demo-overlay")) return;
      // Sizes are given as they read in the GIF, 880 wide.
      const root = document.createElement("div");
      root.id = "demo-overlay";
      root.setAttribute("popover", "manual");
      root.style.cssText = [
        "position:fixed",
        "inset:0",
        "width:100vw",
        "height:100vh",
        "margin:0",
        "padding:0",
        "border:0",
        "background:transparent",
        "overflow:visible",
        "pointer-events:none",
      ].join(";");

      let zoom = 1;
      let travel: { from: number; to: number; start: number; ms: number } | null = null;
      const at = { x: 0, y: 0 };

      const pointer = document.createElement("div");
      pointer.style.cssText = `position:absolute;left:0;top:0;width:${16 * unit}px;height:${
        16 * unit
      }px;display:none;transform-origin:${2.2 * unit}px ${1.2 * unit}px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))`;
      pointer.innerHTML =
        '<svg viewBox="0 0 16 16" width="100%" height="100%"><path d="M2.2 1.2 L2.2 12.4 L5 9.9 L7 14.4 L9.1 13.5 L7.2 9.1 L10.9 9.1 Z" fill="#17191C" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>';
      const placePointer = () => {
        pointer.style.transform = `translate(${at.x - 2.2 * unit}px,${at.y - 1.2 * unit}px) scale(${1 / zoom})`;
      };

      const card = document.createElement("div");
      card.style.cssText = [
        "position:absolute",
        "inset:0",
        "display:none",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        `gap:${10 * unit}px`,
        `background:#${band}`,
        "color:#17191C",
        "text-align:center",
        `font-family:${getComputedStyle(document.body).fontFamily}`,
      ].join(";");

      const nudge = document.createElement("div");
      nudge.style.cssText =
        "position:absolute;left:0;top:0;width:1px;height:1px;background:rgba(0,0,0,.004)";

      root.append(card, pointer, nudge);
      document.body.append(root);
      root.showPopover();
      // A popover or modal dialog shown after this one lies over it in the top layer: put it back on top.
      const raise = (event: Event) => {
        if (event.target === root) return;
        root.hidePopover();
        root.showPopover();
      };
      document.addEventListener("toggle", raise, true);
      new MutationObserver(() => {
        if (document.querySelector("dialog[open]:modal")) raise(new Event("toggle"));
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });

      document.addEventListener(
        "mousemove",
        (event) => {
          if (card.style.display !== "none") return;
          at.x = event.clientX;
          at.y = event.clientY;
          pointer.style.display = "block";
          placePointer();
        },
        true,
      );
      document.addEventListener(
        "mousedown",
        (event) => {
          const size = (24 * unit) / zoom;
          const ring = document.createElement("div");
          ring.style.cssText = [
            "position:absolute",
            `left:${event.clientX - size / 2}px`,
            `top:${event.clientY - size / 2}px`,
            `width:${size}px`,
            `height:${size}px`,
            "border-radius:50%",
            `background:rgba(${accent},.25)`,
            `border:${(2 * unit) / zoom}px solid rgba(${accent},.25)`,
            "box-sizing:border-box",
          ].join(";");
          root.append(ring);
          ring
            .animate(
              [
                { transform: "scale(.5)", opacity: 1 },
                { transform: "scale(1.5)", opacity: 0 },
              ],
              { duration: 520, easing: "ease-out" },
            )
            .finished.then(
              () => ring.remove(),
              () => ring.remove(),
            );
        },
        true,
      );

      const ease = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);
      const step = () => {
        if (!travel) return;
        const u = Math.min(1, (performance.now() - travel.start) / travel.ms);
        zoom = travel.from + (travel.to - travel.from) * ease(u);
        placePointer();
        if (u < 1) requestAnimationFrame(step);
        else travel = null;
      };

      const api: OverlayApi = {
        nudge() {
          nudge.style.background =
            nudge.style.background === "rgba(0, 0, 0, 0.006)"
              ? "rgba(0,0,0,.004)"
              : "rgba(0,0,0,.006)";
        },
        zoom(to, ms) {
          travel = { from: zoom, to, start: performance.now(), ms };
          requestAnimationFrame(step);
        },
        endCard(content) {
          if (content === null) {
            card.style.display = "none";
            card.replaceChildren();
            return;
          }
          const [headline, ...rest] = content.lines;
          const icon = document.createElement("img");
          icon.src = content.icon;
          icon.style.cssText = `width:${64 * unit}px;height:${64 * unit}px;margin-bottom:${8 * unit}px`;
          const title = document.createElement("div");
          title.textContent = headline ?? "";
          title.style.cssText = `font-size:${34 * unit}px;font-weight:700;line-height:1.2`;
          card.replaceChildren(icon, title);
          rest.forEach((line, index) => {
            const row = document.createElement("div");
            row.textContent = line;
            const last = index === rest.length - 1;
            row.style.cssText = `font-size:${(last ? 15 : 18) * unit}px;color:${
              index === 0 ? "#3B4048" : "#656B74"
            };margin-top:${last ? 6 * unit : 0}px`;
            card.append(row);
          });
          pointer.style.display = "none";
          card.style.display = "flex";
        },
      };
      (globalThis as unknown as { demoOverlay: OverlayApi }).demoOverlay = api;
    },
    { accent: ACCENT, unit: FILMED.width / DESIGN_WIDTH, band: BAND },
  );
}

/** The pointer and the keyboard of a recording: slow, visible, and always as a person's. */
export class Hand {
  private x = 0;
  private y = 0;
  private zoomed = false;

  constructor(
    private readonly window: Page,
    private readonly film: Film,
  ) {}

  caption(text: string | null): void {
    this.film.caption(text);
  }

  endCard(card: { icon: string; lines: string[] } | null): Promise<void> {
    return this.window.evaluate(
      (value) => (globalThis as unknown as { demoOverlay: OverlayApi }).demoOverlay.endCard(value),
      card,
    );
  }

  /** Puts the pointer somewhere without showing it travel. */
  async place(x: number, y: number): Promise<void> {
    this.x = x;
    this.y = y;
    await this.window.mouse.move(x, y);
  }

  async glide(x: number, y: number): Promise<void> {
    const dx = x - this.x;
    const dy = y - this.y;
    const distance = Math.hypot(dx, dy);
    const duration = Math.min(1600, Math.max(450, (distance / POINTER_SPEED) * 1000));
    const steps = Math.max(2, Math.round(duration / 16));
    // A hand drifts a little off the straight line and comes back to it.
    const bow = Math.min(distance * 0.04, 24);
    const started = Date.now();
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const off = Math.sin(Math.PI * eased) * bow;
      const length = distance || 1;
      await this.window.mouse.move(
        this.x + dx * eased - (dy / length) * off,
        this.y + dy * eased + (dx / length) * off,
      );
      await sleep(Math.max(0, started + (duration * step) / steps - Date.now()));
    }
    await this.window.mouse.move(x, y);
    this.x = x;
    this.y = y;
  }

  /** The point to aim at in a locator: its middle, or a fraction of the way across it. */
  private async aim(target: Locator, at = { x: 0.5, y: 0.5 }): Promise<{ x: number; y: number }> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("The element isn't visible.");
    return { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
  }

  async moveTo(target: Locator, at?: { x: number; y: number }): Promise<void> {
    let point = await this.aim(target, at);
    await this.glide(point.x, point.y);
    // A list that moved while the pointer travelled is aimed at again.
    const again = await this.aim(target, at);
    if (Math.hypot(again.x - point.x, again.y - point.y) > 3) {
      point = again;
      await this.glide(point.x, point.y);
    }
  }

  async click(target: Locator, at?: { x: number; y: number }): Promise<void> {
    await this.moveTo(target, at);
    await this.press();
  }

  /** Clicks where the pointer is, as a hand does: a pause, the button down and up. */
  async press(clicks = 1): Promise<void> {
    await sleep(180);
    await this.window.mouse.down({ clickCount: clicks });
    await sleep(70);
    await this.window.mouse.up({ clickCount: clicks });
    await sleep(120);
  }

  /** Double-clicks a point of the window, as a hand selects a word. */
  async doubleClickAt(x: number, y: number): Promise<void> {
    await this.glide(x, y);
    await this.press(1);
    await this.press(2);
  }

  /** Types as a hand does: this many milliseconds a character, never quicker than twice a typist's pace. */
  async type(text: string, perCharacterMs = 70): Promise<void> {
    await this.window.keyboard.type(text, { delay: perCharacterMs });
  }

  /**
   * Runs `wait` with the film off, then puts the pointer back where it was (or at `parkAt`, a
   * place with nothing under it, between scenes) and goes on filming: what the model takes, or
   * something done between scenes, is a straight cut.
   */
  async cut<T>(wait: () => Promise<T>, parkAt?: { x: number; y: number }): Promise<T> {
    this.film.keep(false);
    try {
      return await wait();
    } finally {
      if (parkAt) await this.place(parkAt.x, parkAt.y);
      else await this.window.mouse.move(this.x, this.y);
      await this.begin();
    }
  }

  /** Starts keeping frames from what the page shows now, not from the last frame it painted. */
  async begin(): Promise<void> {
    const painted = this.film.nextFrame(800);
    await this.window.evaluate(() =>
      (globalThis as unknown as { demoOverlay: OverlayApi }).demoOverlay.nudge(),
    );
    await painted;
    await sleep(60);
    this.film.keep(true);
  }

  /** Holds the last frame of a scene, as the recording needs. */
  async hold(ms: number): Promise<void> {
    await sleep(ms);
  }

  /**
   * Zooms the camera onto these parts of the window and waits for it to arrive. The pointer
   * is still while it runs, so it is never called between a pointer's start and its click.
   */
  async zoomOn(targets: Locator | readonly Locator[], factor = 1.5): Promise<void> {
    const list = Array.isArray(targets) ? targets : [targets as Locator];
    const elements = (await Promise.all(list.map((target) => target.all()))).flat();
    const boxes = (await Promise.all(elements.map((element) => element.boundingBox()))).filter(
      (box): box is Rect => box !== null,
    );
    if (boxes.length === 0) throw new Error("Nothing to zoom onto is visible.");
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    await this.zoomOnRect({ x: left, y: top, width: right - left, height: bottom - top }, factor);
  }

  /** Zooms the camera onto a part of the window, given as a rectangle, and waits for it to arrive. */
  async zoomOnRect(rect: Rect, factor = 1.5): Promise<void> {
    const shown = this.film.zoomIn(rect, factor);
    this.zoomed = true;
    await this.window.evaluate(
      ([to, ms]) => (globalThis as unknown as { demoOverlay: OverlayApi }).demoOverlay.zoom(to, ms),
      [shown, ZOOM.seconds * 1000] as const,
    );
    await sleep(ZOOM.seconds * 1000);
  }

  /** Zooms back out to the whole window and waits for it. */
  async zoomOut(): Promise<void> {
    this.zoomed = false;
    this.film.zoomOut();
    await this.window.evaluate(
      ([to, ms]) => (globalThis as unknown as { demoOverlay: OverlayApi }).demoOverlay.zoom(to, ms),
      [1, ZOOM.seconds * 1000] as const,
    );
    await sleep(ZOOM.seconds * 1000);
  }

  async zoomOutIfIn(): Promise<void> {
    if (this.zoomed) await this.zoomOut();
  }
}
