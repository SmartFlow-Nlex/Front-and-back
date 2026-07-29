# Deprecated — first-generation pipeline

Everything in this folder is superseded by the live pipeline in the parent
directory (`12_extract_incidents_only.py` → `13_train_incident_models.py` →
`14_spatial_models.py` → `11_publish_rf_to_dashboard.py` /
`17_publish_analytics_to_aws.py`, sharing `incident_metrics.py`). None of
these files are imported or invoked by anything live. Do not run them.

| File | Why it's dead |
|---|---|
| `01_dataset_builder_aws.py` | Builds a coarse top-15-location grid; superseded by `12_extract_incidents_only.py`'s bronze-table extraction. |
| `01_dataset_builder_CORRIDOR_WIDE_DEPRECATED.py` | Already marked deprecated by a previous author; moved here for consistency. |
| `01_train_test_split.py` | Naive random-order 80/20 split; superseded by the expanding-window walk-forward splits in `13_train_incident_models.py` / `14_spatial_models.py`. |
| `02_model_random_forest.py`, `03_model_negative_binomial.py`, `04_model_gwr.py`, `05_model_spatial_lstm.py`, `08_model_xgboost.py`, `09_model_ordinal_logistic.py`, `10_model_gru.py` | Single static-split model scripts reading `output/train_incident.csv` / `test_incident.csv`. Superseded by the walk-forward candidates trained in `13_train_incident_models.py` / `14_spatial_models.py`. Harmless to leave unrun — they only write to the local `output/` folder, never to AWS. |
| `04_eval_compare.py` | Compares only 2 of the legacy models; superseded by the full 7+2 model ranking in `14_spatial_models.py` / `INCIDENT_MODEL_REPORT.txt`. |
| `06_evaluate_and_select_DEPRECATED.py` | **Do not run.** Overwrites the live `ml_predictive_incidents` / `ml_training_metadata` AWS tables with a fabricated sine-wave forecast. Hard-disabled with a `SystemExit` guard at the top of the file. |
| `07_prof_evaluation_DEPRECATED.py` | **Do not run.** Its overfitting diagnostic (`Train_R2`) is randomized, not measured, and its Cox PH rejection is staged rather than real. Hard-disabled with a `SystemExit` guard at the top of the file. |

Verified 2026-07-28 against the live AWS RDS instance: `ml_training_metadata`
(1 row, `champion_model = XGBoost`, `metrics_source = "3-fold expanding-window
walk-forward"`), `ml_predictive_incidents` (60 validation + 30 future rows for
XGBoost only), and `ml_model_evaluation` (one run, all 9 models matching
`INCIDENT_MODEL_REPORT.txt` exactly) all match `11_publish_rf_to_dashboard.py`
/ `17_publish_analytics_to_aws.py`'s expected output shape — no trace of this
folder's scripts ever having run against production.
