# Usage data only with consent, through PostHog in the main process

IncarnaMind sends anonymous usage data, such as "a Question was asked with a local model", only while the User agrees (#187). The alpha needs to show which features people use and where they get stuck, and asking testers doesn't scale to that. The events never hold the User's files or anything they wrote.

- **Consent.** A release build asks once, after the first Answer to a Question of the User's own, in a card in the sidebar with an example of what is sent; the default is no. A test build (for invited testers, `MAIN_VITE_TESTER_BUILD=1`) sends until the User says no, because testers agree to it when they join; its first run says so, in a notice in the same place, with the switch. The choice lives in Settings → Privacy. Local mode turns usage data off. Turning it off stops sending at once and drops the queue.
- **One catalog.** Every event and field is declared in `src/core/usageEvents.ts`, and listed for people in `docs/privacy.md`. A field is a value from a closed list, a count or a flag: no field can hold free text. The core checks each event against the catalog before it leaves. A guard test keeps every other analytics package out of the dependency tree, and keeps the PostHog SDK out of every file but the sender.
- **PostHog, in the main process.** The official Node SDK, `posthog-node`, runs in the main process. The core decides what to send and when, and the window's own events reach it over IPC, so the renderer never talks to the network. The project key and host come from the build (`MAIN_VITE_POSTHOG_KEY`, `MAIN_VITE_POSTHOG_HOST`). Without them nothing is sent or asked, and the SDK isn't loaded.
- **Nothing identifies the User.** Events carry a random install ID, which the User can reset. No person profiles are made, GeoIP is off, and `$ip` is a placeholder. A failed send is dropped: nothing is retried, logged or written to disk.

## Considered options

- **Keep collecting nothing.** Rejected for the alpha: what testers do is what decides the next stage.
- **posthog-js in the renderer.** Rejected. It brings autocapture, session replay, surveys and feature flags, which would all have to be turned off and kept off. It would also give the window network access, which nothing else in it has.
- **Our own endpoint** (#164, planned for the onboarding picks). Not built: anything the first run would ask, such as which example was opened (`example_opened`, #123), is a usage event under the same consent, so no second endpoint is needed.
- **Our own HTTP sender to PostHog's API.** Rejected in favour of the official SDK, which is open source (MIT) and maintained with the API.

## Consequences

- `posthog-node` is a devDependency, bundled into a chunk that loads only while usage data is on, as for Sentry. The installers don't carry its `node_modules`.
- `$ip: null` doesn't stop PostHog storing the address: its ingestion fills in a missing or null `$ip` from the request. The sender sends `0.0.0.0` instead, and the project should turn on "Discard client IP data" too. That is the default for organisations in PostHog's EU cloud.
- Usage data is per device, in device settings: the choice, whether the first run has asked, and the install ID. It isn't synced (ADR-0003).
- A new event or field is a change to the catalog and to `docs/privacy.md` (a test checks that they match), and the pull request that adds it lists it for review. The mobile app will use the same event names.

## Amendment: the first run's picks (#3296)

The first run asks what the User works on, and the picks are worth having from every build, not only from testers. So the one event `work_picked` (a flag per kind of work, nothing else) has a consent of its own: in a release build, the User's press of "Send and continue" on that step is their yes for this event alone. It is sent once, even while usage data is off, by a client of its own that is closed once the event is sent, so the SDK's chunk loads for it too; it doesn't turn usage data on, and the usage data card still asks later as above. "Continue without sending" and Skip send nothing, and nothing is sent in Local mode or from a build without an analytics project. While usage data is on (a test build, until the tester says no), the event goes with the rest. The rule lives in one function, `sendWorkPicked` in `src/core/usageData.ts`, so it changes in one place.
