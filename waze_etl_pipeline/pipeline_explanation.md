# NLEX SmartFlow Waze Live Ingestion Pipeline Guide

This document provides a summary of how the traffic data ingestion pipeline is designed, how the NLEX corridor geofencing works, and how to explain it to your professor.

---

## 💡 Part 1: The Simple Explanation (Conversational / Academic Pitch)

> *"Every 2 minutes, our system automatically downloads live traffic reports from Waze. It checks the GPS coordinates of each report, and if it's not on NLEX (further than 100 meters away), it throws it away. If it is on NLEX, it saves it to our database, calculates how long the issue lasted, and updates a fast-access memory cache (Redis) so our dashboard website loads instantly."*

### The 4 Simple Steps of the Pipeline

1. **Get the Data**:
   Every 2 minutes, AWS Lambda (our background automated timer) fetches the raw traffic feed from Waze.
2. **Filter Out Extraneous Reports (The Geofence)**:
   We check the latitude and longitude of each traffic report against our NLEX map. If a report is **not** on the highway (further than 100 meters away), the code ignores it. If it is on NLEX, we save it.
3. **Calculate Duration**:
   If an accident disappears from the Waze feed, our code marks it as "cleared" in the database and calculates exactly how many minutes it took to resolve (Mean Time to Clear).
4. **Speed Up the Website (The Cache)**:
   Instead of having our website search through the heavy database every time a user refreshes, the code writes a clean list of *only* active NLEX incidents to a fast-memory store (Redis). The website reads from Redis, making it load instantly.

### The Guard Analogy (Great for oral presentations!)
> *"Think of the pipeline like a security guard at NLEX:
> 1. Waze throws a pile of mail (traffic reports) over the gate.
> 2. The guard looks at each letter's address. If the address is not on NLEX, the guard throws it in the trash.
> 3. If the address is on NLEX, the guard files it in the cabinet (Database).
> 4. When a problem is fixed, the guard writes down how long it took.
> 5. Finally, the guard posts a quick summary list on a whiteboard (Redis) so anyone passing by can read it instantly without digging through the filing cabinets."*

---

## 🛠️ Part 2: The Technical Explanation (For Deep Dives)

### Architectural Flow
1. **Extraction & Validation**:
   `waze_etl.py` fetches the Waze feed, auto-detects if the format is XML or JSON, and parses it.
2. **Bronze Layer (Staging)**:
   The raw JSON is archived as-is in PostgreSQL tables `bronze_waze_alerts` and `bronze_waze_jams` (stored as `JSONB`) for audits and data lineage.
3. **Silver Layer (Geofencing & Normalization)**:
   * **Alerts**: The script does a spatial lookup against `dim_location` using PostGIS functions `ST_DWithin` and `ST_Distance` with a threshold of `0.001` degrees (approx. 100 meters). If it is not within NLEX segment geometries, it is skipped.
   * **Jams**: The script converts the queue shape coordinates to a `LineString` geometry and checks if it falls within 100 meters of any `dim_location` segment geometry. Out-of-bounds jams are discarded.
4. **State Machine / MTTC Engine**:
   If an active database incident is missing from the incoming feed, the script sets `is_active = FALSE`, sets `cleared_at = NOW()`, and calculates **MTTC** (Mean Time to Clear) and total duration.
5. **Redis Cache Update**:
   Active incidents inside the NLEX corridor are read from PostgreSQL, formatted as a JSON array, and saved in Upstash Redis via its REST API (with a 10-minute expiry) to feed the Next.js dashboard UI.

---

## 💾 Part 3: How to Verify the Corridor Data in PostgreSQL

Run these queries in **pgAdmin** or **DBeaver** to prove the geofencing filters are working:

### Verify No Active Reports are Outside NLEX (Should both return 0)
```sql
SELECT COUNT(*) AS active_alerts_outside_nlex 
FROM fact_incident_log 
WHERE is_active = TRUE AND location_id IS NULL;

SELECT COUNT(*) AS active_jams_outside_nlex 
FROM fact_waze_jams 
WHERE is_active = TRUE AND location_id IS NULL;
```

### Inspect Active Alerts on NLEX Corridor
```sql
SELECT 
    f.incident_log_id AS uuid,
    f.street,
    f.city,
    l.segment_name AS mapped_nlex_segment,
    f.report_description,
    ST_AsText(f.geom) AS coordinates
FROM fact_incident_log f
INNER JOIN dim_location l ON f.location_id = l.location_id
WHERE f.is_active = TRUE;
```

### Inspect Active Jams on NLEX Corridor
```sql
SELECT 
    j.jam_id AS uuid,
    j.street,
    j.city,
    l.segment_name AS mapped_nlex_segment,
    j.level AS jam_severity,
    j.speed_kmh,
    j.length_meters,
    ST_AsText(j.geom) AS polyline_shape
FROM fact_waze_jams j
INNER JOIN dim_location l ON j.location_id = l.location_id
WHERE j.is_active = TRUE;
```
