import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.model_selection import train_test_split

jobs = pd.read_csv(f"{DATA}/jobs.csv")
features = jobs.drop(columns="cost")
cost = jobs["cost"]

# The question fixes the share held out, not the seed or the model: each result is its mean over
# 10 random splits, each fitted by both of scikit-learn's boosting models with their defaults.
scores, labour, parts = [], [], []
for seed in range(10):
    x_train, x_test, y_train, y_test = train_test_split(
        features, cost, test_size=0.25, random_state=seed
    )
    for model in (
        GradientBoostingRegressor(random_state=seed),
        HistGradientBoostingRegressor(random_state=seed),
    ):
        model.fit(x_train, y_train)
        scores.append(model.score(x_test, y_test))
        drops = permutation_importance(model, x_test, y_test, n_repeats=10, random_state=seed)
        importance = pd.Series(drops.importances_mean, index=features.columns)
        labour.append(importance["labour"])
        parts.append(importance["parts"])

result = {
    "r_squared": float(np.mean(scores)),
    "labour_importance": float(np.mean(labour)),
    "parts_importance": float(np.mean(parts)),
    # Not scored: the ranges the tolerances cover.
    "r_squared_range": [float(min(scores)), float(max(scores))],
    "labour_range": [float(min(labour)), float(max(labour))],
    "parts_range": [float(min(parts)), float(max(parts))],
}
