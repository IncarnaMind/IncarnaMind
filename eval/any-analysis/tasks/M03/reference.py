import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import adjusted_rand_score, silhouette_score
from sklearn.preprocessing import StandardScaler

customers = pd.read_csv(f"{DATA}/customers.csv")
columns = ["recency", "frequency", "spend"]

# The question leaves the scaling to the Answer: the silhouette picks the same k raw, standardised
# and on logs, and the segments are the same customers under each.
scalings = {
    "raw": customers[columns].to_numpy(float),
    "standardised": StandardScaler().fit_transform(customers[columns]),
    "log": StandardScaler().fit_transform(np.log1p(customers[columns])),
}
best = {}
labels = {}
for name, points in scalings.items():
    scores = {}
    for k in range(2, 9):
        fit = KMeans(n_clusters=k, n_init=10, random_state=0).fit(points)
        scores[k] = silhouette_score(points, fit.labels_)
    best[name] = max(scores, key=scores.get)
    labels[name] = KMeans(n_clusters=best[name], n_init=10, random_state=0).fit_predict(points)

points = scalings["standardised"]
chosen = labels["standardised"]
stability = [
    adjusted_rand_score(
        chosen, KMeans(n_clusters=best["standardised"], n_init=10, random_state=seed).fit_predict(points)
    )
    for seed in range(1, 6)
]

profiles = (
    customers.assign(segment=chosen)
    .groupby("segment")
    .agg(customers=("spend", "size"), mean_spend=("spend", "mean"))
    .sort_values("mean_spend", ascending=False)
)

result = {
    "k": int(best["standardised"]),
    "segments": [
        {"key": f"S{rank + 1}", "customers": int(row.customers), "mean_spend": float(row.mean_spend)}
        for rank, row in enumerate(profiles.itertuples())
    ],
    # Not scored: k under each scaling, how far the other scalings' segments agree with these,
    # and the agreement over 5 more seeds.
    "k_by_scaling": [int(best[name]) for name in scalings],
    "agreement_by_scaling": [float(adjusted_rand_score(chosen, labels[name])) for name in scalings],
    "stability": [float(each) for each in stability],
}
