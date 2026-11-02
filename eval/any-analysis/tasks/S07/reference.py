import warnings

import numpy as np
import pandas as pd
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.forecasting.stl import STLForecast
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.statespace.sarimax import SARIMAX

warnings.filterwarnings("ignore")

sales = pd.read_csv(f"{DATA}/sales.csv")
series = pd.Series(
    sales["sales"].to_numpy(float), index=pd.period_range("2019-01", periods=len(sales), freq="M")
)
train, test = series[:-12], series[-12:]


def mape(forecast):
    actual = test.to_numpy()
    return float(np.mean(np.abs(actual - np.asarray(forecast)) / actual))


def log_linear(history, horizon):
    """A log-linear trend with a dummy per month."""
    steps = np.arange(len(history) + horizon)
    design = np.column_stack(
        [np.ones(len(steps)), steps] + [(steps % 12 == month).astype(float) for month in range(1, 12)]
    )
    fit = np.linalg.lstsq(design[: len(history)], np.log(history.to_numpy()), rcond=None)[0]
    return np.exp(design[len(history) :] @ fit)


def forecasts(history, horizon=12):
    """Models whose season grows with the level, as this one's does; additive seasons are left out."""
    seasonal = {"seasonal": "mul", "seasonal_periods": 12}
    return {
        "holt_winters": ExponentialSmoothing(history, trend="add", **seasonal).fit().forecast(horizon),
        "holt_winters_damped": ExponentialSmoothing(
            history, trend="add", damped_trend=True, **seasonal
        )
        .fit()
        .forecast(horizon),
        "holt_winters_multiplicative_trend": ExponentialSmoothing(history, trend="mul", **seasonal)
        .fit()
        .forecast(horizon),
        "airline_on_logs": np.exp(
            SARIMAX(np.log(history), order=(0, 1, 1), seasonal_order=(0, 1, 1, 12))
            .fit(disp=False)
            .forecast(horizon)
        ),
        "sarima": SARIMAX(history, order=(1, 1, 1), seasonal_order=(0, 1, 1, 12))
        .fit(disp=False)
        .forecast(horizon),
        "stl_arima": STLForecast(
            history, ARIMA, model_kwargs={"order": (1, 1, 0), "trend": "t"}, period=12
        )
        .fit()
        .forecast(horizon),
        "log_linear_trend": log_linear(history, horizon),
    }


held_out = {name: mape(forecast) for name, forecast in forecasts(train).items()}
next_year = {name: float(np.sum(forecast)) for name, forecast in forecasts(series).items()}
season = seasonal_decompose(series, model="multiplicative", period=12).seasonal[:12].to_numpy()

result = {
    "naive_mape": mape(train[-12:].to_numpy()),
    "model_mape": list(held_out.values()),
    "forecast_total": list(next_year.values()),
    # Not scored: the month the season peaks in, from 1.
    "peak_month": int(np.argmax(season) + 1),
}
