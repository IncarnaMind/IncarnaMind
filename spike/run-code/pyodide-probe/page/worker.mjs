import { loadPyodide } from "pyprobe://app/dist/pyodide.mjs";
const violations = [];
self.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
const WORK = {
  base: `import numpy as np, pandas as pd
df = pd.DataFrame({"x": np.arange(50000) % 97, "y": np.arange(50000) * 1.5})
out = float(df.groupby("x")["y"].sum().iloc[3])`,
  scipy: `from scipy import stats
import numpy as np
x = np.arange(200.0); y = 3 * x + (x % 7)
r = stats.linregress(x, y); t = stats.ttest_ind(x[:100], x[100:])
out = round(float(r.slope), 6)`,
  statsmodels: `import statsmodels.formula.api as smf, pandas as pd, numpy as np
df = pd.DataFrame({"x": np.arange(200.0)}); df["y"] = 2 * df.x + (df.x % 5)
out = round(float(smf.ols("y ~ x", data=df).fit().params["x"]), 6)`,
  "scikit-learn": `from sklearn.linear_model import LinearRegression
from sklearn.cluster import KMeans
import numpy as np
X = np.arange(400.0).reshape(-1, 2); y = X @ np.array([1.0, 2.0])
out = round(float(LinearRegression().fit(X, y).coef_[1]), 6)
KMeans(n_clusters=3, n_init=3, random_state=0).fit(X)`,
  matplotlib: `import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt, io
fig, ax = plt.subplots(); ax.bar(["a", "b", "c"], [3, 1, 2]); ax.set_title("营收 by region")
buf = io.BytesIO(); fig.savefig(buf, format="png"); out = len(buf.getvalue())`,
};
self.onmessage = async ({ data }) => {
  const t = {}; let mark = performance.now();
  const lap = (k) => { const now = performance.now(); t[k] = Math.round(now - mark); mark = now; };
  try {
    const py = await loadPyodide({ indexURL: "pyprobe://app/dist/", lockFileURL: "pyprobe://app/dist/pyodide-lock.json",
      packageBaseUrl: "pyprobe://app/dist/", fullStdLib: false, stdout: () => {}, stderr: () => {} });
    lap("coreMs");
    await py.loadPackage(data.packages, { messageCallback: () => {}, errorCallback: (m) => violations.push(`load: ${m}`) });
    lap("loadPackageMs");
    const names = { "scikit-learn": "sklearn", matplotlib: "matplotlib.pyplot" };
    await py.runPythonAsync(data.packages.map((p) => `import ${names[p] ?? p}`).join("\n"));
    lap("importMs");
    const results = {};
    const work = data.scenario === "all" ? ["base", "scipy", "statsmodels", "scikit-learn", "matplotlib"] : ["base", data.scenario].filter((v, i, a) => a.indexOf(v) === i);
    for (const w of work) { await py.runPythonAsync(WORK[w]); results[w] = py.globals.get("out"); }
    lap("workMs");
    self.postMessage({ ok: true, ...t, results, violations });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e?.message ?? e).split("\n").slice(-4).join(" | "), ...t, violations });
  }
};
