import numpy as np
import pandas as pd

prices = pd.read_csv(f"{DATA}/prices.csv").pivot(index="date", columns="asset", values="close")
risk_free = float(pd.read_csv(f"{DATA}/parameters.csv").set_index("name")["value"]["risk_free"])
returns = prices.pct_change().dropna()


def fund(name):
    closes = prices[name].to_numpy(float)
    years = len(returns) / 252
    annual = (closes[-1] / closes[0]) ** (1 / years) - 1
    volatility = returns[name].std(ddof=1) * np.sqrt(252)
    drawdown = 1 - closes / np.maximum.accumulate(closes)
    return {
        "key": name,
        "annual_return": float(annual),
        "volatility": float(volatility),
        "sharpe": float((annual - risk_free) / volatility),
        "max_drawdown": float(drawdown.max()),
    }


correlation = returns.corr()

result = {
    "funds": [fund(name) for name in ("Halvard", "Merrow", "Quinlan")],
    "correlation_equity_bond": float(correlation.loc["Halvard", "Merrow"]),
    "correlation_equity_gold": float(correlation.loc["Halvard", "Quinlan"]),
    "correlation_bond_gold": float(correlation.loc["Merrow", "Quinlan"]),
    # The Sharpe ratio from the mean daily return instead, for checking the definitions stay apart.
    "sharpe_arithmetic": [
        float((returns[name].mean() * 252 - risk_free) / (returns[name].std(ddof=1) * np.sqrt(252)))
        for name in ("Halvard", "Merrow", "Quinlan")
    ],
}
