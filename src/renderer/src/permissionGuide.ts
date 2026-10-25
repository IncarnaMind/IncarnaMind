import { useEffect, useState } from "react";
import type { PermissionGuideState } from "../../shared/permissionGuide";
import { files } from "./core";

/**
 * The guide's steps where they show in this window, as text, because the screen has no room
 * beside System Settings (#1105): the guide's state while it is for this window, else null.
 */
export function useGuideInPlace(): PermissionGuideState | null {
  const [guide, setGuide] = useState<PermissionGuideState | null>(null);
  useEffect(() => files.onPermissionGuide(setGuide), []);
  return guide?.placement === "inline" ? guide : null;
}
