/**
 * Where the built-in models download from (#1578), so they reach the User wherever they are,
 * mainland China included, with no setting. Each file is tried at Hugging Face, IncarnaMind's own
 * copy on ModelScope, hf-mirror.com and IncarnaMind's own copy on Cloudflare R2, in turn. A probe
 * of Hugging Face and the other source decides which leads: ModelScope once IncarnaMind's copy
 * there exists, hf-mirror.com until then. Whatever a source sends is checked against the size and
 * SHA-256 the app pins (./download), never against the source's own word, so a source that serves
 * other bytes falls through to the next.
 *
 * Network traffic that carries no User content: the probe is a HEAD request to each host's
 * front page.
 */
import type { Logger, ModelFile } from "../adapters";
import type { ModelSourceChoice, ModelSourceId } from "../api";
import type { Language } from "../language";

/**
 * One of IncarnaMind's own copies of the models: `url` is the base URL of a model's folder
 * ("{folder}" stands for its folder under models/), holding the files at the paths the app pins;
 * `hosts` are the other hosts it may send a download on to, such as its CDN.
 */
export interface ModelCopy {
  /** Empty until the copy exists, since the order skips a source with no URL. */
  url: string;
  hosts?: readonly string[];
}

/** IncarnaMind's own copies of the models, each off until it exists. */
export interface ModelCopies {
  modelscope?: ModelCopy;
  r2?: ModelCopy;
}

/**
 * IncarnaMind's own copies, waiting on accounts: a copy exists once its `url` is filled in, and
 * one that doesn't is skipped. The files at any copy are the ones pinned for Hugging Face, byte
 * for byte, and every download is checked against their recorded SHA-256, so a copy that differs
 * falls through to the next source.
 */
export const MODEL_COPIES: ModelCopies = {
  modelscope: { url: "" },
  r2: { url: "" },
};

/** A copy's base URL, or null while the copy doesn't exist. */
export const modelCopyUrl = (copy: ModelCopy | null | undefined): string | null =>
  copy !== undefined && copy !== null && copy.url !== "" ? copy.url : null;

/** The probe gives each host this long to answer. */
export const PROBE_MS = 3000;
/** The probe's answer holds this long, unless the proxy changes. */
export const PROBE_KEPT_MS = 10 * 60_000;
/** A file that gets no bytes for this long moves to the next source. */
export const STALL_MS = 25_000;

const HUGGING_FACE = "huggingface.co";
const HF_MIRROR = "hf-mirror.com";
// A host and its subdomains. Hugging Face serves its files from its CDN on hf.co; hf-mirror.com
// sends a request from outside mainland China on to Hugging Face.
const HUGGING_FACE_HOSTS = [HUGGING_FACE, "hf.co"];
const OWN_HOSTS: Partial<Record<ModelSourceId, readonly string[]>> = {
  huggingface: HUGGING_FACE_HOSTS,
  "hf-mirror": [HF_MIRROR, ...HUGGING_FACE_HOSTS],
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const within = (host: string, hosts: readonly string[]) =>
  hosts.some((each) => host === each || host.endsWith(`.${each}`));
const PROBE_URLS = {
  huggingface: "https://huggingface.co/",
  modelscope: "https://www.modelscope.cn/",
  "hf-mirror": "https://hf-mirror.com/",
} as const;

const ORDER: readonly ModelSourceId[] = ["huggingface", "modelscope", "hf-mirror", "r2"];
// Where Hugging Face can't be reached: the other source leads, and the mirror comes before it.
const CHINA_ORDER: readonly ModelSourceId[] = ["modelscope", "hf-mirror", "huggingface", "r2"];

/** The redirect rule for a download made with no sources (`ModelSources.redirectAllowed`): Hugging Face's. */
export const redirectAllowedByDefault = (asked: URL, from: URL, to: URL) =>
  (from.protocol !== "https:" || to.protocol === "https:") &&
  (to.host === asked.host || within(to.hostname, HUGGING_FACE_HOSTS));

export interface ModelSourcesOptions {
  fetch: typeof fetch;
  now(): number;
  /** The interface's language: Chinese puts mainland China's order first when the probe can't tell. */
  language(): Language;
  /** The User's pick on a failed download's line ("auto" unless they made one). */
  choice(): ModelSourceChoice;
  /** The system proxy for Hugging Face, as the host resolves it: a change probes again. */
  proxy?(): Promise<string>;
  copies?: ModelCopies;
  /** Overrides how long a file may get no bytes (tests). */
  stallMs?: number;
  log?: Logger;
}

export interface SourcedUrl {
  source: ModelSourceId;
  url: URL;
}

export function createModelSources(options: ModelSourcesOptions) {
  const copies = options.copies ?? MODEL_COPIES;
  let probed: { at: number; proxy: string; rivalFirst: Promise<boolean> } | null = null;
  const failedUntil = new Map<ModelSourceId, number>();

  // Hugging Face can't be reached from mainland China, where the other source answers first.
  async function probe(): Promise<boolean> {
    const rival: keyof typeof PROBE_URLS = modelCopyUrl(copies.modelscope)
      ? "modelscope"
      : "hf-mirror";
    const ask = async (source: keyof typeof PROBE_URLS) => {
      const response = await options.fetch(PROBE_URLS[source], {
        method: "HEAD",
        credentials: "omit",
        signal: AbortSignal.timeout(PROBE_MS),
      });
      void response.body?.cancel();
      return source;
    };
    try {
      return (await Promise.any([ask("huggingface"), ask(rival)])) === rival;
    } catch (error) {
      options.log?.warn("modelSources.probeFailed", {
        hosts: [PROBE_URLS.huggingface, PROBE_URLS[rival]]
          .map((url) => new URL(url).host)
          .join(", "),
        reasons: (error instanceof AggregateError ? error.errors : [error])
          .map(messageOf)
          .join("; "),
        language: options.language(),
      });
      return options.language() === "zh-CN";
    }
  }

  async function proxyNow(): Promise<string> {
    try {
      return (await options.proxy?.()) ?? "";
    } catch (error) {
      options.log?.warn("modelSources.proxyUnknown", {
        host: HUGGING_FACE,
        message: messageOf(error),
      });
      return "";
    }
  }

  async function rivalFirst(): Promise<boolean> {
    const proxy = await proxyNow();
    const now = options.now();
    if (!probed || now - probed.at >= PROBE_KEPT_MS || probed.proxy !== proxy) {
      probed = { at: now, proxy, rivalFirst: probe() };
      failedUntil.clear();
    }
    return probed.rivalFirst;
  }

  const copyOf = (copy: ModelCopy | undefined, folder: string, file: ModelFile) => {
    const base = modelCopyUrl(copy);
    return base === null
      ? null
      : new URL(file.path, base.replaceAll("{folder}", encodeURIComponent(folder)));
  };

  function hostsOf(source: ModelSourceId): readonly string[] {
    const copy = source === "modelscope" ? copies.modelscope : source === "r2" ? copies.r2 : null;
    const base = modelCopyUrl(copy);
    if (copy === null || copy === undefined || base === null) return OWN_HOSTS[source] ?? [];
    return [new URL(base.replaceAll("{folder}", "folder")).host, ...(copy.hosts ?? [])];
  }

  function urlOf(source: ModelSourceId, folder: string, file: ModelFile, baseUrl: string) {
    const pinned = new URL(file.url ?? file.path, baseUrl);
    switch (source) {
      case "huggingface":
        return pinned;
      case "hf-mirror": {
        if (pinned.host !== HUGGING_FACE) return null;
        const mirrored = new URL(pinned);
        mirrored.host = HF_MIRROR;
        return mirrored;
      }
      case "modelscope":
        return copyOf(copies.modelscope, folder, file);
      case "r2":
        return copyOf(copies.r2, folder, file);
    }
  }

  return {
    /**
     * Where to download a model's file from, in the order to try: the User's pick first, then
     * the probe's order, sources that failed lately last. `baseUrl` and the file's `url` are
     * the pinned Hugging Face location; `folder` is the model's folder under models/.
     */
    async urlsFor(folder: string, file: ModelFile, baseUrl: string): Promise<SourcedUrl[]> {
      const order = (await rivalFirst()) ? CHINA_ORDER : ORDER;
      const picked = options.choice();
      const now = options.now();
      const late = (source: ModelSourceId) => (failedUntil.get(source) ?? 0) > now;
      const ranked = [
        ...order.filter((source) => source === picked),
        ...order.filter((source) => source !== picked && !late(source)),
        ...order.filter((source) => source !== picked && late(source)),
      ];
      return ranked.flatMap((source) => {
        const url = urlOf(source, folder, file, baseUrl);
        return url ? [{ source, url }] : [];
      });
    },
    /** A source failed a file: it goes last for the other files, until the probe is run again. */
    failed(source: ModelSourceId): void {
      failedUntil.set(source, options.now() + PROBE_KEPT_MS);
    },
    /**
     * Whether a source may send a download from `from` on to `to`: never from https to http,
     * and only to the source's own hosts, or the host it was asked at.
     */
    redirectAllowed(source: ModelSourceId, asked: URL, from: URL, to: URL): boolean {
      if (from.protocol === "https:" && to.protocol !== "https:") return false;
      return to.host === asked.host || within(to.hostname, hostsOf(source));
    },
    stallMs: options.stallMs ?? STALL_MS,
    fetch: options.fetch,
  };
}

export type ModelSources = ReturnType<typeof createModelSources>;
