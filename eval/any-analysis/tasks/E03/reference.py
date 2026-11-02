import pandas as pd

given = pd.read_csv(f"{DATA}/inputs.csv").set_index("name")["value"].to_dict()
workbook = float(pd.read_csv(f"{DATA}/workbook.csv").set_index("name")["value"]["enterprise_value"])


def enterprise_value(terminal, wacc):
    """The DCF sheet's own formulas, five years and a Gordon terminal value, end-of-year discounting."""
    revenue = given["revenue"]
    total = 0.0
    for year in range(1, 6):
        last, revenue = revenue, revenue * (1 + given["growth"])
        ebit = revenue * given["margin"] - revenue * given["depreciation"]
        flow = (
            ebit * (1 - given["tax"])
            + revenue * given["depreciation"]
            - revenue * given["capex"]
            - (revenue - last) * given["workingCapital"]
        )
        factor = 1 / (1 + wacc) ** year
        total += flow * factor
    return total + flow * (1 + terminal) / (wacc - terminal) * factor


grid = {(g, w): enterprise_value(g / 100, w / 100) for g in range(0, 7) for w in range(7, 13)}
base = enterprise_value(given["terminal"], given["wacc"])
assert abs(base - workbook) <= 1e-9 * abs(workbook)

result = {
    "value_g0_w7": grid[(0, 7)],
    "value_g6_w7": grid[(6, 7)],
    "value_g0_w12": grid[(0, 12)],
    "value_g6_w12": grid[(6, 12)],
    "base_case": workbook,
    "grid": [{"key": f"{g}%", **{f"wacc_{w}": grid[(g, w)] for w in range(7, 13)}} for g in range(0, 7)],
}
