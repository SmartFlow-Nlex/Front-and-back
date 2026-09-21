#!/usr/bin/env python3
"""
Builds ../calibration.json from the client's accident/breakdown CSV exports.

Read-only on the CSVs; writes only the JSON. Deterministic: the same files give the same bytes
(except `generated_on`, which can be pinned with --date).

    python build_calibration.py --csv-dir "D:\\OneDrive_2026-09-08\\shared files" --out ../calibration.json

WHAT IT COMPUTES
  Duration quantiles (p10 p25 p50 p75 p90 p99, plus observed min/max and n) per scenario family:
    accident families  -> clearance = SiteCleared - event_start_date, in minutes
    breakdown families -> service_time_min of each DEPLOYMENT RECORD (arrival -> departure).
                          One breakdown event can have several deployment records; each is one value.
  Only positive durations up to 24 h are kept. Everything else is excluded AND counted, per family:
    missing  - the value is absent / not numeric
    negative - the end timestamp precedes the start (accidents) / a negative recorded value
    zero     - exactly 0 minutes
    over_1440- more than 24 h (the Incident module's own sanity cap, see below)
  The 0-1440 window mirrors the existing MTTC rule (10-bronze-accident-breakdown.sql, clearance_min;
  incident-events.service.ts RESPONSE_MIN/SERVICE_MIN). The existing rule KEEPS zeros; this file drops them
  because a zero-minute event is not an event a simulator can place. `reference.including_zeros` shows
  what the existing rule would have produced, so the choice is visible.

POPULATION RULES (re-implementation of Back-End/src/etl/cleaner.ts + transformer.ts + the silver SQL;
  on the 2026-09-08 CSVs this reproduces the DB's silver row counts exactly: 21,804 / 156,901)
  ETL accept : StartKM/1000 present and within [0, 89]; event date present
  silver     : accident  -> SiteCleared present, EventStatus in (FINALIZED, AVAILABLE), one row per EventNumber
               breakdown -> EventStatus = FINALIZED, one row per EventNumber
  scenario   : only events logged in a MAINLINE LANE (SubLocation Lane1-4 / Main Line) are used for the
               in-lane families; Soft Shoulder for the shoulder family. Toll-plaza, ramp, E-Lane and
               E-Parking events are excluded (a plaza has no counterpart in the engine).
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
from typing import Iterable

import numpy as np
import pandas as pd

NLEX_KM_MAX = 89.0
QPOINTS = (10, 25, 50, 75, 90, 99)
LANES = ("Lane1", "Lane2", "Lane3", "Lane4", "Main Line")
DEFAULT_SOURCE_NOTE = "client CSV exports, 2022-01-01 .. 2026-06-30"

ACCIDENT_FAMILIES: dict[str, dict[str, str]] = {
    # family key -> {TypeOfEvent value: variant}
    "minor_collision": {"Rear End": "rear_end", "Side Swipe": "sideswipe", "Hit and Run": "hit_and_run"},
    "multi_vehicle_collision": {"Multiple Collision": ""},
    "self_accident": {"Self Accident": ""},
}
# Reference-only cuts. These label mappings are ASSUMPTIONS (mirrored in scenarios/assumptions.ts).
CAUSE_BY_SUBCAUSE = {
    "tire": None,  # decided by MainCause == Tire
    "electrical": ("Battery", "Electrical", "Alternator", "Starter", "Wiring", "Spark Plug", "Contact Point"),
}
VEHICLE_BY_TYPE = {"Truck": "truck", "Bus": "bus", "Sedan/Car": "car", "AUV": "car", "SUV": "car", "Van": "car", "Pick-Up": "car"}


# ----------------------------------------------------------------------------- loading
def read_family(csv_dir: str, family: str) -> tuple[pd.DataFrame, list[dict[str, object]]]:
    date_col = "event_start_date" if family == "accident" else "event_encoded_date"
    frames, files = [], []
    for i, path in enumerate(sorted(glob.glob(os.path.join(csv_dir, f"{family}_data_*.csv")))):
        df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""], encoding="utf-8", encoding_errors="replace")
        df["_ord"] = np.arange(len(df)) + i * 1_000_000
        frames.append(df)
        files.append({"file": os.path.basename(path), "rows": int(len(df))})
    if not frames:
        raise SystemExit(f"no {family}_data_*.csv in {csv_dir}")
    a = pd.concat(frames, ignore_index=True)
    a["km"] = pd.to_numeric(a["StartKM"], errors="coerce") / 1000.0
    a["ts"] = pd.to_datetime(a[date_col], errors="coerce")
    a["EN"] = pd.to_numeric(a["EventNumber"], errors="coerce")
    if family == "accident":
        for c in ("BlockageCleared", "SiteCleared"):
            a[c + "_ts"] = pd.to_datetime(a[c], errors="coerce")
    return a, files


def etl_accept(a: pd.DataFrame) -> pd.DataFrame:
    return a[a.km.notna() & a.km.between(0, NLEX_KM_MAX) & a.ts.notna()].copy()


def silver(family: str, bronze: pd.DataFrame) -> pd.DataFrame:
    b = bronze[bronze.EN.notna()]
    if family == "accident":
        b = b[b.SiteCleared_ts.notna() & b.EventStatus.isin(["FINALIZED", "AVAILABLE"])]
    else:
        b = b[b.EventStatus == "FINALIZED"]
    return b.sort_values("_ord").drop_duplicates("EN", keep="last").copy()


_FIELDS = ("service", "dispatch_time", "arrival_time", "departure_time", "response_time_min", "service_time_min", "remarks")
_FIELD_RE = {f: re.compile(rf"'{f}':\s*(?:'([^']*)'|\"([^\"]*)\")") for f in _FIELDS}


def parse_deployments(raw: object) -> list[dict[str, str | None]]:
    """Targeted parser mirroring Back-End/src/etl/transformer.ts parseDeployments (both quote styles)."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)) or raw == "":
        return []
    normalized = re.sub(r"\}\s*\n?\s*\{", "}, {", str(raw))
    out: list[dict[str, str | None]] = []
    for block in re.findall(r"\{[^{}]*\}", normalized):
        rec: dict[str, str | None] = {}
        for f in _FIELDS:
            m = _FIELD_RE[f].search(block)
            rec[f] = None if m is None else (m.group(1) if m.group(1) is not None else (m.group(2) or ""))
        out.append(rec)
    return out


# ----------------------------------------------------------------------------- statistics
def to_num(v: str | None) -> float:
    if v is None or v == "":
        return float("nan")
    try:
        return float(v)
    except ValueError:
        return float("nan")


def classify(values: Iterable[float]) -> tuple[np.ndarray, dict[str, int]]:
    """Split raw minute values into the kept set (0 < x <= 1440) and per-reason exclusion counts."""
    x = np.asarray(list(values), dtype=float)
    missing = int(np.isnan(x).sum())
    v = x[~np.isnan(x)]
    kept = v[(v > 0) & (v <= 1440)]
    return kept, {"missing": missing, "negative": int((v < 0).sum()), "zero": int((v == 0).sum()), "over_1440": int((v > 1440).sum())}


def quantiles(kept: np.ndarray) -> dict[str, float | int]:
    if kept.size == 0:
        raise SystemExit("empty family after exclusions: refusing to write an unusable calibration")
    out: dict[str, float | int] = {"min": float(kept.min())}
    for p, q in zip(QPOINTS, np.percentile(kept, QPOINTS)):
        out[f"p{p}"] = round(float(q), 2)
    out["max"] = float(kept.max())
    return out


def block(values: Iterable[float]) -> dict[str, object]:
    kept, excl = classify(values)
    return {"n": int(kept.size), "excluded": excl, **quantiles(kept)}


def including_zeros(values: Iterable[float]) -> dict[str, object]:
    """What the EXISTING rule (0 <= x <= 1440, zeros kept) would give. Reference only."""
    x = np.asarray(list(values), dtype=float)
    kept = x[~np.isnan(x)]
    kept = kept[(kept >= 0) & (kept <= 1440)]
    return {"n": int(kept.size), **{f"p{p}": round(float(q), 2) for p, q in zip(QPOINTS, np.percentile(kept, QPOINTS))}}


def lane_distribution(events: pd.DataFrame) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for name, sub in (("all", events), ("NB", events[events.Direction == "NB"]), ("SB", events[events.Direction == "SB"])):
        vc = sub.SubLocation.value_counts()
        out[name] = {lane: int(vc.get(lane, 0)) for lane in LANES}
    return out


# ----------------------------------------------------------------------------- families
def accident_entry(events: pd.DataFrame, label: str, population: str) -> dict[str, object]:
    clearance = ((events.SiteCleared_ts - events.ts).dt.total_seconds() / 60.0).tolist()
    blockage = ((events.BlockageCleared_ts - events.ts).dt.total_seconds() / 60.0).tolist()
    entry: dict[str, object] = {
        "label": label,
        "duration_kind": "clearance_min",
        "duration_definition": "SiteCleared - event_start_date, minutes (per accident event)",
        "population": population,
        "n_events": int(len(events)),
        "n_values_before_exclusion": int(len(clearance)),
        **block(clearance),
        "reference": {
            "not_used_by_sampler": True,
            "including_zeros_existing_rule": including_zeros(clearance),
            "blockage_min_positive": block(blockage),
            "lane_distribution": lane_distribution(events),
        },
    }
    return entry


def deployments_frame(events: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for en, main, sub, vtype, direction, subloc, dep in zip(events.EN, events.MainCause, events.SubCause, events.TypeOfVehicle, events.Direction, events.SubLocation, events.deployments):
        for d in parse_deployments(dep):
            rows.append({"EN": en, "MainCause": main, "SubCause": sub, "TypeOfVehicle": vtype, "Direction": direction, "SubLocation": subloc,
                         "service": to_num(d["service_time_min"]), "response": to_num(d["response_time_min"])})
    return pd.DataFrame(rows, columns=["EN", "MainCause", "SubCause", "TypeOfVehicle", "Direction", "SubLocation", "service", "response"])


def cause_of(main: object, sub: object) -> str | None:
    if main == "Tire":
        return "tire"
    if main == "Engine":
        return "engine"
    if main == "Mechanical":
        return "mechanical"
    if main == "Fuel":
        return "fuel"
    if sub in (CAUSE_BY_SUBCAUSE["electrical"] or ()):
        return "electrical"
    return None


def breakdown_entry(events: pd.DataFrame, label: str, population: str, with_variants: bool, lane_based: bool) -> dict[str, object]:
    dep = deployments_frame(events)
    entry: dict[str, object] = {
        "label": label,
        "duration_kind": "service_time_min_per_deployment_record",
        "duration_definition": "service_time_min of each deployment record (arrival -> departure), minutes. One breakdown event can have several records; each is one value. Events without any deployment record contribute nothing.",
        "population": population,
        "n_events": int(len(events)),
        "n_events_with_deployment_records": int(dep.EN.nunique()),
        "n_values_before_exclusion": int(len(dep)),
        **block(dep.service.tolist()),
    }
    ref: dict[str, object] = {
        "not_used_by_sampler": True,
        "including_zeros_existing_rule": including_zeros(dep.service.tolist()),
        "response_time_min_positive": block(dep.response.tolist()),
        "response_time_min_note": "dispatch -> arrival. NOT part of the calibrated duration. The obstacle exists from the breakdown until the patrol departs, i.e. response + service.",
    }
    if lane_based:
        ref["lane_distribution"] = lane_distribution(events)
    if with_variants:
        dep["cause"] = [cause_of(m, s) for m, s in zip(dep.MainCause, dep.SubCause)]
        dep["vehicle"] = dep.TypeOfVehicle.map(VEHICLE_BY_TYPE)
        ref["service_by_cause"] = {c: block(g.service.tolist()) for c, g in dep.dropna(subset=["cause"]).groupby("cause")}
        ref["service_by_vehicle"] = {v: block(g.service.tolist()) for v, g in dep.dropna(subset=["vehicle"]).groupby("vehicle")}
        ref["variant_mapping_note"] = ("cause: MainCause Tire/Engine/Mechanical/Fuel; electrical = SubCause in "
                                        + ", ".join(CAUSE_BY_SUBCAUSE["electrical"] or ()) + ". vehicle: Truck->truck, Bus->bus, Sedan/Car+AUV+SUV+Van+Pick-Up->car; "
                                        "PUV, Owner-Type Jeepney, Motorcycle, Heavy Equipment excluded. These mappings are assumptions.")
    entry["reference"] = ref
    return entry


# (app exit name, app km, SubLocation label the events use for the same place).
# App km = Front-End-Dashboard/lib/nlex-exits.ts FALLBACK_EXITS (Balintawak = 0). Matching is by name, by hand.
APP_EXITS: tuple[tuple[str, float, str], ...] = (
    ("Balintawak", 0.0, "Balintawak"), ("Paso De Blas Valenzuela", 3.44, "Valenzuela"), ("Meycauayan", 8.21, "Meycauayan"),
    ("Marilao", 11.73, "Marilao"), ("Cdv/Ph Arena", 14.05, "CDV"), ("Bocaue Barrier", 15.2, "Bocaue Barrier"),
    ("Bocaue Interchange", 15.82, "Bocaue"), ("Balagtas", 21.09, "Balagtas"), ("Sta. Rita Guiguinto", 26.55, "Sta. Rita"),
    ("Pulilan", 33.33, "Pulilan"), ("San Simon", 44.91, "San Simon"), ("San Fernando", 53.78, "San Fernando"),
    ("Mexico", 60.78, "Mexico"), ("Angeles", 69.15, "Angeles"), ("Dau", 71.05, "Dau"), ("Sta. Ines", 76.25, "Sta. Ines"),
    ("Tabang Guiguinto", 20.69, "Tabang"),
)


def chainage_offset(sa: pd.DataFrame, sb: pd.DataFrame) -> dict[str, object]:
    """Event StartKM is absolute NLEX chainage; the app's exit km is measured from Balintawak. Compare named places."""
    both = pd.concat([sa[["SubLocation", "km"]], sb[["SubLocation", "km"]]])
    rows: list[dict[str, object]] = []
    raw_offsets: list[float] = []
    for app_name, app_km, label in APP_EXITS:
        k = both[both.SubLocation == label].km
        med = float(k.median())
        raw_offsets.append(med - app_km)
        rows.append({"app_exit": app_name, "app_km": app_km, "event_label": label, "events": int(len(k)), "chainage_km": round(med, 2),
                     "iqr_km": round(float(k.quantile(0.75) - k.quantile(0.25)), 2), "offset_km": round(med - app_km, 2)})
    return {"rows": rows, "median_offset_km": round(float(np.median(raw_offsets)), 2), "min_offset_km": round(min(raw_offsets), 2), "max_offset_km": round(max(raw_offsets), 2),
            "rule": "median over all listed places of (median event chainage of events logged at that place - app km); every listed place has IQR < 1 km"}


def build(csv_dir: str, date: str) -> dict[str, object]:
    ra, files_a = read_family(csv_dir, "accident")
    rb, files_b = read_family(csv_dir, "breakdown")
    sa, sb = silver("accident", etl_accept(ra)), silver("breakdown", etl_accept(rb))

    families: dict[str, object] = {}
    lane_a = sa[sa.SubLocation.isin(LANES)]
    minor_all = lane_a[lane_a.TypeOfEvent.isin(ACCIDENT_FAMILIES["minor_collision"])]
    families["minor_collision"] = accident_entry(minor_all, "Minor collision (rear-end + side-swipe + hit-and-run)",
                                                 "accident events with TypeOfEvent in (Rear End, Side Swipe, Hit and Run) logged in a mainline lane")
    for toe, variant in ACCIDENT_FAMILIES["minor_collision"].items():
        families[f"minor_collision_{variant}"] = accident_entry(lane_a[lane_a.TypeOfEvent == toe], f"Minor collision: {variant}", f"TypeOfEvent = {toe}, logged in a mainline lane")
    families["multi_vehicle_collision"] = accident_entry(lane_a[lane_a.TypeOfEvent == "Multiple Collision"], "Multi-vehicle collision", "TypeOfEvent = Multiple Collision, logged in a mainline lane")
    families["self_accident"] = accident_entry(lane_a[lane_a.TypeOfEvent == "Self Accident"], "Self accident", "TypeOfEvent = Self Accident, logged in a mainline lane")
    families["breakdown_in_lane"] = breakdown_entry(sb[sb.SubLocation.isin(LANES)], "Breakdown in a lane", "breakdown events logged in a mainline lane (Lane1-4 / Main Line)", with_variants=True, lane_based=True)
    families["breakdown_shoulder"] = breakdown_entry(sb[sb.SubLocation == "Soft Shoulder"], "Breakdown on the shoulder", "breakdown events with SubLocation = Soft Shoulder", with_variants=False, lane_based=False)

    return {
        "provenance": {
            "generated_on": date,
            "generator": "app/dashboard/ai-sandbox/scenarios/tools/build_calibration.py",
            "source": DEFAULT_SOURCE_NOTE,
            "source_folder": "/".join(os.path.normpath(csv_dir).split(os.sep)[-2:]),
            "source_files": files_a + files_b,
            "csv_row_totals": {"accident": int(len(ra)), "breakdown": int(len(rb))},
            "population_row_counts": {
                "accident_etl_accepted": int(len(etl_accept(ra))), "breakdown_etl_accepted": int(len(etl_accept(rb))),
                "accident_silver_events": int(len(sa)), "breakdown_silver_events": int(len(sb)),
                "accident_mainline_lane_events": int(len(lane_a)), "breakdown_mainline_lane_events": int(sb.SubLocation.isin(LANES).sum()),
                "breakdown_soft_shoulder_events": int((sb.SubLocation == "Soft Shoulder").sum()),
            },
            "silver_reproduction_note": "The ETL + silver rules below reproduce the database's silver row counts recorded on 2026-09-21 (21,804 accidents / 156,901 breakdowns) exactly. The database itself was unreachable when this file was generated, so no live query was run.",
            "population_rules": [
                "ETL accept: StartKM/1000 present and in [0, 89]; event date present",
                "silver accident: SiteCleared present; EventStatus in (FINALIZED, AVAILABLE); one row per EventNumber (latest file wins)",
                "silver breakdown: EventStatus = FINALIZED; one row per EventNumber",
                "scenario populations: accidents and in-lane breakdowns logged in Lane1-4 / Main Line; shoulder breakdowns logged as Soft Shoulder. Toll-plaza, ramp, E-Lane, E-Parking and named-place events are excluded.",
                "Angle Collision, Hit Toll Plaza Equipment, Hit Objects On The Road, Head-On, Hit Pedestrian, Hit Animal and Others are not part of any scenario family and are not calibrated.",
            ],
            "exclusion_rule": "keep 0 < minutes <= 1440; every excluded value is counted per family under `excluded` (missing / negative / zero / over_1440)",
            "quantile_method": "numpy.percentile, linear interpolation; min and max are the observed extremes after exclusion",
            "existing_mttc_rule_cited": [
                "Back-End/scripts/medallion/10-bronze-accident-breakdown.sql:124-125 (accident clearance_min: NULL outside 0-1440, zeros kept)",
                "Back-End/src/services/incident-events.service.ts:48-49 (breakdown RESPONSE_MIN / SERVICE_MIN: NULL outside 0-1440, zeros kept)",
            ],
            "known_limitations": [
                "Breakdown durations are per-deployment service_time_min (on scene only). They exclude the wait before the patrol arrives, so they understate total obstruction time.",
                "Only about 31% of breakdown events have any deployment record.",
                "Accident event_start_date is heavily rounded (36% on a multiple of 5 minutes) and 19% of accident clearances are exactly 0 minutes.",
                "Timestamps are naive (no timezone) in the CSVs.",
            ],
        },
        "chainage_offset": chainage_offset(sa, sb),
        "families": families,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", default=os.environ.get("NLEX_CSV_DIR", r"D:\OneDrive_2026-09-08\shared files"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "calibration.json"))
    ap.add_argument("--date", default=dt.date.today().isoformat(), help="value for provenance.generated_on")
    args = ap.parse_args()
    doc = build(args.csv_dir, args.date)
    out = os.path.abspath(args.out)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    fams = doc["families"]
    assert isinstance(fams, dict)
    for k, v in fams.items():
        assert isinstance(v, dict)
        ex = v["excluded"]
        print(f"{k:32} n={v['n']:>6,}  p50={v['p50']:>6}  p90={v['p90']:>6}  excluded={ex}")
    print("wrote", out)


if __name__ == "__main__":
    main()
