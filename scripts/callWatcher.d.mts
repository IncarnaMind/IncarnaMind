export const WATCHER_SOURCE: string;
export const WATCHER_NAME: string;
export const DEV_WATCHER: string;
export function buildCallWatcher(output?: string, platform?: NodeJS.Platform): Promise<boolean>;
