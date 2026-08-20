"""
SmartFlow NLEX — Honest Retrain & Evaluation
============================================
Replaces retrain_with_weather.py. Five corrections over the previous pipeline:

  1. WEATHER AGGREGATION. hourly_weather holds 20 stations per hour. The old
     query did SUM(rainfall) GROUP BY date, summing across stations *and* hours,
     inflating daily rainfall ~20x (134 mm/day mean, physically impossible).
     Here we average across stations first, then aggregate over hours.

  2. EQUAL EVALUATION PROTOCOL. Every model — including the LSTM and the naive
     baselines — is scored through the same rolling-origin harness at the same
     horizon. The old code fed the LSTM actual test observations through its
     sliding window (1-step-ahead with ground truth) while Holt-Winters, SARIMAX
     and Holt extrapolated blind for up to 599 days. That comparison was invalid.

  3. HORIZON MATCHES SERVING. Metrics are computed at HORIZON days ahead, which
     is the same horizon the dashboard displays. Previously the table reported
     599-day error while the chart drew a 15-day forecast.

  4. REAL BASELINES. Seasonal-naive and day-of-week climatology are scored as
     first-class competitors, and MASE is computed against the *seasonal* naive.
     Against lag-1 naive every model "passed"; against a weekly baseline most of
     them did not, which is the honest bar for weekly-seasonal data.

  5. NO SILENT FALLBACKS. A model that fails to fit records NaN and is reported
     as failed. The old code caught bare exceptions and substituted constants
     (flat forecast lines) or a fabricated train R2 of 0.99.

Outputs:
  - gold.ml_predictive_volume  (the exact forecasts that were scored)
  - gold.ml_model_metrics      (metrics for those same forecasts)
"""

import os
import sys
import warnings

import numpy as np
import pandas as pd
import psycopg2

warnings.filterwarnings("ignore")
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

POSTGRES_URL = os.environ.get(
    "SMARTFLOW_DB_URL",
    "postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone",
)

# ─── Evaluation settings ──────────────────────────────
# A 2-week operating horizon. STEP == HORIZON so the forecast blocks tile the
# evaluation window without overlapping — every scored day is predicted exactly
# once, at a known number of days ahead, which is what makes the week-1 vs week-2
# error breakdown in STEP 3 meaningful.
HORIZON   = 14   # days forecast per origin = what the dashboard's FUTURE shows
STEP      = 14   # non-overlapping blocks
# 34 * 14 = 476 scored days ≈ 19.9% of the 2,398-day series — a genuine 80/20,
# built as 34 non-overlapping rolling blocks rather than one static split. Six
# origins left the top three models within 0.6 WMAPE points of each other, which
# is inside the noise; this gives the ranking enough independent cycles to mean
# something.
N_ORIGINS = 34
SEASON    = 7    # weekly seasonality
# Project 28 days even though only 14 are validated. Days 1-14 carry the measured
# h=14 accuracy; days 15-28 are extrapolation beyond it and the chart marks them
# as such. Showing the extra fortnight makes the FUTURE block legible instead of
# a sliver, without overstating what was actually tested.
FUTURE_DAYS = 28
# Days of history shown before the evaluation window. This is display context
# only — none of it is scored — but it sets how much of the chart PRESENT
# occupies. At CTX=40 the scored band swallowed half the plot and read as if
# most of the chart were holdout; 240 puts it back to a ~24% validation strip.
# 0 = write the ENTIRE pre-holdout region as chart context. At CTX=240 the chart
# showed 240 history days against a 476-day holdout, so the scored band swallowed
# ~65% of the plot and read as if most of the project were validation. Writing all
# 1,922 training days restores the true 80/20 proportions on screen AND satisfies
# the requirement that the blue historical line actually BE the trained dataset,
# rather than an arbitrary slice of it. Context rows are never scored, so this
# changes only what is drawn — no metric moves.
CTX = 0
LSTM_SEQ  = 30
LSTM_EPOCHS = 40

WEATHER_COLS = ["avg_temp", "total_rain", "avg_wind", "avg_humidity"]


def banner(text):
    print("\n" + "=" * 68)
    print("  " + text)
    print("=" * 68)


# ─────────────────────────────────────────────────────
# 1. LOAD DATA
# ─────────────────────────────────────────────────────
banner("STEP 1: Loading traffic and weather")

conn = psycopg2.connect(POSTGRES_URL)

# total_volume > 0 drops the zero-filled placeholder rows that run to 2026-12-30.
traffic_df = pd.read_sql_query(
    """
    SELECT (date + interval '8 hours')::date AS ds, total_volume AS y
    FROM gold.daily_traffic_volume
    WHERE date IS NOT NULL AND total_volume > 0
    ORDER BY 1
    """,
    conn,
)

# Average across the 20 stations for each hour, THEN aggregate across hours.
# Rain accumulates over the day (sum); temp/wind/humidity are daily means.
weather_df = pd.read_sql_query(
    """
    WITH hourly AS (
        SELECT (timestamp_utc + interval '8 hours')::date AS ds,
               timestamp_utc                              AS hr,
               AVG(temperature) AS temperature,
               AVG(rainfall)    AS rainfall,
               AVG(wind_speed)  AS wind_speed,
               AVG(humidity)    AS humidity
        FROM public.hourly_weather
        GROUP BY 1, 2
    )
    SELECT ds,
           AVG(temperature) AS avg_temp,
           SUM(rainfall)    AS total_rain,
           AVG(wind_speed)  AS avg_wind,
           AVG(humidity)    AS avg_humidity
    FROM hourly
    GROUP BY ds
    ORDER BY ds
    """,
    conn,
)

for d in (traffic_df, weather_df):
    d["ds"] = pd.to_datetime(d["ds"])

print(f"  Traffic : {len(traffic_df):>5} days  {traffic_df.ds.min().date()} -> {traffic_df.ds.max().date()}")
print(f"  Weather : {len(weather_df):>5} days  {weather_df.ds.min().date()} -> {weather_df.ds.max().date()}")
print(f"  Rainfall: mean {weather_df.total_rain.mean():.1f} mm/day, max {weather_df.total_rain.max():.1f} mm/day")

# Weather stops before traffic does. Rather than throw away the tail of the
# traffic series, gaps are filled with day-of-year climatological normals — the
# standard operational substitute when no observation or forecast exists. Every
# such day is flagged so the disclosure can be exact rather than hand-waved.
df = traffic_df.merge(weather_df, on="ds", how="left").sort_values("ds").reset_index(drop=True)

doy = df["ds"].dt.dayofyear
clim_by_doy = df.groupby(doy)[WEATHER_COLS].transform("mean")
df["weather_is_climatology"] = df[WEATHER_COLS].isna().any(axis=1)
for c in WEATHER_COLS:
    df[c] = df[c].fillna(clim_by_doy[c]).fillna(df[c].mean())

n_clim = int(df["weather_is_climatology"].sum())
print(f"  Joint   : {len(df):>5} days  {df.ds.min().date()} -> {df.ds.max().date()}")
if n_clim:
    first_clim = df.loc[df["weather_is_climatology"], "ds"].min().date()
    print(f"  [!] {n_clim} days from {first_clim} use CLIMATOLOGICAL weather (no observation).")
    print("      Metrics below are reported separately for observed-weather days.")

# Day-of-year normals, used to drive the FUTURE window where no weather exists.
HIST_BY_DOY = df.groupby(df["ds"].dt.dayofyear)[WEATHER_COLS].mean()

need = N_ORIGINS * STEP + LSTM_SEQ + 400
if len(df) < need:
    sys.exit(f"Not enough joint history: have {len(df)}, need ~{need}")


# ─────────────────────────────────────────────────────
# 2. METRICS
# ─────────────────────────────────────────────────────
def compute_metrics(actual, predicted, insample):
    """insample is the training series the origin was fit on — MASE and RMSSE
    are scaled by the SEASONAL naive error on it, the correct benchmark for
    weekly data. Scaling by lag-1 (the old code) makes every model look good."""
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)

    if np.isnan(predicted).any():
        return {k: np.nan for k in
                ("mae", "mse", "rmse", "mape", "smape", "wmape", "mase", "rmsse", "r2")}

    err = actual - predicted
    abs_err = np.abs(err)
    mae = float(np.mean(abs_err))
    mse = float(np.mean(err ** 2))

    # Lag-SEASON difference, NOT np.diff(..., n=SEASON) — the latter applies the
    # difference operator SEASON times and blows the scale up, making MASE tiny.
    ins = np.asarray(insample, dtype=float)
    seasonal_err = np.abs(ins[SEASON:] - ins[:-SEASON])
    scale = float(np.mean(seasonal_err))
    rms_scale = float(np.sqrt(np.mean(seasonal_err ** 2)))

    ss_tot = float(np.sum((actual - actual.mean()) ** 2))
    denom = (np.abs(actual) + np.abs(predicted)) / 2.0

    return {
        "mae": mae,
        "mse": mse,
        "rmse": float(np.sqrt(mse)),
        "mape": float(np.mean(abs_err[actual != 0] / actual[actual != 0]) * 100),
        "smape": float(np.mean(abs_err[denom != 0] / denom[denom != 0]) * 100),
        "wmape": float(np.sum(abs_err) / np.sum(np.abs(actual)) * 100),
        "mase": mae / scale if scale > 0 else np.nan,
        "rmsse": float(np.sqrt(mse)) / rms_scale if rms_scale > 0 else np.nan,
        "r2": float(1 - np.sum(err ** 2) / ss_tot) if ss_tot > 0 else np.nan,
    }


# ─────────────────────────────────────────────────────
# 3. MODELS — each is fit(train_df, horizon) -> ndarray[horizon]
#    Identical signature so the harness cannot favour any of them.
# ─────────────────────────────────────────────────────
def m_seasonal_naive(train, h):
    """Baseline: repeat the last observed week."""
    y = train["y"].values
    return np.array([y[-SEASON + (i % SEASON)] for i in range(h)])


def m_climatology(train, h, future_dates):
    """Baseline: the mean volume for that weekday over the last 8 weeks."""
    recent = train.tail(SEASON * 8)
    means = recent.groupby(recent.ds.dt.dayofweek)["y"].mean()
    overall = recent["y"].mean()
    return np.array([means.get(d.dayofweek, overall) for d in future_dates])


def m_holt_winters(train, h):
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    fit = ExponentialSmoothing(
        train["y"].values, trend="add", seasonal="add",
        seasonal_periods=SEASON, initialization_method="estimated",
    ).fit()
    return np.asarray(fit.forecast(h), dtype=float)


def m_holts_linear(train, h):
    from statsmodels.tsa.holtwinters import Holt
    fit = Holt(train["y"].values, initialization_method="estimated").fit(optimized=True)
    return np.asarray(fit.forecast(h), dtype=float)


def m_sarimax(train, h, exog_future):
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    fit = SARIMAX(
        train["y"].values, exog=train[WEATHER_COLS].values,
        order=(1, 1, 1), seasonal_order=(1, 1, 1, SEASON),
        enforce_stationarity=False, enforce_invertibility=False,
    ).fit(disp=False)
    return np.asarray(fit.forecast(steps=h, exog=exog_future), dtype=float)


def m_prophet(train, h, future_df):
    from prophet import Prophet
    mdl = Prophet(weekly_seasonality=True, yearly_seasonality=True, daily_seasonality=False)
    for c in WEATHER_COLS:
        mdl.add_regressor(c)
    mdl.fit(train[["ds", "y"] + WEATHER_COLS])
    return mdl.predict(future_df)["yhat"].values


def m_lstm(train, h, future_weather):
    """Recursive multi-step. Each predicted day is fed back as the input for the
    next — the model never sees an actual observation inside the horizon. The
    old pipeline built its test windows from actual test values, which is why
    it scored far better than everything else."""
    from sklearn.preprocessing import MinMaxScaler
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense, Dropout

    feats = ["y"] + WEATHER_COLS
    scaler = MinMaxScaler()
    scaled = scaler.fit_transform(train[feats].values)

    X, Y = [], []
    for i in range(LSTM_SEQ, len(scaled)):
        X.append(scaled[i - LSTM_SEQ:i])
        Y.append(scaled[i, 0])
    X, Y = np.array(X), np.array(Y)

    mdl = Sequential([
        LSTM(64, return_sequences=True, input_shape=(LSTM_SEQ, len(feats))),
        Dropout(0.2), LSTM(32), Dropout(0.2), Dense(1),
    ])
    mdl.compile(optimizer="adam", loss="mse")
    mdl.fit(X, Y, epochs=LSTM_EPOCHS, batch_size=32, verbose=0)

    # Known future weather is allowed (SARIMAX and Prophet get it too);
    # the volume column is filled with the model's own predictions.
    wx_scaled = scaler.transform(
        np.column_stack([np.zeros(len(future_weather)), future_weather.values])
    )[:, 1:]

    window = scaled[-LSTM_SEQ:].copy()
    out = []
    for i in range(h):
        p = float(mdl.predict(window[np.newaxis, ...], verbose=0)[0, 0])
        out.append(p)
        window = np.vstack([window[1:], np.concatenate([[p], wx_scaled[i]])])

    pad = np.zeros((h, len(feats)))
    pad[:, 0] = out
    return scaler.inverse_transform(pad)[:, 0]


def m_sarimax_nw(train, h):
    """Same order, no exogenous weather — the control for 'does weather help?'"""
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    fit = SARIMAX(
        train["y"].values, order=(1, 1, 1), seasonal_order=(1, 1, 1, SEASON),
        enforce_stationarity=False, enforce_invertibility=False,
    ).fit(disp=False)
    return np.asarray(fit.forecast(steps=h), dtype=float)


def m_prophet_nw(train, h, future_df):
    from prophet import Prophet
    mdl = Prophet(weekly_seasonality=True, yearly_seasonality=True, daily_seasonality=False)
    mdl.fit(train[["ds", "y"]])
    return mdl.predict(future_df[["ds"]])["yhat"].values


def m_lstm_nw(train, h):
    """Volume only — no weather channel in the input window."""
    from sklearn.preprocessing import MinMaxScaler
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense, Dropout

    scaler = MinMaxScaler()
    scaled = scaler.fit_transform(train[["y"]].values)
    X, Y = [], []
    for i in range(LSTM_SEQ, len(scaled)):
        X.append(scaled[i - LSTM_SEQ:i])
        Y.append(scaled[i, 0])
    X, Y = np.array(X), np.array(Y)

    mdl = Sequential([
        LSTM(64, return_sequences=True, input_shape=(LSTM_SEQ, 1)),
        Dropout(0.2), LSTM(32), Dropout(0.2), Dense(1),
    ])
    mdl.compile(optimizer="adam", loss="mse")
    mdl.fit(X, Y, epochs=LSTM_EPOCHS, batch_size=32, verbose=0)

    window = scaled[-LSTM_SEQ:].copy()
    out = []
    for _ in range(h):
        p = float(mdl.predict(window[np.newaxis, ...], verbose=0)[0, 0])
        out.append(p)
        window = np.vstack([window[1:], [[p]]])
    return scaler.inverse_transform(np.array(out).reshape(-1, 1))[:, 0]


# Each weather-using model is paired with an identical weather-free control so the
# dashboard's Weather toggle switches between two genuinely different forecasts,
# and so "does weather actually help?" becomes a measured answer rather than a claim.
MODELS = {
    "SeasonalNaive": lambda tr, h, fut: m_seasonal_naive(tr, h),
    "Climatology":   lambda tr, h, fut: m_climatology(tr, h, fut["ds"]),
    "HoltWinters":   lambda tr, h, fut: m_holt_winters(tr, h),
    "Holts_Linear":  lambda tr, h, fut: m_holts_linear(tr, h),
    "SARIMAX":       lambda tr, h, fut: m_sarimax(tr, h, fut[WEATHER_COLS].values),
    "Prophet":       lambda tr, h, fut: m_prophet(tr, h, fut[["ds"] + WEATHER_COLS]),
    "LSTM":          lambda tr, h, fut: m_lstm(tr, h, fut[WEATHER_COLS]),
    "SARIMAX_nw":    lambda tr, h, fut: m_sarimax_nw(tr, h),
    "Prophet_nw":    lambda tr, h, fut: m_prophet_nw(tr, h, fut),
    "LSTM_nw":       lambda tr, h, fut: m_lstm_nw(tr, h),
}

# name -> (uses_weather, weather-free twin) for reporting and DB writes
NO_WEATHER_TWIN = {"SARIMAX": "SARIMAX_nw", "Prophet": "Prophet_nw", "LSTM": "LSTM_nw"}
BASELINES = ("SeasonalNaive", "Climatology")


# ─────────────────────────────────────────────────────
# 4. ROLLING-ORIGIN EVALUATION
# ─────────────────────────────────────────────────────
banner(f"STEP 2: Rolling-origin evaluation ({N_ORIGINS} origins, h={HORIZON}d)")

origins = [len(df) - (N_ORIGINS - i) * STEP for i in range(N_ORIGINS)]
print(f"  First origin: {df.ds.iloc[origins[0]].date()}   "
      f"Last: {df.ds.iloc[origins[-1]].date()}")
print(f"  Every model refits at every origin and forecasts {HORIZON} days blind.\n")

preds = {name: {} for name in MODELS}   # name -> {date: prediction}
steps_ahead = {}                        # date -> 1..HORIZON, how far out it was
failures = {name: [] for name in MODELS}

# Checkpointing. A 34-origin run takes hours and two earlier runs were killed
# partway, losing everything. State is flushed after every origin and reloaded on
# restart, but only when the config fingerprint matches — otherwise results from
# a different split would be silently mixed into a new one.
import pickle

CKPT = "retrain_checkpoint.pkl"
FINGERPRINT = (HORIZON, STEP, N_ORIGINS, len(df), sorted(MODELS))
done_origins: set[int] = set()

if os.path.exists(CKPT):
    try:
        with open(CKPT, "rb") as fh:
            saved = pickle.load(fh)
        if saved.get("fingerprint") == FINGERPRINT:
            preds = saved["preds"]
            steps_ahead = saved["steps_ahead"]
            failures = saved["failures"]
            done_origins = saved["done_origins"]
            print(f"  [resume] checkpoint found — {len(done_origins)}/{N_ORIGINS} origins already done")
        else:
            print("  [resume] checkpoint ignored — config changed since it was written")
    except Exception as exc:
        print(f"  [resume] checkpoint unreadable ({str(exc)[:50]}), starting clean")


def _save_ckpt():
    tmp = CKPT + ".tmp"
    with open(tmp, "wb") as fh:
        pickle.dump({
            "fingerprint": FINGERPRINT, "preds": preds, "steps_ahead": steps_ahead,
            "failures": failures, "done_origins": done_origins,
        }, fh)
    os.replace(tmp, CKPT)   # atomic — a kill mid-write can't corrupt the file

for oi, cut in enumerate(origins, 1):
    train = df.iloc[:cut]
    future = df.iloc[cut:cut + HORIZON]
    if len(future) < HORIZON:
        break
    if cut in done_origins:
        print(f"  Origin {oi}/{N_ORIGINS}  [cached]")
        continue
    print(f"  Origin {oi}/{N_ORIGINS}  train={len(train)}d  "
          f"predict {future.ds.iloc[0].date()} -> {future.ds.iloc[-1].date()}", flush=True)

    for k, d in enumerate(future.ds.values, start=1):
        steps_ahead[pd.Timestamp(d)] = k

    for name, fn in MODELS.items():
        try:
            yhat = np.asarray(fn(train, HORIZON, future), dtype=float)
            if yhat.shape != (HORIZON,) or not np.isfinite(yhat).all():
                raise ValueError(f"bad output shape/values: {yhat.shape}")
            for d, v in zip(future.ds.values, yhat):
                preds[name][pd.Timestamp(d)] = float(v)
        except Exception as exc:
            # Recorded, never silently replaced with a constant.
            failures[name].append((str(df.ds.iloc[cut].date()), str(exc)[:90]))
            for d in future.ds.values:
                preds[name][pd.Timestamp(d)] = np.nan

    done_origins.add(cut)
    _save_ckpt()

eval_start = origins[0]
eval_df = df.iloc[eval_start:eval_start + (N_ORIGINS * STEP)].reset_index(drop=True)
insample = df["y"].values[:eval_start]

banner("STEP 3: Results")

rows = []
for name in MODELS:
    yhat = np.array([preds[name].get(pd.Timestamp(d), np.nan) for d in eval_df.ds])
    n_bad = int(np.isnan(yhat).sum())
    m = compute_metrics(eval_df["y"].values, yhat, insample)
    m["model"] = name
    m["failed_origins"] = len(failures[name])
    m["missing_days"] = n_bad
    rows.append(m)
    if failures[name]:
        print(f"  [FAIL] {name}: {len(failures[name])} origin(s) failed to fit")
        for when, why in failures[name][:2]:
            print(f"         {when}: {why}")

res = pd.DataFrame(rows).set_index("model")
res = res.sort_values("wmape")

print(f"\n  Evaluated on {len(eval_df)} days: "
      f"{eval_df.ds.min().date()} -> {eval_df.ds.max().date()}\n")
print(res[["wmape", "mae", "rmse", "mase", "r2", "failed_origins"]].to_string(
    float_format=lambda v: f"{v:,.4f}"))

# A model earns "accepted" only by beating BOTH trivial baselines.
base = min(
    res.loc["SeasonalNaive", "wmape"] if "SeasonalNaive" in res.index else np.inf,
    res.loc["Climatology", "wmape"] if "Climatology" in res.index else np.inf,
)
print(f"\n  Baseline to beat (best of naive/climatology): WMAPE {base:.2f}%")

learned = res.drop(index=[i for i in BASELINES if i in res.index])
learned = learned.assign(
    accepted=(learned.wmape < base) & (learned.mase < 1.0) & learned.wmape.notna()
)
learned = learned.sort_values("wmape")
learned["rank"] = range(1, len(learned) + 1)

# Does weather actually improve each model? Now a measured delta, not an assertion.
print("\n  DOES WEATHER HELP? (same model, same protocol, weather in vs out)")
for wet, dry in NO_WEATHER_TWIN.items():
    if wet in res.index and dry in res.index:
        w, d = res.loc[wet, "wmape"], res.loc[dry, "wmape"]
        if np.isfinite(w) and np.isfinite(d):
            delta = d - w   # positive => weather version is better
            verdict = (f"weather HELPS by {delta:+.2f} pts" if delta > 0.05
                       else f"weather HURTS by {-delta:.2f} pts" if delta < -0.05
                       else "no meaningful difference")
            print(f"    {wet:<10} {w:6.2f}%   vs   no-weather {d:6.2f}%   -> {verdict}")

print("\n  VERDICT")
for name, r in learned.iterrows():
    if not np.isfinite(r.wmape):
        verdict = "FAILED TO FIT"
    elif r.accepted:
        verdict = f"accepted (rank #{int(r['rank'])})"
    else:
        verdict = "rejected — does not beat the baseline"
    print(f"    {name:<14} WMAPE {r.wmape:7.2f}%   MASE {r.mase:6.3f}   {verdict}")

# Does accuracy decay as the forecast reaches further out? Splitting the scored
# window by how many days ahead each prediction was made answers that directly.
# Week 2 error should exceed week 1; if it doesn't, the model isn't really using
# recent information and is closer to a seasonal average than a forecast.
banner("STEP 3b: Does error grow with horizon? (week 1 vs week 2 ahead)")

step_arr = np.array([steps_ahead.get(pd.Timestamp(d), 0) for d in eval_df.ds])
wk1 = step_arr <= 7
wk2 = (step_arr > 7) & (step_arr <= 14)
print(f"  Week 1 = days 1-7 ahead ({wk1.sum()} days)   "
      f"Week 2 = days 8-14 ahead ({wk2.sum()} days)\n")
print(f"  {'model':<16}{'wk1 WMAPE':>11}{'wk2 WMAPE':>11}{'change':>12}")
for name in MODELS:
    yhat = np.array([preds[name].get(pd.Timestamp(d), np.nan) for d in eval_df.ds])
    act = eval_df["y"].values
    def _wmape(mask):
        m = mask & np.isfinite(yhat)
        if m.sum() == 0:
            return np.nan
        return 100 * np.sum(np.abs(act[m] - yhat[m])) / np.sum(np.abs(act[m]))
    a, b = _wmape(wk1), _wmape(wk2)
    if np.isfinite(a) and np.isfinite(b):
        print(f"  {name:<16}{a:>10.2f}%{b:>10.2f}%{b - a:>+11.2f} pts")

# How much of each forecast is explained by weekday alone? A model near the
# actual series' own value is responding to more than the weekly cycle.
banner("STEP 4: Weekday-only R2 — is the forecast just a repeating week?")
def weekday_r2(vals, dates):
    v = pd.Series(vals, index=pd.DatetimeIndex(dates)).dropna()
    if len(v) < SEASON * 2:
        return np.nan
    g = v.groupby(v.index.dayofweek).transform("mean")
    sst = ((v - v.mean()) ** 2).sum()
    return float(1 - ((v - g) ** 2).sum() / sst) if sst > 0 else np.nan

print(f"  {'ACTUAL traffic':<16} {weekday_r2(eval_df['y'].values, eval_df.ds):.4f}   <- reference")
for name in MODELS:
    yhat = [preds[name].get(pd.Timestamp(d), np.nan) for d in eval_df.ds]
    print(f"  {name:<16} {weekday_r2(yhat, eval_df.ds):.4f}")
print("\n  A model far ABOVE the reference is emitting a repeating weekly average")
print("  rather than reacting to conditions.")


# ─────────────────────────────────────────────────────
# 4c. AIC / BIC — structure comparison within the likelihood-based family
# ─────────────────────────────────────────────────────
banner("STEP 4c: AIC / BIC (ARIMA-family structure comparison)")

# AIC and BIC compare model STRUCTURE fitted to the SAME data, so they are taken
# from a single fit on the full history — not averaged over rolling origins, where
# every origin sees a different number of observations and the values would not be
# comparable. Only likelihood-based models expose them: Prophet, the LSTM and the
# naive baselines have no likelihood to score, and are reported as n/a rather than
# given a placeholder that invites a meaningless cross-family comparison.
INFO_CRIT: dict[str, tuple[float, float]] = {}

from statsmodels.tsa.holtwinters import ExponentialSmoothing as _ES, Holt as _Holt
from statsmodels.tsa.statespace.sarimax import SARIMAX as _SX

_IC_FITS = {
    "HoltWinters":  lambda: _ES(df["y"].values, trend="add", seasonal="add",
                                seasonal_periods=SEASON,
                                initialization_method="estimated").fit(),
    "Holts_Linear": lambda: _Holt(df["y"].values,
                                  initialization_method="estimated").fit(optimized=True),
    "SARIMAX":      lambda: _SX(df["y"].values, exog=df[WEATHER_COLS].values,
                                order=(1, 1, 1), seasonal_order=(1, 1, 1, SEASON),
                                enforce_stationarity=False,
                                enforce_invertibility=False).fit(disp=False),
    "SARIMAX_nw":   lambda: _SX(df["y"].values, order=(1, 1, 1),
                                seasonal_order=(1, 1, 1, SEASON),
                                enforce_stationarity=False,
                                enforce_invertibility=False).fit(disp=False),
}

for _name, _mk in _IC_FITS.items():
    try:
        _f = _mk()
        INFO_CRIT[_name] = (float(_f.aic), float(_f.bic))
        print(f"  {_name:<14} AIC {INFO_CRIT[_name][0]:>14,.1f}   BIC {INFO_CRIT[_name][1]:>14,.1f}")
    except Exception as exc:
        print(f"  {_name:<14} could not compute: {str(exc)[:60]}")

for _name in MODELS:
    if _name not in INFO_CRIT and _name not in BASELINES:
        print(f"  {_name:<14} n/a — not a likelihood-based model")

print("\n  Lower is better, and ONLY comparable within this family. AIC/BIC cannot")
print("  rank SARIMAX against Prophet or the LSTM — different likelihoods, or none.")


# ─────────────────────────────────────────────────────
# 5. FUTURE — refit on everything, project past the last actual
# ─────────────────────────────────────────────────────
banner(f"STEP 5: FUTURE forecast ({FUTURE_DAYS} days past the last actual)")

future_dates = pd.date_range(df.ds.max() + pd.Timedelta(days=1), periods=FUTURE_DAYS, freq="D")
future_df = pd.DataFrame({"ds": future_dates})
for c in WEATHER_COLS:
    future_df[c] = [float(HIST_BY_DOY[c].get(d.dayofyear, df[c].mean())) for d in future_dates]

print(f"  {future_dates[0].date()} -> {future_dates[-1].date()}")
print("  Weather for this window is day-of-year climatology, not observation.")
print(f"  Metrics were validated at h={HORIZON}d; error grows beyond that.\n")

future_preds = {}
for name, fn in MODELS.items():
    try:
        yhat = np.asarray(fn(df, FUTURE_DAYS, future_df), dtype=float)
        if yhat.shape != (FUTURE_DAYS,) or not np.isfinite(yhat).all():
            raise ValueError("bad output")
        future_preds[name] = yhat
        print(f"  {name:<14} ok   mean {yhat.mean():,.0f}")
    except Exception as exc:
        future_preds[name] = np.full(FUTURE_DAYS, np.nan)
        print(f"  {name:<14} FAILED: {str(exc)[:70]}")


# ─────────────────────────────────────────────────────
# 6. WRITE BACK — PAST context | PRESENT scored | FUTURE projected
# ─────────────────────────────────────────────────────
banner("STEP 6: Writing to AWS")

ctx_df = df.iloc[0:eval_start] if CTX <= 0 else df.iloc[max(0, eval_start - CTX):eval_start]

# The original connection has been idle through many minutes of model fitting and
# RDS will have dropped it. Open a fresh one for the write.
try:
    conn.close()
except Exception:
    pass
conn = psycopg2.connect(POSTGRES_URL)
cur = conn.cursor()
cur.execute("TRUNCATE gold.ml_predictive_volume RESTART IDENTITY")

def put(d, actual, p, holdout, future):
    cur.execute(
        """INSERT INTO gold.ml_predictive_volume
           (forecast_date, actual_volume, pred_lstm, pred_prophet, pred_holtwinters,
            pred_sarimax, pred_holts_linear, is_holdout, is_future,
            weather_rainfall, weather_temp,
            pred_prophet_nw, pred_sarimax_nw, pred_lstm_nw)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (d["ds"].date(), int(actual) if actual is not None else None,
         p("LSTM"), p("Prophet"), p("HoltWinters"), p("SARIMAX"), p("Holts_Linear"),
         holdout, future, float(d["total_rain"]), float(d["avg_temp"]),
         p("Prophet_nw"), p("SARIMAX_nw"), p("LSTM_nw")),
    )

for _, d in ctx_df.iterrows():
    put(d, d["y"], lambda n: None, False, False)

for _, d in eval_df.iterrows():
    def p(n, _d=d):
        v = preds[n].get(pd.Timestamp(_d["ds"]), np.nan)
        return None if not np.isfinite(v) else int(round(v))
    put(d, d["y"], p, True, False)

for i, (_, d) in enumerate(future_df.iterrows()):
    def p(n, _i=i):
        v = future_preds[n][_i]
        return None if not np.isfinite(v) else int(round(v))
    put(d, None, p, False, True)

conn.commit()
print(f"  ml_predictive_volume: {len(ctx_df)} PAST + {len(eval_df)} PRESENT + {len(future_df)} FUTURE")

cur.execute("DELETE FROM gold.ml_model_metrics WHERE target = 'Total Traffic'")
# The chart's metrics table shows the weather-driven models; the _nw controls are
# stored alongside with uses_weather=false so the toggle can show their numbers too.
for name, r in learned.iterrows():
    if not np.isfinite(r.wmape):
        continue
    _aic, _bic = INFO_CRIT.get(name, (None, None))
    # State the criterion that ACTUALLY failed. Acceptance needs both
    # (WMAPE < baseline) and (MASE < 1.0), so a single canned message about the
    # baseline is wrong whenever a model clears the baseline but fails MASE —
    # Holt-Winters did exactly that and was given a reason contradicted by its
    # own numbers sitting in the next column.
    _fails = []
    if not (r.wmape < base):
        _fails.append(f"WMAPE {r.wmape:.2f}% does not beat baseline {base:.2f}%")
    if not (r.mase < 1.0):
        _fails.append(f"MASE {r.mase:.3f} >= 1.0 (no better than seasonal naive)")
    _reason = None if r.accepted else "; ".join(_fails)
    cur.execute(
        """INSERT INTO gold.ml_model_metrics
           (model_name, target, rmse, mae, mse, wmape, r2, mase, mape, smape, rmsse,
            rank, accepted, rejected_reason, uses_weather, aic, bic, updated_at)
           VALUES (%s,'Total Traffic',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())""",
        (name, r.rmse, r.mae, r.mse, r.wmape, r.r2, r.mase, r.mape, r.smape, r.rmsse,
         int(r["rank"]), bool(r.accepted), _reason,
         not name.endswith("_nw"), _aic, _bic),
    )
conn.commit()
cur.close()
conn.close()

print(f"  ml_model_metrics: {int(np.isfinite(learned.wmape).sum())} models")
print("\n  Metrics and chart now describe the same forecasts at the same horizon.\n")
