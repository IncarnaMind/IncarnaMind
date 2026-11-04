import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from statsmodels.stats.outliers_influence import variance_inflation_factor

people = pd.read_csv(f"{DATA}/people.csv")
fit = smf.ols(
    "wage ~ education + experience + C(region, Treatment(reference='North'))", data=people
).fit(cov_type="HC1")


def vif_of_education(columns):
    design = np.column_stack([np.ones(len(people)), *columns])
    return float(variance_inflation_factor(design, 1))


dummies = [
    (people["region"] == name).astype(float).to_numpy() for name in ("South", "East", "West")
]
numeric = [people["education"].to_numpy(float), people["experience"].to_numpy(float)]

result = {
    "education": float(fit.params["education"]),
    "education_se": float(fit.bse["education"]),
    "experience": float(fit.params["experience"]),
    "experience_se": float(fit.bse["experience"]),
    "r_squared": float(fit.rsquared),
    "vif_education": [vif_of_education(numeric + dummies), vif_of_education(numeric)],
}
