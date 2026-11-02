import pandas as pd
from scipy.optimize import brentq

given = pd.read_csv(f"{DATA}/inputs.csv").set_index("name")["value"].to_dict()


def model(price):
    """The Model sheet's own formulas, B9:B14, for a unit price in B3."""
    revenue = given["Units sold"] * price
    profit = (
        revenue
        - given["Units sold"] * given["Variable cost per unit"]
        - revenue * given["Commission, share of revenue"]
        - given["Fixed costs"]
    )
    return revenue, profit, profit / revenue


price = brentq(lambda each: model(each)[2] - 0.2, 1, 1000, xtol=1e-12)
revenue, profit, margin = model(price)
assert abs(margin - 0.2) < 1e-12

result = {
    "margin_now": model(given["Unit price"])[2],
    "price": price,
    "profit_at_price": profit,
    "revenue_at_price": revenue,
}
