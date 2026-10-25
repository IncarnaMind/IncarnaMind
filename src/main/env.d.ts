// Build-time configuration of the main process, read by electron-vite from the
// environment or a .env file when the app is built. Only `MAIN_VITE_`
// variables reach the main process.

interface ImportMetaEnv {
  /**
   * Where crash reports go: a Sentry DSN, set by the release workflow from a
   * repository secret. Unset or empty, the build can't send crash reports and
   * Settings doesn't offer them. Never written in the code.
   */
  readonly MAIN_VITE_SENTRY_DSN?: string;
  /**
   * The PostHog project usage data goes to: its project API key ("phc_…"),
   * set by the release workflow. Unset or empty, or without
   * `MAIN_VITE_POSTHOG_HOST`, the build sends no usage data, doesn't load the
   * SDK and doesn't ask. Never written in the code.
   */
  readonly MAIN_VITE_POSTHOG_KEY?: string;
  /**
   * The PostHog host for that project, over https: PostHog's EU cloud or a
   * self-hosted one (see docs/privacy.md).
   */
  readonly MAIN_VITE_POSTHOG_HOST?: string;
  /**
   * "1" for a test build (for invited testers): usage data is on until the User turns
   * it off, as testers agree to when they join, and the first run says so.
   * Otherwise the first run asks, and it is off unless the User agrees.
   */
  readonly MAIN_VITE_TESTER_BUILD?: string;
}

// A file's text, as Vite imports it with "?raw": the analysis helper, hashed into each run's record.
declare module "*?raw" {
  const text: string;
  export default text;
}
