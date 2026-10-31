const SCENARIOS = [
  ["base", ["numpy", "pandas"]],
  ["scipy", ["numpy", "pandas", "scipy"]],
  ["statsmodels", ["numpy", "pandas", "statsmodels"]],
  ["scikit-learn", ["numpy", "pandas", "scikit-learn"]],
  ["matplotlib", ["numpy", "pandas", "matplotlib"]],
  ["all", ["numpy", "pandas", "scipy", "statsmodels", "scikit-learn", "matplotlib"]],
];
const REPEATS = Number(new URLSearchParams(location.search).get("repeats") ?? 3);
const runOnce = (name, packages, round) => new Promise((resolve) => {
  const started = performance.now();
  const worker = new Worker("pyprobe://app/page/worker.mjs", { type: "module" });
  const violations = [];
  worker.onmessage = ({ data }) => {
    worker.terminate();
    resolve({ scenario: name, round, wallMs: Math.round(performance.now() - started), violations, ...data });
  };
  worker.onerror = (e) => { worker.terminate(); resolve({ scenario: name, round, ok: false, error: `worker error ${e.message}` }); };
  worker.postMessage({ packages, scenario: name });
});
(async () => {
  for (let round = 1; round <= REPEATS; round++) {
    for (const [name, packages] of SCENARIOS) globalThis.probe.result(await runOnce(name, packages, round));
  }
  globalThis.probe.done();
})();
