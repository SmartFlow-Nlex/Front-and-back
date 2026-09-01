# Changelog — Ver5-Merged-BE-FE-Kia

**Branch:** `Ver5-Merged-BE-FE-Kia`  
**Date:** September 1, 2026  
**Base:** `Ver4-Merged-BE-FE-Kia` (via `With-Unfinished-New-Map-Kia`)

---

## Summary

This version incorporates two major sets of updates:
1. **Interactive Live Map Enhancements** (from `With-Unfinished-New-Map-Ysa` & `With-Unfinished-New-Map-Ysa2`)
2. **Corridor Correlation Forecasts** for Incidents (from `Incident-Predictive-Jertz2`)

---

## 🗺️ Interactive Live Map Updates

### Enhancements
- **Clickable Waze Reports**: Incident icons on the Waze Live Map are now fully clickable and open a detailed side panel/modal.
- **Data Consistency**: Fixed the mapping data so the live map agrees with the underlying waze reports structure.
- **Smart Connect Interchange**: Drew the Smart Connect interchange on the map geometry.
- **Corridor Smoothing**: Stopped smoothing the corridor shape so it aligns precisely with the road map.
- **Report Filtering**: Uncorroborated / disputed Waze reports are now drawn faintly or dropped entirely for better clarity.
- **Hover Details**: Hovering over a report icon now accurately states the carriageway (Northbound/Southbound).

### Key Files Changed
- `TrafficMapPanel.tsx` (Major overhaul for interactivity)
- `map-live.service.ts` (Backend endpoint extensions)
- `WazeLiveModal.tsx` (UI for the live report details)
- `nlex-corridor.ts` (New backend shape utility)
- `corridor-shape.ts`

---

## 🤖 Incident Predictive Enhancements

### New Features
- **Predictive Corridor Chart**: A new chart card (`PredictiveCorridorChart`) added below the main Incident Forecast. This chart visualizes the predicted spread of incidents across the NLEX corridor segments.
- **Incident Correlation**: Correlated incident forecasts with underlying traffic volume trends.

### Key Files Changed
- `PredictiveCorridorChart.tsx` (New UI Component)
- `incident/page.tsx` (Surgically wired the new chart and state *without* touching the Descriptive Tab)
- `incident.service.ts` & `incident.validator.ts` (Backend prediction logic updates)
- `train_incident_models.py` (Retrained Python models for volume correlation)

---

## ⚠️ Important Notes

- Just like in Ver4, **Descriptive tabs remain completely untouched**. The `page.tsx` files were merged surgically to ensure none of the descriptive analytics layouts were broken.
- Requires both the Next.js frontend and Express backend to be running to fetch the real-time Mapbox layers and Python ML endpoints.
