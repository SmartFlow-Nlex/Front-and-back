#!/usr/bin/env python3
"""How stable is a p99 estimated from n events?  Evidence for ASSUMPTIONS.CAP_MIN_N.

Bootstraps the per-event breakdown totals (response + service, minutes) that
build_calibration.py produces, at several sample sizes, and reports how much the
p99 estimate moves.  Read-only; seeded, so it prints the same numbers every run.

    python p99_stability.py --csv-dir <folder holding the accident/breakdown CSVs>
    (or set NLEX_CSV_DIR)
"""
import argparse
import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

SIZES = (100, 200, 500, 1000, 2000)
RESAMPLES = 3000
SEED = 2026


def load_generator():
    """build_calibration.py sits beside this file; import it by path so its own rules are the ones used."""
    path = Path(__file__).with_name("build_calibration.py")
    spec = importlib.util.spec_from_file_location("build_calibration", path)
    if spec is None or spec.loader is None:
        sys.exit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    env_dir = os.environ.get("NLEX_CSV_DIR")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", default=env_dir, required=env_dir is None, help="folder holding the CSV exports")
    args = ap.parse_args()

    bc = load_generator()
    raw, _ = bc.read_family(args.csv_dir, "breakdown")
    silver = bc.silver("breakdown", bc.etl_accept(raw))
    in_lane = silver[silver.SubLocation.isin(bc.LANES)]
    shoulder = silver[silver.SubLocation == "Soft Shoulder"]
    events = bc.event_table(pd.concat([in_lane, shoulder]))
    rng = np.random.default_rng(SEED)

    for name, fam in (("in-lane", in_lane), ("shoulder", shoulder)):
        totals = events[(events.status == "kept") & events.EN.isin(fam.EN)].total.to_numpy()
        print(f"\n{name}: population n={len(totals)}, p99 of all = {np.percentile(totals, 99):.1f}")
        print("   n     | mean p99 | sd of p99 | relative sd | 90% of estimates between")
        for n in SIZES:
            est = np.array([np.percentile(rng.choice(totals, n, replace=True), 99) for _ in range(RESAMPLES)])
            lo, hi = np.percentile(est, [5, 95])
            print(f"  {n:>5}  | {est.mean():8.1f} | {est.std():9.1f} | {100 * est.std() / est.mean():9.1f}% | {lo:.0f} - {hi:.0f}")


if __name__ == "__main__":
    main()
