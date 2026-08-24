# Changelog — Ver4-Merged-BE-FE-Kia

**Branch:** `Ver4-Merged-BE-FE-Kia`  
**Date:** August 25, 2026  
**Base:** `Ver3-Merged-BE-FE-Kia`  

---

## Summary

This version integrates **Incident Predictive Tab** (from `Incident-Predictive-Explanation`) and **Traffic Predictive Tab** (from `UPDATED-PREDICT-TRAFFIC-HANS9`) into the main dashboard, while preserving all existing descriptive tabs untouched.

---

## 🔧 Sidebar / Layout Changes

- Removed "SmartFlow NLEX" branding and "Where Traffic Meets Intelligence" tagline from sidebar
- Removed the close (✕) button from sidebar
- Adjusted sidebar top padding to `25px` for cleaner spacing
- Navigation items (ANALYTICS, OPERATIONS, PLANNING, ADMIN) now start at the top

---

## 📊 Descriptive Tab Enhancements (Traffic, Incidents, Emissions)

- **Direction & Split controls:** Direction filter and NB/SB split toggle now work together logically
- **Granularity gating:** Granularity options (hourly/daily/weekly/monthly) are gated based on the selected date range length
- **Date picker improvements:** Custom date range picker is bounded to available data, requires minimum 2 days, shows only years with data
- **Incidents & Emissions:** Now share the same hero filter row pattern as Traffic
- **Emissions:** Class filter and Show control are separated; hourly detail is now available
- **Trend labels:** Formatted for the selected granularity instead of raw bucket keys

---

## 🤖 Incident Predictive Tab (from `Incident-Predictive-Explanation`)

### New Components
| File | Description |
|------|-------------|
| `IncidentNarrative.tsx` | AI-generated narrative explanation of incident predictions |
| `incidentPredictive.shared.ts` | Shared types and utilities for incident prediction |
| `incident/hourly/page.tsx` | Hourly incident drill-down page |

### Updated Components
| File | Description |
|------|-------------|
| `PredictiveIncidentChart.tsx` | Major overhaul — click-to-drill, model selection, validation metrics |
| `incident.service.ts` | Heavily expanded backend service for incident prediction |
| `incident.controller.ts` | New prediction endpoints |
| `incident.routes.ts` | New API routes |
| `incident.validator.ts` | Input validation for prediction requests |

### New Backend Scripts
| File | Description |
|------|-------------|
| `train_incident_models.py` | Full ML training pipeline for incident prediction |
| `run_predictive_pipeline.py` | Runs the predictive pipeline |
| `model_results.txt` | Saved model training results |

### Wiring
- `incident/page.tsx` updated to pass `months`, `from`, `to`, `weather`, `onDataBoundsChange`, and `onWeatherApplicableChange` props to `PredictiveIncidentChart`
- Range and Weather filters now display on the Predictive tab
- URL query params are restored when navigating back from hourly drill-down

---

## 📈 Traffic Predictive Tab (from `UPDATED-PREDICT-TRAFFIC-HANS9`)

### New Components
| File | Description |
|------|-------------|
| `ModelNarrative.tsx` | AI model narrative breakdown with granularity aggregation |
| `WeatherEvidencePanel.tsx` | Weather integration evidence panel |
| `aggregateSeries.ts` | Time-series aggregation utility (daily/weekly/monthly) |
| `useThemeTokens.ts` | Theme token hook for consistent styling |

### Updated Components
| File | Description |
|------|-------------|
| `PredictiveVolumeChart.tsx` | Major overhaul — weather integration, model controls, auto-clamping, honest validation metrics (AIC/BIC) |
| `PredictiveCongestionChart.tsx` | Weather integration updates |
| `PredictiveEventChart.tsx` | Weather integration updates |
| `traffic.service.ts` | Expanded backend with weather-aware volume forecasting |
| `traffic.controller.ts` | New prediction endpoints |
| `traffic.routes.ts` | New API routes |

---

## ⚠️ Important Notes

- **Descriptive tabs are untouched** — all descriptive analytics for Traffic, Incidents, and Emissions remain exactly as they were
- **Backup branches exist** — `backup-before-incident-merge` and `backup-before-traffic-merge` can be used to revert if needed
- The predictive components require their respective backend services and ML models to be running for full functionality
