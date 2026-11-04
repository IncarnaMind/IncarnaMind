import numpy as np
import pandas as pd

flows = pd.read_csv(f"{DATA}/cash_flows.csv").sort_values("year")["net"].to_numpy(float)
wacc = float(pd.read_csv(f"{DATA}/parameters.csv").set_index("name")["value"]["wacc"])

npv = float(sum(flow / (1 + wacc) ** year for year, flow in enumerate(flows)))

# Every IRR: the real roots x = 1 / (1 + r) > 0 of the flows' polynomial in x.
roots = np.roots(flows[::-1])
irrs = sorted(
    float(1 / root.real - 1) for root in roots if abs(root.imag) < 1e-9 and root.real > 0
)
assert len(irrs) == 2

cumulative = np.cumsum(flows)
year = int(np.argmax(cumulative >= 0))
payback = year - 1 + float(-cumulative[year - 1] / flows[year])

result = {
    "npv": npv,
    "irr": irrs,
    "payback": [payback, float(year)],
    "sign_changes": int(np.count_nonzero(np.diff(np.sign(flows)) != 0)),
}
