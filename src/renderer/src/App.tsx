import { lazy, Suspense, useEffect } from "react";
import { showAppearance } from "./appearance";
import { AppShell } from "./components/AppShell";
import { ProblemMark } from "./components/ProblemLine";
import { useLanguage, useT } from "./i18n";
import { setMotionPreference } from "./motion";
import { useAppStore } from "./store";

let interactiveServices: Promise<void> | null = null;
function loadInteractiveServices(): Promise<void> {
  if (!interactiveServices) {
    const loads: Promise<unknown>[] = [import("./commands/app")];
    if (new URLSearchParams(window.location.search).has("testHooks")) {
      loads.push(import("./viewerControls").then((module) => module.installTestHooks()));
    }
    interactiveServices = Promise.all(loads)
      .then(() => undefined)
      .catch((error) => {
        interactiveServices = null;
        throw error;
      });
  }
  return interactiveServices;
}

const SetupPage = lazy(async () => {
  const [, setupPage] = await Promise.all([
    loadInteractiveServices(),
    import("./components/firstRun/SetupPage"),
  ]);
  return { default: setupPage.SetupPage };
});
const Workspace = lazy(async () => {
  const [, , , workspace] = await Promise.all([
    loadInteractiveServices(),
    import("./windowMemory").then((module) => module.installWindowMemory()),
    import("./writtenChecks").then((module) => module.installWrittenChecks()),
    import("./Workspace"),
  ]);
  return { default: workspace.Workspace };
});

export function App() {
  const status = useAppStore((state) => state.status);
  const setup = useAppStore((state) => state.setup);
  const load = useAppStore((state) => state.load);
  const language = useLanguage();
  const t = useT();

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // How the window moves: the User's choice, kept on this device, once the settings have loaded.
  const motion = useAppStore((state) => state.settings?.device.motion ?? "system");
  useEffect(() => setMotionPreference(motion), [motion]);
  const appearance = useAppStore((state) => state.settings?.device.appearance ?? "system");
  useEffect(() => showAppearance(appearance), [appearance]);

  // The frame shows at once; the data fills it in as it arrives.
  if (status.kind === "loading") return <AppShell />;
  if (setup?.from === "work") {
    return (
      <Suspense fallback={<AppShell />}>
        <SetupPage
          workOrder={setup.workOrder}
          picksSent={setup.picksSent}
          initialStep={setup.step}
          initialWork={setup.work}
        />
      </Suspense>
    );
  }
  if (status.kind === "failed") {
    return (
      <p role="alert" className="p-6 text-ui text-ink">
        <ProblemMark />
        {t("error.load", { message: status.message })}
      </p>
    );
  }
  return (
    <Suspense fallback={<AppShell />}>
      <Workspace />
    </Suspense>
  );
}
