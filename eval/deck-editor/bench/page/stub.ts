// The app's core is not here: the modules the renderer imports find a bridge that answers nothing.
const nothing: unknown = new Proxy(() => undefined, {
  get: (_target, name) => (name === "then" ? undefined : nothing),
  apply: () => Promise.resolve(undefined),
});
Object.assign(window, { incarnamind: nothing, incarnamindFiles: nothing });
