import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

customers = pd.read_csv(f"{DATA}/customers.csv")
features = customers.drop(columns="churned")
churned = customers["churned"]

# The question fixes the share held out, not the seed: the AUC is the mean over many seeds.
aucs = []
for seed in range(40):
    x_train, x_test, y_train, y_test = train_test_split(
        features, churned, test_size=0.25, random_state=seed
    )
    model = LogisticRegression(max_iter=2000).fit(x_train, y_train)
    aucs.append(roc_auc_score(y_test, model.predict_proba(x_test)[:, 1]))

coefficients = pd.Series(
    LogisticRegression(max_iter=2000).fit(features, churned).coef_[0], index=features.columns
)
top = coefficients.reindex(coefficients.abs().sort_values(ascending=False).index)[:3]

result = {
    "churn_rate": float(churned.mean()),
    "auc": float(np.mean(aucs)),
    "auc_range": [float(min(aucs)), float(max(aucs))],
    "top_columns": [{"key": name, "coefficient": float(value)} for name, value in top.items()],
}
