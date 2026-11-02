import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

readings = pd.read_csv(f"{DATA}/readings.csv").drop(columns="Reading")
pca = PCA().fit(StandardScaler().fit_transform(readings))
shares = pca.explained_variance_ratio_
weights = pd.Series(pca.components_[0], index=readings.columns)
top = weights.reindex(weights.abs().sort_values(ascending=False).index)[:5]

result = {
    "pc1_share": float(shares[0]),
    "pc2_share": float(shares[1]),
    "components_80": int(np.searchsorted(np.cumsum(shares), 0.8) + 1),
    "pc1_top": [{"key": name, "weight": float(value)} for name, value in top.items()],
    # Not scored: the shares the 80% count rests on, and the sixth weight, which the top five clear.
    "cumulative": [float(each) for each in np.cumsum(shares)[:4]],
    "sixth_weight": float(weights.abs().sort_values(ascending=False).iloc[5]),
}
