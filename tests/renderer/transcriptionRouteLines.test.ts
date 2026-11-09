import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Settings, TranscriptionServiceStatus } from "../../src/core/api";
import type { ServicesView } from "../../src/renderer/src/transcriptionServices";

/*
 * What Settings › AI and Settings › Meetings say under the meeting transcription route (#2913):
 * with "Keep everything on this computer" on, no cloud service gets the audio, so neither page
 * says where it goes, and neither offers a choice that Local mode doesn't allow.
 */

const SENDS: Record<"en" | "zh-CN", { full: string; audio: string; paused: string; once: string }> =
  {
    en: {
      full: "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names in its note, calendar event and folder’s documents.",
      audio: "Audio goes to Soniox while you record.",
      paused: "Paused: “Keep everything on this computer” is on.",
      once: "Once you choose a cloud service, it gets the meeting’s audio while you record, with your name, your Words to know, the meeting’s folder name, and the names in its note, calendar event and folder’s documents.",
    },
    "zh-CN": {
      full: "录音期间，音频会发送给 Soniox，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字。",
      audio: "录音期间，音频会发送给 Soniox。",
      paused: "已暂停：已开启“所有内容都留在这台电脑上”。",
      once: "选择云服务后，录音期间会议音频会发送给该服务，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字。",
    },
  };

const soniox = (own: Partial<TranscriptionServiceStatus> = {}): TranscriptionServiceStatus => ({
  route: "soniox",
  name: "soniox",
  recipient: { en: "Soniox", zh: "Soniox" },
  model: "m",
  perHour: { currency: "USD", amount: 0.12 },
  perHourWithWords: null,
  region: null,
  dataUse: null,
  key: "own",
  providerId: null,
  hasKey: true,
  refused: false,
  liveSpeakers: false,
  keyUrl: null,
  billingUrl: null,
  server: null,
  keyOptional: false,
  keyChecked: true,
  languages: ["en", "zh"],
  missingLanguages: [],
  chooseAgain: false,
  wordsWaiting: false,
  ...own,
});

const ready = (...data: TranscriptionServiceStatus[]): ServicesView => ({ state: "ready", data });

let root: Root | null = null;
let container: HTMLElement;
let Consent: ComponentType<{ read: ServicesView }>;
let Line: ComponentType<{ read: ServicesView }>;
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each
          ? (each as Record<string, unknown>)[name as string]
          : () => Promise.resolve([]),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const settingsPath = "../../src/renderer/src/components/meetings/TranscriptionSettings.tsx";
  const settings: {
    TranscriptionRouteConsent: typeof Consent;
    TranscriptionRouteLine: typeof Line;
  } = await import(settingsPath);
  Consent = settings.TranscriptionRouteConsent;
  Line = settings.TranscriptionRouteLine;
  ({ useAppStore } = await import("../../src/renderer/src/store"));
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

function setUp(language: "en" | "zh-CN", route: string | null, localOnly: boolean) {
  useAppStore.setState({
    settings: { language, device: { transcriptionRoute: route } } as unknown as Settings,
    embedding: { localOnly } as never,
  } as never);
}

const paragraphs = () => [...container.querySelectorAll("p")].map((each) => each.textContent);
const consentRow = () => container.querySelector('[data-testid="meetings-route-consent"]');

describe.each(["en", "zh-CN"] as const)(
  "Settings › AI, under Meeting transcription (%s)",
  (language) => {
    const said = SENDS[language];
    const render = (read: ServicesView) =>
      act(() => root?.render(createElement(Consent, { read })));

    // protects=a cloud service chosen with Local mode off says where the audio goes, with the words to know; fails_when=the line changes or goes when Local mode is off; no_claim=the agreement summary and link, which the smoke spec reads.
    test("with a cloud service chosen and Local mode off, says where the audio goes", async () => {
      setUp(language, "soniox", false);
      await render(ready(soniox()));
      expect(consentRow()?.textContent).toBe(said.full);
    });

    // protects=the audio-only line while the words to know wait, with Local mode off; fails_when=the words are named as sent before the User allowed them; no_claim=allowing them.
    test("with the words to know waiting, says the audio alone goes", async () => {
      setUp(language, "soniox", false);
      await render(ready(soniox({ wordsWaiting: true })));
      expect(consentRow()?.textContent).toBe(said.audio);
    });

    // protects=Local mode on with a cloud service still chosen says it is paused and never names the service; fails_when=the line says where the audio goes while nothing is sent; no_claim=the picker, which shows this computer.
    test("with a cloud service chosen and Local mode on, says it is paused, not where the audio goes", async () => {
      setUp(language, "soniox", true);
      await render(ready(soniox()));
      expect(consentRow()?.textContent).toBe(said.paused);
      expect(container.textContent).not.toContain("Soniox");
    });

    // protects=the paused line while the words to know wait; fails_when=the audio-only line shows in Local mode; no_claim=anything about the words themselves.
    test("with the words waiting and Local mode on, still says it is paused", async () => {
      setUp(language, "soniox", true);
      await render(ready(soniox({ wordsWaiting: true })));
      expect(consentRow()?.textContent).toBe(said.paused);
    });

    // protects=turning Local mode off brings the route's line back, and on takes it away, without the row being drawn again; fails_when=the row reads Local mode once and keeps it; no_claim=the setting's own switch.
    test("follows Local mode as it is turned on and off", async () => {
      setUp(language, "soniox", false);
      await render(ready(soniox({ wordsWaiting: true })));
      expect(consentRow()?.textContent).toBe(said.audio);
      await act(() => useAppStore.setState({ embedding: { localOnly: true } as never } as never));
      expect(consentRow()?.textContent).toBe(said.paused);
      await act(() => useAppStore.setState({ embedding: { localOnly: false } as never } as never));
      expect(consentRow()?.textContent).toBe(said.audio);
    });

    // protects=with a key saved and nothing chosen, Local mode off says what choosing one sends; fails_when=the sentence changes or goes; no_claim=the choice itself, which is the consent.
    test("with no cloud service chosen and Local mode off, says what choosing one sends", async () => {
      setUp(language, "local", false);
      await render(ready(soniox()));
      expect(consentRow()?.textContent).toBe(said.once);
    });

    // protects=Local mode on with nothing chosen offers no choice, so it doesn't say what choosing one sends; fails_when="Once you choose a cloud service" shows where none can be chosen; no_claim=the picker, which offers this computer alone.
    test.each(["local", null])(
      "with no cloud service chosen (route %s) and Local mode on, says nothing",
      async (route) => {
        setUp(language, route, true);
        await render(ready(soniox()));
        expect(consentRow()).toBeNull();
        expect(container.textContent).toBe("");
      },
    );

    // protects=the row says nothing while no service has a key, in either mode; fails_when=a sentence about choosing shows with nothing to choose; no_claim=Settings › AI's other rows.
    test.each([false, true])(
      "with no key saved (Local mode %s), says nothing",
      async (localOnly) => {
        setUp(language, "local", localOnly);
        await render(ready(soniox({ hasKey: false })));
        expect(container.textContent).toBe("");
      },
    );
  },
);

describe.each(["en", "zh-CN"] as const)(
  "Settings › Meetings, under Transcribe on (%s)",
  (language) => {
    const said = SENDS[language];
    const render = (read: ServicesView) => act(() => root?.render(createElement(Line, { read })));

    // protects=Settings › Meetings says the same of a cloud service chosen as Settings › AI does, in both modes; fails_when=the two pages' lines differ for one state; no_claim=the price line above it.
    test.each([
      [false, "full"],
      [true, "paused"],
    ] as const)(
      "with a cloud service chosen and Local mode %s, says the same line as Settings › AI",
      async (localOnly, line) => {
        setUp(language, "soniox", localOnly);
        await render(ready(soniox()));
        expect(paragraphs()).toContain(said[line]);
        await act(() => root?.render(createElement(Consent, { read: ready(soniox()) })));
        expect(consentRow()?.textContent).toBe(said[line]);
      },
    );
  },
);
