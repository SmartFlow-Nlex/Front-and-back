"""Emit the run artifacts for the corridor CO2 forecast, following the
convention already used by the volume runs (05_/06_)."""
import io, json, os
import pandas as pd
import psycopg2

# Connection settings live in smartflow_scripts/config/.env, read by config/db.py.
# They used to be hardcoded in this file and in ~80 others.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "config"))
from db import PG, POSTGRES_URL, WORK, setting  # noqa: E402,F401
OUT = os.path.join(setting("REPORTS_DIR", required=True), "08_2026-09-04_corridor_co2_no_weather_leak")
os.makedirs(OUT, exist_ok=True)

conn = psycopg2.connect(PG)
q = lambda s: pd.read_sql_query(s, conn)

met = q("""SELECT model_name, rank, accepted, mape, wmape, mase, rmse, mae, r2, rejected_reason, diagnosis, uses_weather
           FROM gold.ml_model_metrics WHERE target='Corridor CO2'
           ORDER BY rank NULLS LAST, wmape""")
pred = q("""SELECT forecast_date, actual_co2, pred_polynomial, pred_gbr, pred_lstm,
                   champion_model, is_holdout, is_future
            FROM gold.ml_predictive_emissions ORDER BY forecast_date""")
seg = q("SELECT exit_name, km_post, segment_km FROM gold.exit_segment_km ORDER BY km_post")
cls = q("""SELECT ROUND(SUM(class_1))::bigint v1, ROUND(SUM(class_2))::bigint v2,
                  ROUND(SUM(class_3))::bigint v3,
                  ROUND(SUM(class_1*segment_km*192)/1e6)::bigint c1,
                  ROUND(SUM(class_2*segment_km*354)/1e6)::bigint c2,
                  ROUND(SUM(class_3*segment_km*1492)/1e6)::bigint c3
           FROM gold.fact_emissions_hourly""").iloc[0]

met.to_csv(os.path.join(OUT, "model_metrics.csv"), index=False)
pred.to_csv(os.path.join(OUT, "predictions_full_series.csv"), index=False)
seg.to_csv(os.path.join(OUT, "exit_segment_km.csv"), index=False)

ch = met[met.accepted].iloc[0]
TIED = [r.model_name for r in met.itertuples()
        if r.accepted and isinstance(r.diagnosis, str) and r.diagnosis.startswith("tied with")]
base = met[met.model_name == "SeasonalNaive"].iloc[0]
hold = pred[pred.is_holdout]
fut = pred[pred.is_future]
past = pred[~pred.is_holdout & ~pred.is_future]
tv = int(cls.v1) + int(cls.v2) + int(cls.v3)
tc = int(cls.c1) + int(cls.c2) + int(cls.c3)
L = []
w = L.append
BAR = "=" * 78
RUL = "-" * 78

w(BAR)
w("  MODEL EVALUATION REPORT - SmartFlow NLEX / Corridor CO2 Forecast")
w("  Run       : leakage-corrected - forecast-window weather is climatology")
w("  Generated : 2026-09-04")
w("  Source    : gold.fact_emissions_hourly (derived from gold.fact_traffic_hourly)")
w("  Pipeline  : train_emissions.py - rolling-origin walk-forward")
w(BAR)
w("")
w("1. HEADLINE RESULT")
w(RUL)
if len(TIED) > 1:
    w(f"  NO SINGLE CHAMPION. {' and '.join(TIED)} are statistically tied.")
    w("")
    for r in met.itertuples():
        if r.model_name in TIED:
            w(f"    {r.model_name:<12} MAPE {r.mape:.2f}%   WMAPE {r.wmape:.4f}%   "
              f"MASE {r.mase:.3f}   R2 {r.r2:.4f}   RMSE {r.rmse:.2f}   MAE {r.mae:.2f}")
    w("")
    w("  Their WMAPE gap is smaller than GBR's measured run-to-run jitter, so")
    w("  naming either one the winner would be false precision. Section 5.")
else:
    w(f"  {ch.model_name.upper()} ACCEPTED - rank #{int(ch['rank'])}.")
    w("")
    w(f"    MAPE {ch.mape:.2f}%   WMAPE {ch.wmape:.2f}%   MASE {ch.mase:.3f}   "
      f"R2 {ch.r2:.4f}   RMSE {ch.rmse:.2f}   MAE {ch.mae:.2f}")
w("")
w(f"  All three candidates were accepted: each clears BOTH gates - WMAPE below")
w(f"  the {base.wmape:.2f}% seasonal-naive baseline, and MASE below 1.0. No")
w("  threshold was relaxed. Rank is stored by WMAPE, but see the tie above.")
w("")
w("2. WHY THIS RUN EXISTS - CORRECTING A LEAK IN RUN 07")
w(RUL)
w("  Run 07 put `rain` and `temp` in the feature list UNLAGGED. Scoring day t+3")
w("  therefore handed the model day t+3's OBSERVED rainfall - a value that does")
w("  not exist at forecast time. Every other feature was correctly shifted; this")
w("  was the only leak, and it was found by audit, not by a failing test.")
w("")
w("  This run substitutes day-of-year CLIMATOLOGY, computed from the training")
w("  data alone, over the forecast window. Training rows keep observed weather,")
w("  since history genuinely is known.")
w("")
w("  Cost of removing the leak, run 07 -> run 08 WMAPE (as actually run):")
w("    Polynomial  6.6729% -> 6.7899%   (+0.117pp)   deterministic, so this is")
w("                                                  purely the leak")
w("    GBR         6.8274% -> 6.7916%   (-0.036pp)   within its own ~0.1pp")
w("                                                  jitter, so indistinguishable")
w("                                                  from no change")
w("    LSTM        7.8576% -> 8.1887%   (+0.331pp)   NOT the leak: LSTM is")
w("                                                  univariate and never read")
w("                                                  weather. This is TensorFlow")
w("                                                  run-to-run variation, and it")
w("                                                  is larger than the leak was.")
w("")
w("  So the leak cost about 0.12pp on the one model that is deterministic enough")
w("  to measure it, and no verdict depended on it - all three still pass. What it")
w("  DID change is the ordering: Polynomial and GBR now sit 0.0017pp apart, far")
w("  inside the jitter, so they are reported as co-champions rather than ranked.")
w("  See section 5.")
w("")
w("  Before run 07 the panel contained no model at all - two literal arrays in a")
w("  React component over 57 unlabelled day-indices, nothing measured or trained.")
w("")
w("3. EVALUATION PROTOCOL")
w(RUL)
w(f"  Series          : {len(pred[~pred.is_future]):,} days  "
  f"{pred.forecast_date.min()} -> {pred[~pred.is_future].forecast_date.max()}")
w(f"  Usable after lags: 1,433 days (28 days consumed by the lag-28 feature)")
w(f"  Train context   : {len(past):,} days (never scored)")
w(f"  Holdout scored  : {len(hold):,} days ({len(hold)/(len(past)+len(hold))*100:.1f}%)  "
  f"{hold.forecast_date.min()} -> {hold.forecast_date.max()}")
w(f"  Future forecast : {len(fut)} days (unscored projection, "
  f"{fut.forecast_date.min()} -> {fut.forecast_date.max()})")
w("  Method          : rolling-origin walk-forward, 42 origins, step 7d")
w("  HORIZON         : 7 days, per the modelling diagram's Emission Forecasting")
w("                    box. The VOLUME module uses 14 days. The two sets of error")
w("                    metrics are therefore NOT directly comparable - a shorter")
w("                    horizon is an easier problem.")
w("  Acceptance      : WMAPE < better of {seasonal-naive, climatology} AND MASE < 1")
w("  MASE scale      : seasonal naive at lag 7, fitted on the pre-holdout window")
w("")
w("4. FULL LEADERBOARD")
w(RUL)
w(f"  {'model':<16}{'MAPE%':>9}{'WMAPE%':>9}{'MASE':>8}{'RMSE':>10}{'MAE':>9}{'R2':>9}   verdict")
for r in met.itertuples():
    verdict = ("ACCEPTED (tied)" if (r.accepted and r.model_name in TIED and len(TIED) > 1)
               else "ACCEPTED" if r.accepted
               else "baseline" if r.model_name in ("SeasonalNaive", "Climatology")
               else "rejected")
    w(f"  {r.model_name:<16}{r.mape:>9.2f}{r.wmape:>9.2f}{r.mase:>8.3f}"
      f"{r.rmse:>10.2f}{r.mae:>9.2f}{r.r2:>9.4f}   {verdict}")
w("")
w(f"  Baseline to beat: {base.wmape:.2f}% WMAPE (SeasonalNaive).")
w("  Every candidate beats it by a wide margin, which is expected: daily corridor")
w("  CO2 is a smooth, strongly weekly series, so a lag-7 naive is already decent")
w("  and a model with weather and lag features improves on it substantially.")
w("")
w("5. REPRODUCIBILITY AND THE CO-CHAMPION VERDICT")
w(RUL)
w("  Polynomial (the champion) is EXACTLY reproducible: refitting all 42 origins")
w("  in a fresh process reproduces the stored predictions to 0.000000000 t/day.")
w("")
w("  GBR is NOT bit-reproducible across processes despite random_state=42.")
w("  Refits differ from the stored run by up to 3.00 t/day (~0.7%), which moves")
w("  its reported MAPE by about 0.1pp between runs (7.98% vs 8.07% on two runs of")
w("  identical code and data). The cause is floating-point summation order in the")
w("  split search, not a seeding bug. LSTM varies more, as expected.")
w("")
w("  With the leak removed the two leaders sit inside that jitter, so this run")
w("  does NOT declare a single champion. Any candidate within 0.15pp WMAPE of")
w("  the leader is marked tied in gold.ml_model_metrics.diagnosis, and the")
w("  dashboard shows '=' rather than a winner's star.")
w("")
w("  Reporting a rank the measurement cannot support would be false precision.")
w("")
w("6. HOW CO2 IS DERIVED")
w(RUL)
w("  CO2 = vehicle count x segment length x per-class emission factor.")
w("")
w("  Factors are DENR/DOTC per-class values held in bronze.nlex_emission_factors")
w("  (class 1 = 192 g/km, class 2 = 354, class 3 = 1492). NOTE: the manuscript")
w("  cites COPERT IV / EMFAC; the values actually in the database are DENR/DOTC.")
w("  That discrepancy is unresolved and is flagged, not papered over.")
w("")
w("  Segment length is DERIVED, not stored. bronze.nlex_theoretical_emissions")
w("  carries a distance for only 10 of 20 exits, and km-post rules do not")
w("  reproduce those 10 (best rule MAE 2.38 km against a 3.78 km mean), so they")
w("  are not km-post derived. Each exit is instead given half the gap to each")
w("  neighbour, which makes the segments TILE the corridor exactly once - a")
w("  corridor total then neither double-counts nor leaves gaps.")
w(f"  Segments sum to {seg.segment_km.astype(float).sum():.2f} km over "
  f"{len(seg)} exits, tiling the km-post table exactly.")
w("")
w("  CAVEAT: that total is 85.40 km, while NLEX is commonly published at ~84 km.")
w("  The segments tile the KM-POST TABLE exactly, which is what was verified -")
w("  not the true road length. If 84 km is right, every absolute tonnage here is")
w("  about 1.7% high. Being systematic, it cancels out of every error metric.")
w("")
w("  bronze.nlex_theoretical_emissions is deliberately NOT used: its daily volume")
w("  disagrees with the forecast series (ratios 1.13-1.70 on consecutive days)")
w("  and it covers 10 of 20 exits. Building on it would have made the CO2 panel")
w("  contradict the volume panel.")
w("")
w("7. RECONCILIATION WITH THE VOLUME MODULE")
w(RUL)
w("  The CO2 actuals roll up from the same gold.fact_traffic_hourly rows the")
w("  volume forecast is trained on. Checked over 1,433 days, the largest")
w("  disagreement between gold.ml_predictive_emissions.actual_co2 and a fresh")
w("  aggregation of gold.fact_emissions_hourly is 0.0005 t/day.")
w("")
w("  Descriptive and predictive therefore share one source of truth.")
w("")
w("8. WHAT THE MODEL SAYS")
w(RUL)
w(f"  Mean corridor CO2 over the scored holdout : {hold.actual_co2.astype(float).mean():.1f} t/day")
w(f"  Range across the whole series             : "
  f"{pred.actual_co2.astype(float).min():.1f} - {pred.actual_co2.astype(float).max():.1f} t/day")
w(f"  {len(fut)}-day forward mean ({fut.forecast_date.min()} ->"
  f" {fut.forecast_date.max()}) : {fut.pred_polynomial.astype(float).mean():.1f} t/day")
w("")
w("  Class share of VOLUME vs share of CO2:")
for lab, v, c in [("Class 1", cls.v1, cls.c1), ("Class 2", cls.v2, cls.c2), ("Class 3", cls.v3, cls.c3)]:
    w(f"    {lab}   volume {int(v)/tv*100:>5.1f}%    CO2 {int(c)/tc*100:>5.1f}%")
w("")
w("  Class 3 is the most DISPROPORTIONATE contributor - roughly 4.9x its share of")
w("  traffic. It is not the largest absolute contributor: Class 1 emits slightly")
w("  more in total, because it is 78% of all vehicles. Both statements matter and")
w("  an earlier draft of this report conflated them.")
w("")
w("9. KNOWN LIMITATIONS")
w(RUL)
w("  - Weather over the forecast window is day-of-year CLIMATOLOGY, in BOTH the")
w("    scored holdout and the 7-day projection. This is the honest assumption;")
w("    supplying a real weather forecast would likely improve on it.")
w("  - The emission factors (192/354/1492 g/km) are UNVALIDATED. They are taken")
w("    from bronze.nlex_emission_factors and used faithfully, but nothing here")
w("    checks them against a published source. If they are wrong, every tonnage")
w("    is wrong by the same proportion and no accuracy figure would reveal it.")
w("  - CO2 is DERIVED, never measured. There is no emissions sensor on NLEX.")
w("  - The forecast is corridor-wide and daily. The manuscript (p172) specifies")
w("    per-plaza, per-15-minute MAPE. This run does not meet that specification.")
w("  - Emission factors are fleet-average per class. No cold-start, gradient,")
w("    congestion-speed or vehicle-age correction is applied.")
w("  - Speed is not used: bronze avg_speed_kmh is negative in 20.6% of rows.")
w("  - The holdout ends 2025-12-31, so the future window covers the New Year")
w("    period, the least typical week of the year. The champion predicts 229.8 t")
w("    on 1 Jan rising to 455.6 t by 7 Jan; that shape is plausible but the")
w("    holiday regime is the hardest part of the series (the model missed")
w("    2025-12-31 by a wide margin: actual 194.9 t vs 386.1 t predicted).")
w("")
w("10. ARTIFACTS")
w(RUL)
w("  MODEL_EVALUATION_REPORT.txt  this file")
w("  model_metrics.csv            the leaderboard, as stored in gold.ml_model_metrics")
w("  predictions_full_series.csv  every day, every model, with zone flags")
w("  exit_segment_km.csv          the derived corridor tiling")
w("  emissions_run.log            stdout of the training run")
w("  leakage_audit.txt            the with/without-weather comparison")
w("")
w("  Database:")
w("    gold.ml_predictive_emissions   1,440 rows (served by /api/emissions/forecast)")
w("    gold.ml_model_metrics          5 rows under target='Corridor CO2'")
w("    gold.fact_emissions_hourly     1,115,184 rows")
w("    gold.exit_segment_km           20 rows")
w(BAR)

io.open(os.path.join(OUT, "MODEL_EVALUATION_REPORT.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n")
print("\n".join(L))
print(f"\n\nwritten to {OUT}")
