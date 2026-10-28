import { useCallback, useEffect, useState } from "react";
import { core } from "../core";
import { showFileLabelKey } from "../fileInfo";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { ProblemLine } from "./ProblemLine";

const reportError = (failure: unknown) => useAppStore.getState().reportError(failure);

/**
 * Tells the User where Microsoft's model runtime keeps the usage data earlier versions added to
 * (#2145), for as long as the folder is there, with a way to see it. It is theirs to delete.
 */
export function ModelRuntimeFolderLine() {
  const t = useT();
  const [path, setPath] = useState<string | null>(null);
  const refresh = useCallback(() => {
    core.getModelRuntimeFolder().then(setPath, reportError);
  }, []);
  useEffect(() => {
    refresh();
    // The User deletes the folder in the file manager, then comes back.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  if (path === null) return null;
  return (
    <ProblemLine
      role="status"
      testId="model-runtime-folder"
      className="mt-2"
      title={path}
      action={{
        label: t(showFileLabelKey(navigator.platform)),
        testId: "model-runtime-folder-show",
        onClick: () => void core.showModelRuntimeFolder().then(refresh, reportError),
      }}
    >
      {t("privacy.runtimeFolder")}
    </ProblemLine>
  );
}
