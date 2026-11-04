import pandas as pd

balances = pd.read_csv(f"{DATA}/trial_balances.csv", dtype={"account": str})
rates = pd.read_csv(f"{DATA}/rates.csv").set_index("currency")

pl = balances[balances["line"] != "Balance sheet"].copy()
pl["income"] = pl["credit"] - pl["debit"]


def translated(rate):
    return pl["income"] * pl["currency"].map(rates[rate])


pl["usd"] = translated("average")
intercompany = pl["name"].str.contains("intercompany")
fee_income = pl.loc[intercompany & (pl["line"] == "Revenue"), "usd"].sum()
fee_expense = -pl.loc[intercompany & (pl["line"] != "Revenue"), "usd"].sum()
assert abs(fee_income - fee_expense) < 0.005

revenue = pl.loc[(pl["line"] == "Revenue") & ~intercompany, "usd"].sum()

result = {
    "revenue": float(revenue),
    "profit": float(pl["usd"].sum()),
    "elimination": float(fee_income),
    "eur_rate": float(rates.loc["EUR", "average"]),
    "gbp_rate": float(rates.loc["GBP", "average"]),
    # What the wrong choices give, for checking they stay apart from the right ones.
    "revenue_not_eliminated": float(pl.loc[pl["line"] == "Revenue", "usd"].sum()),
    "profit_at_closing": float(translated("closing").sum()),
}
