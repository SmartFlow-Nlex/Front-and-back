#!/usr/bin/env python3
"""
Builds ../calibration.json from the client's accident / breakdown CSV exports.

Read-only on the CSVs; writes only the JSON. Deterministic: the same files give the same bytes
(except `generated_on`, which can be pinned with --date).

    python build_calibration.py --csv-dir <folder holding accident_data_*.csv and breakdown_data_*.csv>
    python build_calibration.py --csv-dir <folder> --out ../calibration.json --date 2026-09-22 --min-n 200

    The folder can also come from the NLEX_CSV_DIR environment variable. There is no built-in default path.

WHAT IT COMPUTES
  Duration quantiles (min, p10 p25 p50 p75 p90 p99, max, and n) per scenario family:

    accident families   clearance = SiteCleared - event_start_date, minutes, one value per event.

    breakdown families  TOTAL = response + service, minutes, one value per EVENT (see EVENT RULE).
                        Also the RESPONSE SHARE = response / total, per event, as its own quantile set.

  Only positive durations up to 24 h are kept. Everything else is excluded AND counted, per entry:
    missing   - no usable value (blank / non-numeric timestamps or minutes, or recorded minutes that
                disagree with the timestamps by more than 1 minute)
    negative  - an end timestamp precedes its start
    zero      - exactly 0 minutes (for breakdowns: every usable record is a zero-length check-in)
    over_1440 - more than 24 h (the Incident module's own sanity cap)
  The 0-1440 window mirrors the existing MTTC rule (10-bronze-accident-breakdown.sql clearance_min;
  incident-events.service.ts RESPONSE_MIN / SERVICE_MIN). That rule KEEPS zeros; this file drops them
  because a zero-minute event is not an event a simulator can place. Reference blocks show what the
  existing rule would have produced.

EVENT RULE (breakdowns; a breakdown event can carry several deployment records)
  1. A record is USABLE when its three timestamps and both recorded minutes are present, the recorded
     minutes agree with the timestamps (within 1 min), no interval is negative, and each recorded
     figure is within 0-1440. Unusable records are ignored and counted.
  2. A usable record with dispatch = arrival = departure (0 min response AND 0 min service) is a
     zero-length CHECK-IN, not a responder attending. Check-ins are ignored for timing.
  3. From the remaining (substantive) records:
       t0 = earliest dispatch          a = earliest arrival          t1 = latest departure
       response = a - t0     (first responder's wait)
       service  = t1 - a     (first arrival to last departure; gaps between visits count as service,
                              because the obstacle is presumed present until the last departure)
       total    = t1 - t0 = response + service        share = response / total
  4. An event with no substantive record is excluded as `zero`. One whose total exceeds 24 h is
     excluded as `over_1440`.
  The clock starts at the first DISPATCH, not at the breakdown: any delay before dispatch is not
  recorded and is not in these numbers. `reference.total_including_check_in_records` shows the same
  totals when check-ins are kept in the span (rule B), so the effect of rule 2 is visible.

BREAKDOWN HIERARCHY
  Besides the family entry, entries are written for cause x vehicle, cause and vehicle, but ONLY where
  at least --min-n usable events exist (default 200, mirrored by LOW_SAMPLE_N in assumptions.ts).
  `hierarchy.cells` lists EVERY cell with its n, whether it qualified or not. The label mappings below
  are assumptions (mirrored in scenarios/assumptions.ts LABEL_MAPPINGS).

POPULATION RULES (re-implementation of Back-End/src/etl/cleaner.ts + transformer.ts + the silver SQL;
  on the 2026-09-08 CSVs this reproduces the DB's silver row counts exactly: 21,804 / 156,901)
  ETL accept : StartKM/1000 present and within [0, 89]; event date present
  silver     : accident  -> SiteCleared present, EventStatus in (FINALIZED, AVAILABLE), one row per EventNumber
               breakdown -> EventStatus = FINALIZED, one row per EventNumber
  scenario   : only events logged in a MAINLINE LANE (SubLocation Lane1-4 / Main Line) feed the in-lane
               families; Soft Shoulder feeds the shoulder family. Toll-plaza, ramp, E-Lane and E-Parking
               events are excluded (a plaza has no counterpart in the engine).
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
DEFAULT_MIN_N = 200
HIERARCHY_ORDER = ("cause_vehicle", "cause", "vehicle", "family")
CAUSES = ("tire", "engine", "mechanical", "fuel", "electrical")
VEHICLES = ("car", "bus", "truck")

ACCIDENT_FAMILIES: dict[str, dict[str, str]] = {
    # family key -> {TypeOfEvent value: variant}
    "minor_collision": {"Rear End": "rear_end", "Side Swipe": "sideswipe", "Hit and Run": "hit_and_run"},
    "multi_vehicle_collision": {"Multiple Collision": ""},
    "self_accident": {"Self Accident": ""},
}
# Label mappings: ASSUMPTIONS (mirrored in scenarios/assumptions.ts LABEL_MAPPINGS).
ELECTRICAL_SUBCAUSES = ("Battery", "Electrical", "Alternator", "Starter", "Wiring", "Spark Plug", "Contact Point")
VEHICLE_BY_TYPE = {"Truck": "truck", "Bus": "bus", "Sedan/Car": "car", "AUV": "car", "SUV": "car", "Van": "car", "Pick-Up": "car"}
CAUSE_BY_MAIN = {"Tire": "tire", "Engine": "engine", "Mechanical": "mechanical", "Fuel": "fuel"}


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
def classify(values: Iterable[float]) -> tuple[np.ndarray, dict[str, int]]:
    """Split raw minute values into the kept set (0 < x <= 1440) and per-reason exclusion counts."""
    x = np.asarray(list(values), dtype=float)
    missing = int(np.isnan(x).sum())
    v = x[~np.isnan(x)]
    kept = v[(v > 0) & (v <= 1440)]
    return kept, {"missing": missing, "negative": int((v < 0).sum()), "zero": int((v == 0).sum()), "over_1440": int((v > 1440).sum())}


def quantile_set(values: np.ndarray, digits: int = 2) -> dict[str, float]:
    if values.size == 0:
        raise SystemExit("empty set: refusing to write an unusable calibration")
    out: dict[str, float] = {"min": round(float(values.min()), digits)}
    for p, q in zip(QPOINTS, np.percentile(values, QPOINTS)):
        out[f"p{p}"] = round(float(q), digits)
    out["max"] = round(float(values.max()), digits)
    return out


def block(values: Iterable[float]) -> dict[str, object]:
    kept, excl = classify(values)
    return {"n": int(kept.size), "excluded": excl, **quantile_set(kept)}


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


# ----------------------------------------------------------------------------- accidents
def accident_entry(events: pd.DataFrame, label: str, population: str, level: str) -> dict[str, object]:
    clearance = ((events.SiteCleared_ts - events.ts).dt.total_seconds() / 60.0).tolist()
    blockage = ((events.BlockageCleared_ts - events.ts).dt.total_seconds() / 60.0).tolist()
    return {
        "label": label,
        "level": level,
        "duration_kind": "clearance_min",
        "duration_definition": "SiteCleared - event_start_date, minutes (per accident event)",
        "population": population,
        "n_events": int(len(events)),
        "n_values_before_exclusion": int(len(clearance)),
        **block(clearance),
        "response_share": None,
        "reference": {
            "not_used_by_sampler": True,
            "including_zeros_existing_rule": including_zeros(clearance),
            "blockage_min_positive": block(blockage),
            "lane_distribution": lane_distribution(events),
        },
    }


# ----------------------------------------------------------------------------- breakdowns
def cause_of(main: object, sub: object) -> str | None:
    if isinstance(main, str) and main in CAUSE_BY_MAIN:
        return CAUSE_BY_MAIN[main]
    if sub in ELECTRICAL_SUBCAUSES:
        return "electrical"
    return None


def record_table(events: pd.DataFrame) -> pd.DataFrame:
    """One row per deployment record, with parsed times and a validity reason."""
    rows = []
    for en, dep in zip(events.EN, events.deployments):
        for d in parse_deployments(dep):
            rows.append((en, d["dispatch_time"], d["arrival_time"], d["departure_time"], d["response_time_min"], d["service_time_min"]))
    r = pd.DataFrame(rows, columns=["EN", "dispatch", "arrival", "departure", "response_raw", "service_raw"])
    for c in ("dispatch", "arrival", "departure"):
        r[c + "_ts"] = pd.to_datetime(r[c].replace("", np.nan), errors="coerce")
    r["response"] = pd.to_numeric(r["response_raw"].replace("", np.nan), errors="coerce")
    r["service"] = pd.to_numeric(r["service_raw"].replace("", np.nan), errors="coerce")
    span_r = (r.arrival_ts - r.dispatch_ts).dt.total_seconds() / 60.0
    span_s = (r.departure_ts - r.arrival_ts).dt.total_seconds() / 60.0
    unusable = r.dispatch_ts.isna() | r.arrival_ts.isna() | r.departure_ts.isna() | r.response.isna() | r.service.isna()
    negative = ~unusable & ((span_r < 0) | (span_s < 0) | (r.response < 0) | (r.service < 0))
    big = ~unusable & ~negative & ((r.response > 1440) | (r.service > 1440))
    inconsistent = ~unusable & ~negative & ~big & (((r.response - span_r).abs() > 1) | ((r.service - span_s).abs() > 1))
    r["reason"] = np.select([unusable | inconsistent, negative, big], ["missing", "negative", "over_1440"], default="ok")
    r["substantive"] = (r.reason == "ok") & ((span_r > 0) | (span_s > 0))
    return r


def event_table(events: pd.DataFrame) -> pd.DataFrame:
    """One row per event that has at least one deployment record: status + response / service / total / share."""
    r = record_table(events)
    out: list[dict[str, object]] = []
    for en, g in r.groupby("EN", sort=False):
        ok = g[g.reason == "ok"]
        if ok.empty:
            reasons = set(g.reason)
            out.append({"EN": en, "status": next((x for x in ("missing", "negative", "over_1440") if x in reasons), "missing")})
            continue
        total_b = (ok.departure_ts.max() - ok.dispatch_ts.min()).total_seconds() / 60.0   # rule B: check-ins kept in the span
        sub = ok[ok.substantive]
        if sub.empty:
            out.append({"EN": en, "status": "zero", "total_b": total_b})
            continue
        t0, a, t1 = sub.dispatch_ts.min(), sub.arrival_ts.min(), sub.departure_ts.max()
        response = (a - t0).total_seconds() / 60.0
        service = (t1 - a).total_seconds() / 60.0
        total = response + service
        out.append({"EN": en, "status": "over_1440" if total > 1440 else "kept", "response": response, "service": service, "total": total,
                    "share": response / total, "n_records": int(len(g)), "n_substantive": int(len(sub)), "total_b": total_b})
    cols = ["EN", "status", "response", "service", "total", "share", "n_records", "n_substantive", "total_b"]
    return pd.DataFrame(out, columns=cols)


def spearman(a: pd.Series, b: pd.Series) -> float:
    return round(float(a.corr(b, method="spearman")), 3)


def breakdown_entry(events: pd.DataFrame, et: pd.DataFrame, records: pd.DataFrame, *, key_label: str, level: str, population: str, family_level: bool, lane_based: bool) -> dict[str, object]:
    """Entry for one population of breakdown events. `et` / `records` are the event and record tables for the whole silver set."""
    ev = et[et.EN.isin(events.EN)]
    kept = ev[ev.status == "kept"]
    excluded = {s: int((ev.status == s).sum()) for s in ("missing", "negative", "zero", "over_1440")}
    entry: dict[str, object] = {
        "label": key_label,
        "level": level,
        "duration_kind": "response_plus_service_min_per_event",
        "duration_definition": "first dispatch to last departure of the event's substantive deployment records = (first arrival - first dispatch) + (last departure - first arrival), minutes; one value per event",
        "population": population,
        "n_events": int(len(events)),
        "n_events_with_deployment_records": int(len(ev)),
        "n_values_before_exclusion": int(len(ev)),
        "n": int(len(kept)),
        "excluded": excluded,
        **quantile_set(kept.total.to_numpy(dtype=float)),
        "response_share": {"n": int(len(kept)), **quantile_set(kept.share.to_numpy(dtype=float), 4), "mean": round(float(kept.share.mean()), 4),
                           "fraction_exactly_1": round(float((kept.share == 1).mean()), 4)},
        "multi_record_events": int((kept.n_substantive > 1).sum()),
    }
    if family_level:
        rec = records[records.EN.isin(events.EN)]
        single, multi = kept[kept.n_substantive == 1].total, kept[kept.n_substantive > 1].total
        b_kept, b_excl = classify(ev.total_b.tolist() if "total_b" in ev else [])
        entry["reference"] = {
            "not_used_by_sampler": True,
            "service_only_per_deployment_record": {
                "note": "Phase 1 definition: service_time_min of every deployment record (arrival to departure), one value per RECORD. Excludes the wait for the responder.",
                **block(rec.service.tolist()),
                "including_zeros_existing_rule": including_zeros(rec.service.tolist()),
            },
            "total_including_check_in_records": {"note": "Rule B: zero-length check-in records kept in the first-dispatch to last-departure span.", "n": int(b_kept.size), "excluded": b_excl, **quantile_set(b_kept)},
            "response_only_per_event": quantile_set(kept.response.to_numpy(dtype=float)),
            "service_only_per_event": quantile_set(kept.service.to_numpy(dtype=float)),
            "spearman_total_vs_response_share": spearman(kept.total, kept.share),
            "single_vs_multi_record_events": {
                "single_n": int(single.size), "multi_n": int(multi.size),
                "single_p50": round(float(single.median()), 2), "single_p90": round(float(single.quantile(0.9)), 2),
                "multi_p50": round(float(multi.median()), 2), "multi_p90": round(float(multi.quantile(0.9)), 2),
            },
        }
        if lane_based:
            entry["reference"]["lane_distribution"] = lane_distribution(events)  # type: ignore[index]
    return entry


def hierarchy(sb_family: pd.DataFrame, et: pd.DataFrame, records: pd.DataFrame, family_key: str, family_label: str, min_n: int,
              families: dict[str, object], cells: list[dict[str, object]], lane_based: bool) -> None:
    """Family entry + cause x vehicle / cause / vehicle entries (only where n >= min_n) + a row per cell."""
    kept_by_en = set(et[et.status == "kept"].EN)

    def kept_n(sub: pd.DataFrame) -> int:
        return int(sub.EN.isin(kept_by_en).sum())

    fam_entry = breakdown_entry(sb_family, et, records, key_label=family_label, level="family", population=f"{family_label}: all breakdown events in the population", family_level=True, lane_based=lane_based)
    families[family_key] = fam_entry
    cells.append({"family": family_key, "level": "family", "cause": None, "vehicle": None, "n": fam_entry["n"], "qualifies": True})

    def cell(level: str, cause: str | None, vehicle: str | None) -> None:
        sub = sb_family
        if cause is not None:
            sub = sub[sub.cause == cause]
        if vehicle is not None:
            sub = sub[sub.vehicle == vehicle]
        n = kept_n(sub)
        qualifies = n >= min_n
        cells.append({"family": family_key, "level": level, "cause": cause, "vehicle": vehicle, "n": n, "qualifies": qualifies})
        if not qualifies:
            return
        parts = [family_key] + ([f"cause_{cause}"] if cause else []) + ([f"vehicle_{vehicle}"] if vehicle else [])
        what = ", ".join(x for x in (f"cause = {cause}" if cause else "", f"vehicle = {vehicle}" if vehicle else "") if x)
        families["__".join(parts)] = breakdown_entry(sub, et, records, key_label=f"{family_label} ({what})", level=level, population=f"{family_label}, {what}", family_level=False, lane_based=lane_based)

    for c in CAUSES:
        for v in VEHICLES:
            cell("cause_vehicle", c, v)
    for c in CAUSES:
        cell("cause", c, None)
    for v in VEHICLES:
        cell("vehicle", None, v)


# ----------------------------------------------------------------------------- chainage
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


# ----------------------------------------------------------------------------- build
def build(csv_dir: str, date: str, min_n: int) -> dict[str, object]:
    ra, files_a = read_family(csv_dir, "accident")
    rb, files_b = read_family(csv_dir, "breakdown")
    sa, sb = silver("accident", etl_accept(ra)), silver("breakdown", etl_accept(rb))
    sb = sb.copy()
    sb["cause"] = [cause_of(m, s) for m, s in zip(sb.MainCause, sb.SubCause)]
    sb["vehicle"] = sb.TypeOfVehicle.map(VEHICLE_BY_TYPE)

    families: dict[str, object] = {}
    cells: list[dict[str, object]] = []

    lane_a = sa[sa.SubLocation.isin(LANES)]
    minor_all = lane_a[lane_a.TypeOfEvent.isin(ACCIDENT_FAMILIES["minor_collision"])]
    families["minor_collision"] = accident_entry(minor_all, "Minor collision (rear-end + side-swipe + hit-and-run)",
                                                 "accident events with TypeOfEvent in (Rear End, Side Swipe, Hit and Run) logged in a mainline lane", "family")
    for toe, variant in ACCIDENT_FAMILIES["minor_collision"].items():
        families[f"minor_collision_{variant}"] = accident_entry(lane_a[lane_a.TypeOfEvent == toe], f"Minor collision: {variant}", f"TypeOfEvent = {toe}, logged in a mainline lane", "label")
    families["multi_vehicle_collision"] = accident_entry(lane_a[lane_a.TypeOfEvent == "Multiple Collision"], "Multi-vehicle collision", "TypeOfEvent = Multiple Collision, logged in a mainline lane", "family")
    families["self_accident"] = accident_entry(lane_a[lane_a.TypeOfEvent == "Self Accident"], "Self accident", "TypeOfEvent = Self Accident, logged in a mainline lane", "family")

    in_lane = sb[sb.SubLocation.isin(LANES)]
    shoulder = sb[sb.SubLocation == "Soft Shoulder"]
    pop = pd.concat([in_lane, shoulder])
    et = event_table(pop)
    records = record_table(pop)
    hierarchy(in_lane, et, records, "breakdown_in_lane", "Breakdown in a lane", min_n, families, cells, lane_based=True)
    hierarchy(shoulder, et, records, "breakdown_shoulder", "Breakdown on the shoulder", min_n, families, cells, lane_based=False)

    n_in = int(et.EN.isin(in_lane.EN).sum())
    n_sh = int(et.EN.isin(shoulder.EN).sum())
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
                "accident_mainline_lane_events": int(len(lane_a)), "breakdown_mainline_lane_events": int(len(in_lane)),
                "breakdown_soft_shoulder_events": int(len(shoulder)),
                "breakdown_mainline_lane_events_with_deployment_records": n_in, "breakdown_soft_shoulder_events_with_deployment_records": n_sh,
            },
            "silver_reproduction_note": "The ETL + silver rules below reproduce the database's silver row counts recorded on 2026-09-21 (21,804 accidents / 156,901 breakdowns) exactly. The database itself was unreachable when this file was generated, so no live query was run.",
            "population_rules": [
                "ETL accept: StartKM/1000 present and in [0, 89]; event date present",
                "silver accident: SiteCleared present; EventStatus in (FINALIZED, AVAILABLE); one row per EventNumber (latest file wins)",
                "silver breakdown: EventStatus = FINALIZED; one row per EventNumber",
                "scenario populations: accidents and in-lane breakdowns logged in Lane1-4 / Main Line; shoulder breakdowns logged as Soft Shoulder. Toll-plaza, ramp, E-Lane, E-Parking and named-place events are excluded.",
                "Angle Collision, Hit Toll Plaza Equipment, Hit Objects On The Road, Head-On, Hit Pedestrian, Hit Animal and Others are not part of any scenario family and are not calibrated.",
            ],
            "exclusion_rule": "keep 0 < minutes <= 1440; every excluded value is counted per entry under `excluded` (missing / negative / zero / over_1440)",
            "breakdown_event_rule": [
                "usable record: three timestamps + both recorded minutes present, minutes agree with the timestamps within 1 min, no negative interval, each figure within 0-1440",
                "zero-length check-in record (dispatch = arrival = departure) is ignored for timing",
                "t0 = earliest dispatch, a = earliest arrival, t1 = latest departure over the remaining records",
                "response = a - t0; service = t1 - a (gaps between visits count as service); total = response + service; response_share = response / total",
                "no substantive record -> excluded as zero; total > 1440 -> excluded as over_1440",
                "the clock starts at the first dispatch, not at the breakdown itself: any delay before dispatch is not recorded",
            ],
            "hierarchy": {"min_n": min_n, "fallback_order": list(HIERARCHY_ORDER), "n_counts": "usable (kept) events", "cells": cells},
            "quantile_method": "numpy.percentile, linear interpolation; min and max are the observed extremes after exclusion",
            "existing_mttc_rule_cited": [
                "Back-End/scripts/medallion/10-bronze-accident-breakdown.sql:124-125 (accident clearance_min: NULL outside 0-1440, zeros kept)",
                "Back-End/src/services/incident-events.service.ts:48-49 (breakdown RESPONSE_MIN / SERVICE_MIN: NULL outside 0-1440, zeros kept)",
            ],
            "known_limitations": [
                "Breakdown totals start at the first dispatch, not at the breakdown, so they still understate total obstruction time.",
                f"Only {100 * n_in / max(1, len(in_lane)):.0f}% of in-lane and {100 * n_sh / max(1, len(shoulder)):.0f}% of shoulder breakdown events have any deployment record.",
                "A p99 taken from about 200 events rests on two observations: the sampler's default cap is noisy for the smallest hierarchy cells.",
                "Accident event_start_date is heavily rounded (36% on a multiple of 5 minutes) and 19% of accident clearances are exactly 0 minutes.",
                "Timestamps are naive (no timezone) in the CSVs.",
            ],
        },
        "chainage_offset": chainage_offset(sa, sb),
        "families": families,
    }


def main() -> None:
    env_dir = os.environ.get("NLEX_CSV_DIR")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", default=env_dir, required=env_dir is None,
                    help="folder containing accident_data_*.csv and breakdown_data_*.csv (or set NLEX_CSV_DIR)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "calibration.json"), help="output path (default: ../calibration.json)")
    ap.add_argument("--date", default=dt.date.today().isoformat(), help="value for provenance.generated_on")
    ap.add_argument("--min-n", type=int, default=DEFAULT_MIN_N, help="minimum usable events for a hierarchy entry (default 200; keep equal to LOW_SAMPLE_N in assumptions.ts)")
    args = ap.parse_args()
    if not os.path.isdir(args.csv_dir):
        raise SystemExit(f"--csv-dir is not a folder: {args.csv_dir}")
    doc = build(args.csv_dir, args.date, args.min_n)
    out = os.path.abspath(args.out)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    fams = doc["families"]
    assert isinstance(fams, dict)
    for k, v in fams.items():
        assert isinstance(v, dict)
        print(f"{k:58} n={v['n']:>6,}  p50={v['p50']:>7}  p90={v['p90']:>7}  p99={v['p99']:>8}")
    print(f"{len(fams)} entries; wrote {out}")


if __name__ == "__main__":
    main()
