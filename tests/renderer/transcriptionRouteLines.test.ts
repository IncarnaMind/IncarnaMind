import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CloudTranscriptionRoute,
  Settings,
  TranscriptionServiceStatus,
} from "../../src/core/api";
import type { ServicesView } from "../../src/renderer/src/transcriptionServices";
import { createTempDataFolder } from "../helpers/core";
import { transcribingCore } from "../helpers/transcription";

/*
 * What Settings › AI and Settings › Meetings say under the meeting transcription route (#2913):
 * with "Keep everything on this computer" on, no cloud service gets the audio, so neither page
 * says where it goes, and neither offers a choice that Local mode doesn't allow.
 */

const SENDS: Record<"en" | "zh-CN", { full: string; audio: string; paused: string; once: string }> =
  {
    en: {
      full: "Audio goes to Soniox while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
      audio: "Audio goes to Soniox while you record.",
      paused: "Paused: “Keep everything on this computer” is on.",
      once: "Once you choose a cloud service, it gets the meeting’s audio while you record, with your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    },
    "zh-CN": {
      full: "录音期间，音频会发送给 Soniox，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
      audio: "录音期间，音频会发送给 Soniox。",
      paused: "已暂停：已开启“所有内容都留在这台电脑上”。",
      once: "选择云服务后，录音期间会议音频会发送给该服务，同时发送你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
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
let Choice: ComponentType;
let Words: ComponentType<{ services: ServicesView }>;
let SetUp: ComponentType<{ service: TranscriptionServiceStatus; onDone(): void }>;
let useSetUp: (
  selectId: string,
  read: ServicesView,
) => {
  rows: {
    offers: readonly CloudTranscriptionRoute[];
    onChoose(route: CloudTranscriptionRoute): void;
  };
  panel: ReactNode;
};
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let useServices: typeof import("../../src/renderer/src/transcriptionServices").useTranscriptionServices;

/** What the core answers to the calls these components make; the renderer holds the first bridge it sees. */
let served: TranscriptionServiceStatus[] = [];
const answers: Record<string, () => unknown> = {
  listTranscriptionServices: () => ({ revision: 1, services: served }),
  getTranscriptionSpeed: () => ({ keepsUp: true }),
  getSecretStorage: () => ({ canSave: true, protection: "keychain" }),
};
const bridge = new Proxy(
  { on: () => () => undefined },
  {
    get: (each, name) =>
      name in each
        ? (each as Record<string, unknown>)[name as string]
        : () => Promise.resolve(typeof name === "string" ? (answers[name]?.() ?? []) : []),
  },
);

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => undefined });
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
  const choicePath = "../../src/renderer/src/components/meetings/TranscriptionRouteChoice.tsx";
  ({ TranscriptionRouteChoice: Choice } = await import(choicePath));
  const wordsPath = "../../src/renderer/src/components/meetings/WordsToKnow.tsx";
  ({ WordsToKnow: Words } = await import(wordsPath));
  const setUpPath = "../../src/renderer/src/components/meetings/TranscriptionSetUp.tsx";
  ({ TranscriptionSetUp: SetUp, useTranscriptionSetUp: useSetUp } = await import(setUpPath));
  ({ useAppStore } = await import("../../src/renderer/src/store"));
  ({ useTranscriptionServices: useServices } = await import(
    "../../src/renderer/src/transcriptionServices"
  ));
  useServices.setState({ services: null, revision: 0 });
  served = [];
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

    // protects=a cloud route saved, before the list of services is read: Local mode says it is paused, as it will once the list is read, and never what choosing a service sends; fails_when=the line says a service gets the audio and the words while Local mode sends nothing; no_claim=how long the read takes.
    test.each([
      [false, "once"],
      [true, "paused"],
    ] as const)(
      "with a cloud service saved, the list not read yet and Local mode %s, says the line for that mode",
      async (localOnly, line) => {
        setUp(language, "soniox", localOnly);
        await render({ state: "loading" });
        expect(paragraphs()).toEqual([said[line]]);
      },
    );
  },
);

const SET_BACK = {
  en: {
    deepgram: "Audio now stays on this computer. Choose Deepgram again to send it to Cloudflare.",
    qwen: "Audio now stays on this computer. Choose Qwen again to send it to International (Singapore).",
  },
  "zh-CN": {
    deepgram: "音频现在只留在这台电脑上。重新选择 Deepgram 后，音频会发送到 Cloudflare。",
    qwen: "音频现在只留在这台电脑上。重新选择通义千问后，音频会发送到国际（新加坡）。",
  },
} as const;

/** The services as the core lists them once a key began to send the audio elsewhere (#2999). */
const SET_BACK_SERVICES = {
  deepgram: soniox({
    route: "deepgram",
    name: "deepgram",
    recipient: { en: "Cloudflare", zh: "Cloudflare" },
    chooseAgain: true,
  }),
  qwen: soniox({
    route: "qwen",
    name: "qwen",
    recipient: { en: "Alibaba Cloud", zh: "阿里云" },
    region: { en: "International (Singapore)", zh: "国际（新加坡）" },
    key: "provider",
    providerId: "qwen",
    chooseAgain: true,
  }),
};

describe.each(["en", "zh-CN"] as const)(
  "A service set back to this computer because its key moved (%s)",
  (language) => {
    const pages = {
      ai: {
        render: (read: ServicesView) => act(() => root?.render(createElement(Consent, { read }))),
        line: () => consentRow()?.textContent,
      },
      meetings: {
        render: (read: ServicesView) => act(() => root?.render(createElement(Line, { read }))),
        line: () => container.querySelector('[data-testid="meetings-route-line"]')?.textContent,
      },
    };
    const localMode = (on: boolean) =>
      act(() => useAppStore.setState({ embedding: { localOnly: on } as never } as never));

    describe.each(["deepgram", "qwen"] as const)("%s's key", (route) => {
      const again = SET_BACK[language][route];
      const read = () => ready(SET_BACK_SERVICES[route]);

      // protects=Local mode on, with a service set back by its key, says what is true: paused, nothing to choose again; fails_when=the line asks the User to choose the service again, which Local mode refuses; no_claim=that refusal, which the core test holds.
      test.each(["ai", "meetings"] as const)(
        "Settings › %s says the route is paused while Local mode is on",
        async (page) => {
          setUp(language, "local", true);
          await pages[page].render(read());
          expect(pages[page].line()).toBe(SENDS[language].paused);
          expect(container.textContent).not.toContain(again);
        },
      );

      // protects=Local mode off, the line asks to choose the service again and names where the audio would go; fails_when=that line changes or goes; no_claim=choosing, which is the consent.
      test.each(["ai", "meetings"] as const)(
        "Settings › %s asks to choose it again once Local mode is off",
        async (page) => {
          setUp(language, "local", false);
          await pages[page].render(read());
          expect(pages[page].line()).toBe(again);
        },
      );

      // protects=turning Local mode off brings the choose-again line, and on takes it away, without the page being drawn again; fails_when=the page reads Local mode once and keeps it; no_claim=the setting's own switch.
      test.each(["ai", "meetings"] as const)(
        "Settings › %s follows Local mode as it is turned on and off",
        async (page) => {
          setUp(language, "local", true);
          await pages[page].render(read());
          expect(pages[page].line()).toBe(SENDS[language].paused);
          await localMode(false);
          expect(pages[page].line()).toBe(again);
          await localMode(true);
          expect(pages[page].line()).toBe(SENDS[language].paused);
        },
      );
    });

    // protects=what the core itself lists after a key moved while Local mode was on, by each way in, is paused on both pages and asks to choose again once Local mode is off; fails_when=either page asks for a choice Local mode refuses, or stops asking once it is off; no_claim=the core's refusal and the audio that goes nowhere, which liveRoutes.test.ts holds.
    test.each(["deepgram", "qwen"] as const)(
      "with the core's own list after %s's key moved in Local mode, both pages say paused until Local mode is off",
      async (route) => {
        const { core } = await transcribingCore(await createTempDataFolder());
        if (route === "deepgram") {
          await core.setTranscriptionKey({ route, apiKey: "dg-test-key-0123456789" });
        } else {
          await core.saveChatProvider({
            kind: "qwen",
            apiKey: "sk-qwen-test",
            modelId: "qwen3.7-plus",
          });
        }
        await core.updateSettings({ device: { transcriptionRoute: route } });
        await core.setLocalOnly(true);
        if (route === "deepgram") {
          await core.setTranscriptionKey({
            route,
            apiKey: "cf-test-token-0123456789",
            server:
              "https://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
          });
        } else {
          const beijing = (await core.listChatProviders()).find((each) => each.kind === "qwen");
          await core.saveChatProvider({
            kind: "qwen",
            endpoint: "intl",
            apiKey: "sk-qwen-intl-test",
            modelId: "qwen3.7-plus",
          });
          await core.deleteChatProvider(beijing?.id ?? "");
        }
        const show = async (embedding: unknown) => {
          useAppStore.setState({
            settings: { ...(await core.getSettings()), language },
            embedding,
          } as never);
          const read = ready(...(await core.listTranscriptionServices()).services);
          await pages.ai.render(read);
          const ai = pages.ai.line();
          await pages.meetings.render(read);
          return [ai, pages.meetings.line()];
        };
        const paused = SENDS[language].paused;
        expect(await show(await core.setLocalOnly(true))).toEqual([paused, paused]);
        const again = SET_BACK[language][route];
        expect(await show(await core.setLocalOnly(false))).toEqual([again, again]);
      },
    );

    // protects=a service not set back says what it did before, in Local mode: this computer, and nothing, on the two pages; fails_when=the paused line leaks onto a route that was never set back; no_claim=the paused line for a service chosen, which the tests above hold.
    test("a service that was not set back keeps its lines in Local mode", async () => {
      setUp(language, "local", true);
      await pages.meetings.render(ready(soniox()));
      expect(pages.meetings.line()).toBe(language === "en" ? "Private and free" : "私密、免费");
      await pages.ai.render(ready(soniox()));
      expect(pages.ai.line()).toBeUndefined();
    });
  },
);

const WORDS_HELP = {
  en: {
    told: "Each meeting’s transcriber is told your name, your Words to know, the meeting’s folder name, and the names and other capitalised words in its note, calendar event and folder’s documents.",
    cloud: "A cloud service you transcribe with gets them with the audio.",
    waiting: "Soniox gets the audio but not these words",
  },
  "zh-CN": {
    told: "每场会议的转写会用到你的名字、要识别的词、会议所在文件夹的名称，以及会议笔记、日历事件和该文件夹文档里的名字和首字母大写的词。",
    cloud: "用云服务转写时，这些词会随音频一起发送给该服务。",
    waiting: "Soniox 目前只收到音频，没有收到这些词",
  },
} as const;

describe.each(["en", "zh-CN"] as const)(
  "Settings › Meetings, under Words to know (%s)",
  (language) => {
    const said = WORDS_HELP[language];
    const render = async (route: string, localOnly: boolean, service = soniox()) => {
      useAppStore.setState({
        settings: {
          language,
          device: { transcriptionRoute: route },
          user: { meetingWords: [] },
        } as unknown as Settings,
        embedding: { localOnly } as never,
      } as never);
      await act(() => root?.render(createElement(Words, { services: ready(service) })));
      return container.textContent ?? "";
    };

    // protects=the help under Words to know says a cloud service gets the words only where one could: with Local mode on it says what the transcriber is told and nothing of a cloud service, whether a route is chosen, none is, or one's words wait; fails_when=Local mode shows the sentence that a cloud service gets the words with the audio, or the waiting line; no_claim=what the core sends, which cloudWords.test.ts holds.
    test.each([
      ["soniox", soniox()],
      ["local", soniox()],
      ["soniox", soniox({ wordsWaiting: true })],
    ] as const)(
      "with Local mode on (route %s), says what the transcriber is told and nothing of a cloud service",
      async (route, service) => {
        const text = await render(route, true, service);
        expect(text).toContain(said.told);
        expect(text).not.toContain(said.cloud);
        expect(text).not.toContain(said.waiting);
      },
    );

    test.each(["soniox", "local"])(
      "with Local mode off (route %s), says a cloud service gets them with the audio",
      async (route) => {
        const text = await render(route, false);
        expect(text).toContain(said.told);
        expect(text).toContain(said.cloud);
      },
    );

    test("with Local mode off and the words waiting, the waiting line says what Send gives, and the help doesn't say a cloud service gets them", async () => {
      const text = await render("soniox", false, soniox({ wordsWaiting: true }));
      expect(text).toContain(said.told);
      expect(text).toContain(said.waiting);
      expect(text).not.toContain(said.cloud);
    });
  },
);

const SHEET = {
  en: {
    here: "Transcribe on this computer",
    hereLine: "Private and free",
    cloud: "Transcribe with Soniox",
    price: "About $0.12 an hour",
  },
  "zh-CN": {
    here: "在这台电脑上转写",
    hereLine: "私密、免费",
    cloud: "用 Soniox 转写",
    price: "约每小时 $0.12",
  },
} as const;

// In the first recording's sheet and the set-up panel the line is the consent: choosing the
// service there is what lets the audio go. Local mode offers neither a way to choose one.
const withUse = soniox({
  dataUse: {
    summary: { en: "It keeps no audio.", zh: "它不保留音频。" },
    url: { en: "https://example.test/en", zh: "https://example.test/zh" },
  },
});
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const press = (element: Element | null) =>
  act(() => {
    element?.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
const mount = (element: ReturnType<typeof createElement>) => act(async () => root?.render(element));
const mountChoice = async () => {
  await mount(createElement(Choice));
  await vi.waitFor(() => expect(useServices.getState().services).not.toBeNull());
  await act(async () => undefined);
};

describe.each(["en", "zh-CN"] as const)("The first recording's sheet (%s)", (language) => {
  const said = SENDS[language];
  const sheet = SHEET[language];

  // protects=a cloud service chosen with Local mode off is named, with where the audio goes, and its way back; fails_when=the sheet stops saying where the audio goes; no_claim=the choice's own button, which the smoke spec presses.
  test("with Soniox chosen and Local mode off, names it and says where the audio goes", async () => {
    served = [soniox()];
    setUp(language, "soniox", false);
    await mountChoice();
    const line = byTestId("meeting-route");
    expect(line?.getAttribute("data-route")).toBe("soniox");
    expect(line?.textContent).toContain(sheet.cloud);
    expect(line?.textContent).toContain(said.full);
  });

  // protects=Local mode with Soniox chosen earlier shows this computer alone, and never says where the audio goes or that it is paused; fails_when=CloudLine shows in Local mode here, or Soniox is offered; no_claim=Settings, which says it is paused.
  test("with Soniox chosen earlier and Local mode on, shows this computer alone", async () => {
    served = [soniox()];
    setUp(language, "soniox", true);
    await mountChoice();
    const line = byTestId("meeting-route");
    expect(line?.getAttribute("data-route")).toBe("local");
    expect(line?.textContent).toBe(`${sheet.here}${sheet.hereLine}`);
    expect(byTestId("meeting-route-other")).toBeNull();
    expect(byTestId("meeting-route-here")).toBeNull();
  });

  // protects=each service under Other ways… says where its audio would go before it is chosen; fails_when=the list names no destination or its Use button is missing; no_claim=what pressing Use does.
  test("with nothing chosen and Local mode off, the list says where each service's audio goes, with a Use button", async () => {
    served = [withUse];
    setUp(language, null, false);
    await mountChoice();
    await press(byTestId("meeting-route-other"));
    expect(byTestId("meeting-route-ways")?.textContent).toContain(said.full);
    expect(byTestId("meeting-route-use-soniox")).not.toBeNull();
  });

  // protects=Local mode with a key saved offers no cloud service here: no Other ways…, no list, no Use button; fails_when=a service can be chosen from the sheet in Local mode; no_claim=the core's own refusal, which the core tests cover.
  test("with nothing chosen and Local mode on, offers no service to choose", async () => {
    served = [withUse];
    setUp(language, null, true);
    await mountChoice();
    expect(byTestId("meeting-route")?.textContent).toBe(`${sheet.here}${sheet.hereLine}`);
    expect(byTestId("meeting-route-other")).toBeNull();
    expect(byTestId("meeting-route-ways")).toBeNull();
    expect(byTestId("meeting-route-use-soniox")).toBeNull();
  });

  // protects=Local mode turned on while the list is open takes the list, its destinations and its Use buttons away; fails_when=the open list stays; no_claim=turning it off again.
  test("closes the list of services when Local mode comes on while it is open", async () => {
    served = [withUse];
    setUp(language, null, false);
    await mountChoice();
    await press(byTestId("meeting-route-other"));
    expect(byTestId("meeting-route-use-soniox")).not.toBeNull();
    await act(() => useAppStore.setState({ embedding: { localOnly: true } as never } as never));
    expect(byTestId("meeting-route-ways")).toBeNull();
    expect(byTestId("meeting-route-use-soniox")).toBeNull();
    expect(container.textContent).not.toContain("Soniox");
  });
});

describe.each(["en", "zh-CN"] as const)("Setting up a transcription service (%s)", (language) => {
  const said = SENDS[language];
  const sheet = SHEET[language];

  // protects=the set-up panel, with Local mode off, says where the audio goes and what an hour costs above its Use this; fails_when=the panel stops naming the destination; no_claim=saving the key.
  test("with Local mode off, says where the audio goes above Use this", async () => {
    setUp(language, null, false);
    await mount(createElement(SetUp, { service: soniox(), onDone: () => undefined }));
    expect(byTestId("transcription-set-up-consent")?.textContent).toBe(
      `${said.full}${sheet.price}`,
    );
  });

  // protects=the panel Settings › AI's Add an account or key… opens in Local mode, where Use this keeps the key but the core refuses the choice, says it is paused and never where the audio goes; fails_when=it says where the audio goes in Local mode; no_claim=that refusal, which the core makes and its own tests cover.
  test("with Local mode on, says it is paused and never where the audio goes", async () => {
    setUp(language, null, true);
    await mount(createElement(SetUp, { service: soniox(), onDone: () => undefined }));
    expect(byTestId("transcription-set-up-consent")?.textContent).toBe(
      `${said.paused}${sheet.price}`,
    );
    expect(container.textContent).not.toContain(said.full);
  });

  function SetUpPicker({ read }: { read: ServicesView }) {
    const set = useSetUp("route", read);
    return createElement(
      "div",
      { "data-offers": set.rows.offers.join(",") },
      createElement("button", {
        type: "button",
        "data-testid": "choose-soniox",
        onClick: () => set.rows.onChoose("soniox"),
      }),
      set.panel,
    );
  }

  // protects=the Meeting transcription picker in Settings › AI offers "Use Soniox…" and opens its panel only with Local mode off, and Local mode coming on closes the panel; fails_when=the picker offers a service in Local mode; no_claim=the picker's own options, which the smoke spec reads.
  test("Settings › AI's picker offers a service to set up only while Local mode is off", async () => {
    const keyless = soniox({ hasKey: false });
    setUp(language, null, false);
    await act(async () => root?.render(createElement(SetUpPicker, { read: ready(keyless) })));
    expect(container.querySelector("[data-offers]")?.getAttribute("data-offers")).toBe("soniox");
    await press(byTestId("choose-soniox"));
    expect(byTestId("transcription-set-up")).not.toBeNull();
    await act(() => useAppStore.setState({ embedding: { localOnly: true } as never } as never));
    expect(byTestId("transcription-set-up")).toBeNull();
    expect(container.querySelector("[data-offers]")?.getAttribute("data-offers")).toBe("");
  });
});
