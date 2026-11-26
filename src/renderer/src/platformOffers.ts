/** Whether this is a Mac: the menu bar, where Windows and Linux have the tray. */
export const onMac = () => /Mac/.test(navigator.platform);

/**
 * Whether setting up Meetings offers what the offers to take notes need: not on Windows, where
 * calls can't be noticed until its watcher ships (#2843).
 */
export const offersCanTurnOn = () => !/Win/.test(navigator.platform);
