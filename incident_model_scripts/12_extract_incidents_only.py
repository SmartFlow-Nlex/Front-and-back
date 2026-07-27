"""
STAGE 10 - INCIDENT-ONLY EXTRACTION (NO WEATHER, NO VOLUME)
===========================================================
Sources (AWS RDS, bronze schema) - ONLY these three:
    bronze.road_crashes         (ISO date, 24h time)
    bronze.motorcycle_crashes   (MM/DD/YYYY date, 12h AM/PM time)
    bronze.stalled_vehicles     (ISO date, 24h time)

Builds two count panels for incident-rate modelling:
    incidents_only_hourly_global.csv   -> incident_count per (date, hour), corridor-wide
    incidents_only_hourly_segment.csv  -> incident_count per (date, hour, segment)

Deliberately EXCLUDED:
  * bronze.hourly_weather          -> user instruction: no weather
  * weather_condition column       -> post-hoc field, only populated once an incident
                                      exists => target leakage
  * cause/type/injuries/clearance  -> outcome attributes of an incident that already
                                      happened => target leakage
  * traffic_volume / waze          -> out of scope for this run

Only bronze.exits is joined, purely for corridor geometry (lat/lon per exit), which the
spatial models (GWR, Spatial LSTM) require as coordinates - not as a predictor.
"""
import os
import re
import numpy as np
import pandas as pd
import psycopg2

PGURL = os.environ["PGURL"]
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs", "dataset")
os.makedirs(OUT_DIR, exist_ok=True)

# NLEX corridor: exit -> km post. Used to map "Km 24+400" to the nearest named exit.
EXIT_KM = {
    "Balintawak": 5.0, "NLEX Harbor Link": 8.0, "Paso De Blas Valenzuela": 11.0,
    "Meycauayan": 18.0, "Marilao": 21.0, "Bocaue Interchange": 26.0,
    "Bocaue Barrier": 28.0, "Cdv/Ph Arena": 29.0, "Tambubong": 31.0,
    "Balagtas": 33.0, "Tabang Guiguinto": 39.0, "Sta. Rita Guiguinto": 42.0,
    "Pulilan": 50.0, "San Simon": 62.0, "San Fernando": 72.0,
    "Mexico": 79.0, "Angeles": 88.0, "Dau": 93.0, "Sctex": 96.0, "Sta. Ines": 99.0,
}
# Named toll plazas that appear in `location` instead of a km marker
PLAZA_KM = {
    "balintawak toll plaza": 5.0,
    "bocaue barrier": 28.0,
    "cdv toll plaza": 29.0,
}


def parse_km(loc):
    """'Km 24+400' -> 24.4 ; 'Balintawak Toll Plaza' -> 5.0 ; else NaN."""
    if not loc:
        return np.nan
    s = str(loc).strip()
    m = re.search(r"[Kk][Mm]\s*(\d+)\s*\+\s*(\d+)", s)
    if m:
        return float(m.group(1)) + float(m.group(2)) / 1000.0
    m = re.search(r"[Kk][Mm]\s*(\d+)", s)
    if m:
        return float(m.group(1))
    return PLAZA_KM.get(s.lower(), np.nan)


def nearest_exit(km):
    if pd.isna(km):
        return None
    return min(EXIT_KM.items(), key=lambda kv: abs(kv[1] - km))[0]


def parse_hour(t, ampm=False):
    """'23:06:00' -> 23 ; '09:52 AM' -> 9 ; '05:01 PM' -> 17."""
    if not t:
        return np.nan
    s = str(t).strip().upper()
    if ampm or "AM" in s or "PM" in s:
        m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", s)
        if not m:
            return np.nan
        h = int(m.group(1)) % 12
        if m.group(3) == "PM":
            h += 12
        return h
    m = re.match(r"(\d{1,2}):(\d{2})", s)
    return int(m.group(1)) if m else np.nan


def fetch(sql):
    with psycopg2.connect(PGURL) as conn:
        return pd.read_sql(sql, conn)


def main():
    print("=" * 74)
    print("  STAGE 10 - INCIDENT-ONLY EXTRACTION (3 bronze tables, no weather)")
    print("=" * 74)

    # ---------------- 1. road_crashes : ISO date, 24h time ----------------
    rc = fetch("SELECT date, reported_time, location FROM bronze.road_crashes")
    rc["dt"] = pd.to_datetime(rc["date"], format="%Y-%m-%d", errors="coerce")
    rc["hour_of_day"] = rc["reported_time"].apply(lambda x: parse_hour(x, ampm=False))
    rc["incident_type"] = "road_crash"
    print(f"  road_crashes        : {len(rc):6d} rows  "
          f"({rc['dt'].isna().sum()} bad dates, {rc['hour_of_day'].isna().sum()} bad times)")

    # ---------------- 2. motorcycle_crashes : MM/DD/YYYY, 12h AM/PM ----------------
    mc = fetch("SELECT date, reported_time, location FROM bronze.motorcycle_crashes")
    mc["dt"] = pd.to_datetime(mc["date"], format="%m/%d/%Y", errors="coerce")
    mc["hour_of_day"] = mc["reported_time"].apply(lambda x: parse_hour(x, ampm=True))
    mc["incident_type"] = "motorcycle_crash"
    print(f"  motorcycle_crashes  : {len(mc):6d} rows  "
          f"({mc['dt'].isna().sum()} bad dates, {mc['hour_of_day'].isna().sum()} bad times)")

    # ---------------- 3. stalled_vehicles : ISO date, 24h time ----------------
    sv = fetch("SELECT date, reported_time, location FROM bronze.stalled_vehicles")
    sv["dt"] = pd.to_datetime(sv["date"], format="%Y-%m-%d", errors="coerce")
    sv["hour_of_day"] = sv["reported_time"].apply(lambda x: parse_hour(x, ampm=False))
    sv["incident_type"] = "stalled_vehicle"
    print(f"  stalled_vehicles    : {len(sv):6d} rows  "
          f"({sv['dt'].isna().sum()} bad dates, {sv['hour_of_day'].isna().sum()} bad times)")

    # ---------------- combine ----------------
    cols = ["dt", "hour_of_day", "location", "incident_type"]
    inc = pd.concat([rc[cols], mc[cols], sv[cols]], ignore_index=True)
    before = len(inc)
    inc = inc.dropna(subset=["dt", "hour_of_day"])
    inc["hour_of_day"] = inc["hour_of_day"].astype(int)
    inc = inc[inc["hour_of_day"].between(0, 23)]
    print(f"\n  combined            : {before} -> {len(inc)} usable "
          f"({before - len(inc)} dropped: unparseable date/hour)")

    inc["km_value"] = inc["location"].apply(parse_km)
    inc["nearest_exit"] = inc["km_value"].apply(nearest_exit)
    print(f"  km parsed           : {inc['km_value'].notna().sum()} / {len(inc)} "
          f"({inc['km_value'].isna().sum()} unmapped locations)")

    inc.to_csv(f"{OUT_DIR}/incidents_raw_unified.csv", index=False)

    lo, hi = inc["dt"].min(), inc["dt"].max()
    print(f"  date range          : {lo.date()} -> {hi.date()}")
    print(f"  type mix            : {inc['incident_type'].value_counts().to_dict()}")

    # ================= GLOBAL HOURLY PANEL =================
    # Dense hourly spine so zero-incident hours are real zeros, not missing rows.
    spine = pd.DataFrame(
        {"dt": np.repeat(pd.date_range(lo, hi, freq="D"), 24)}
    )
    spine["hour_of_day"] = np.tile(np.arange(24), len(spine) // 24)

    agg = (inc.groupby(["dt", "hour_of_day"])
              .agg(incident_count=("incident_type", "size"),
                   crash_count=("incident_type",
                                lambda s: int((s == "road_crash").sum())),
                   motorcycle_count=("incident_type",
                                     lambda s: int((s == "motorcycle_crash").sum())),
                   stall_count=("incident_type",
                                lambda s: int((s == "stalled_vehicle").sum())))
              .reset_index())

    g = spine.merge(agg, on=["dt", "hour_of_day"], how="left")
    for c in ["incident_count", "crash_count", "motorcycle_count", "stall_count"]:
        g[c] = g[c].fillna(0).astype(int)

    g = add_calendar(g)
    g = add_lags(g, group=None)
    g.to_csv(f"{OUT_DIR}/incidents_only_hourly_global.csv", index=False)
    print(f"\n  [OK] global panel   : {len(g)} rows -> incidents_only_hourly_global.csv")
    print(f"       mean count/hr  : {g['incident_count'].mean():.3f}   "
          f"var: {g['incident_count'].var():.3f}   "
          f"zero-hours: {(g['incident_count'] == 0).mean() * 100:.1f}%")

    # The spatial panel is NOT built here. 14_spatial_models.py derives its own
    # 2 km corridor panel straight from incidents_raw_unified.csv, because the
    # 13-exit catchment version was both too coarse for GWR's bandwidth search
    # and 186 MB on disk. Nothing downstream reads it, so it is not written.
    print("\n  spatial panel       : built by 14_spatial_models.py (2km segments)")
    print("\nDone.")


def add_calendar(df):
    df["day_of_week"] = df["dt"].dt.dayofweek
    df["month"] = df["dt"].dt.month
    df["quarter"] = df["dt"].dt.quarter
    df["day_of_year"] = df["dt"].dt.dayofyear
    df["year"] = df["dt"].dt.year
    df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)
    df["is_rush_hour"] = df["hour_of_day"].isin([6, 7, 8, 9, 16, 17, 18, 19]).astype(int)
    # cyclical encodings so hour 23 sits next to hour 0
    df["hour_sin"] = np.sin(2 * np.pi * df["hour_of_day"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour_of_day"] / 24)
    df["dow_sin"] = np.sin(2 * np.pi * df["day_of_week"] / 7)
    df["dow_cos"] = np.cos(2 * np.pi * df["day_of_week"] / 7)
    df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
    df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)
    return df


def add_calendar_daily(df):
    df["day_of_week"] = df["dt"].dt.dayofweek
    df["month"] = df["dt"].dt.month
    df["quarter"] = df["dt"].dt.quarter
    df["year"] = df["dt"].dt.year
    df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)
    df["dow_sin"] = np.sin(2 * np.pi * df["day_of_week"] / 7)
    df["dow_cos"] = np.cos(2 * np.pi * df["day_of_week"] / 7)
    df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
    df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)
    return df


def add_lags(df, group=None):
    """Autoregressive features. All shifted >=1 so no same-hour leakage."""
    if group is None:
        s = df["incident_count"]
        df["inc_lag_1h"] = s.shift(1).fillna(0)
        df["inc_lag_2h"] = s.shift(2).fillna(0)
        df["inc_lag_3h"] = s.shift(3).fillna(0)
        df["inc_lag_24h"] = s.shift(24).fillna(0)
        df["inc_lag_168h"] = s.shift(168).fillna(0)
        df["inc_roll_24h"] = s.shift(1).rolling(24, min_periods=1).mean().fillna(0)
        df["inc_roll_168h"] = s.shift(1).rolling(168, min_periods=1).mean().fillna(0)
    else:
        gb = df.groupby(group)["incident_count"]
        df["inc_lag_1h"] = gb.shift(1).fillna(0)
        df["inc_lag_2h"] = gb.shift(2).fillna(0)
        df["inc_lag_3h"] = gb.shift(3).fillna(0)
        df["inc_lag_24h"] = gb.shift(24).fillna(0)
        df["inc_lag_168h"] = gb.shift(168).fillna(0)
        df["inc_roll_24h"] = (gb.transform(
            lambda x: x.shift(1).rolling(24, min_periods=1).mean()).fillna(0))
        df["inc_roll_168h"] = (gb.transform(
            lambda x: x.shift(1).rolling(168, min_periods=1).mean()).fillna(0))
    return df


if __name__ == "__main__":
    main()
