function createVisibilitySampler(BrowserWindow, record) {
  const visibility = new Map();
  return () => {
    const seen = new Set();
    for (const window of BrowserWindow.getAllWindows()) {
      const windowId = window.id;
      const visible = window.isVisible();
      seen.add(windowId);
      if (visibility.get(windowId) !== visible) {
        visibility.set(windowId, visible);
        record("window-visibility", { windowId, visible });
      }
    }
    for (const windowId of visibility.keys()) {
      if (!seen.has(windowId) && visibility.get(windowId)) {
        visibility.set(windowId, false);
        record("window-visibility", { windowId, visible: false });
      }
    }
  };
}

module.exports = { createVisibilitySampler };
