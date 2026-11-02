import pandas as pd

statements = pd.read_csv(f"{DATA}/statements.csv")
line = statements.set_index(["statement", "line", "year"])["value"]
years = sorted(statements.loc[statements["statement"] == "income", "year"].unique())


def value(statement, name, year):
    return float(line[(statement, name, year)])


checks = {"balance": {}, "cash": {}, "retained": {}}
for year in years:
    checks["balance"][year] = value("balance", "Total assets", year) - value(
        "balance", "Total liabilities and equity", year
    )
    checks["cash"][year] = value("cash", "Cash at end of year", year) - value("balance", "Cash", year)
    # Dividends paid are negative on the cash flow statement.
    rolled = (
        value("balance", "Retained earnings", year - 1)
        + value("income", "Net income", year)
        + value("cash", "Dividends paid", year)
    )
    checks["retained"][year] = value("balance", "Retained earnings", year) - rolled

failing = {name: {year: diff for year, diff in by_year.items() if diff != 0} for name, by_year in checks.items()}
assert all(len(each) == 1 for each in failing.values())

result = {f"{name}_difference": next(iter(each.values())) for name, each in failing.items()}
# The failing year of each check: balance, cash, retained.
result["failing_years"] = [int(next(iter(each))) for each in failing.values()]
