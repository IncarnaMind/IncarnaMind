import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

subscribers = pd.read_csv(f"{DATA}/subscribers.csv")
cancelled = subscribers["cancelled"]
honest = subscribers.drop(columns=["customer", "cancelled", "cancellation_fee_charged"])
leaking = subscribers.drop(columns=["customer", "cancelled"])


def aucs(features):
    """Test AUCs over 20 random 25% splits, each by a logistic regression and by gradient boosting."""
    found = []
    for seed in range(20):
        x_train, x_test, y_train, y_test = train_test_split(
            features, cancelled, test_size=0.25, random_state=seed
        )
        for model in (
            make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
            HistGradientBoostingClassifier(random_state=seed),
        ):
            model.fit(x_train, y_train)
            found.append(roc_auc_score(y_test, model.predict_proba(x_test)[:, 1]))
    return found


honest_aucs = aucs(honest)
leaking_aucs = aucs(leaking)

result = {
    "honest_auc": float(np.mean(honest_aucs)),
    # Not scored: the range the tolerance covers, the leaking AUCs it must leave out, and the share
    # who cancelled.
    "honest_range": [float(min(honest_aucs)), float(max(honest_aucs))],
    "leaking_range": [float(min(leaking_aucs)), float(max(leaking_aucs))],
    "cancel_rate": float(cancelled.mean()),
}
