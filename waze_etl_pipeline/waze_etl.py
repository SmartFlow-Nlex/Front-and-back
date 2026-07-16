# waze_etl.py
import os
import json
import logging
import requests
import psycopg2
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("WazeETL")

# Configuration via environment variables (ideal for local testing and AWS Lambda/EC2)
WAZE_FEED_URL = os.getenv("WAZE_FEED_URL")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "nlex_capstone")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "postgres")

# Redis Configuration (Upstash REST API)
REDIS_REST_URL = os.getenv("REDIS_REST_URL")
REDIS_REST_TOKEN = os.getenv("REDIS_REST_TOKEN")


def get_db_connection():
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        database=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )

def strip_namespaces(el):
    if el.tag.startswith("{"):
        el.tag = el.tag.split("}", 1)[1]
    for child in el:
        strip_namespaces(child)

def parse_xml_feed(xml_text):
    """
    Parses a Waze GeoRSS XML data feed and returns a unified dict matching the JSON schema.
    """
    try:
        root = ET.fromstring(xml_text)
        strip_namespaces(root)
    except Exception as e:
        logger.error(f"Failed to parse XML string: {e}")
        return None
        
    data = {"alerts": [], "jams": []}
    
    # The Waze GeoRSS feed consists of <item> elements inside <channel>
    # Each <item> represents an alert, jam, or irregularity.
    for item_node in root.findall(".//item"):
        title_node = item_node.find("title")
        if title_node is None or not title_node.text:
            continue
            
        item_type = title_node.text.strip().lower()
        
        if item_type == "alert":
            alert_data = {}
            for child in item_node:
                if child.tag == "point":
                    parts = child.text.strip().split()
                    if len(parts) >= 2:
                        try:
                            # georss:point is "latitude longitude", map to "x": longitude, "y": latitude
                            alert_data["location"] = {
                                "x": float(parts[1]),
                                "y": float(parts[0])
                            }
                        except Exception as e:
                            logger.warning(f"Failed to parse point coordinates: {child.text}: {e}")
                elif child.tag in ["pubMillis", "reliability", "confidence"]:
                    try:
                        alert_data[child.tag] = int(child.text)
                    except ValueError:
                        alert_data[child.tag] = 0
                else:
                    alert_data[child.tag] = child.text
            
            # Ensure uuid is mapped
            if "uuid" not in alert_data and "id" in alert_data:
                alert_data["uuid"] = alert_data["id"]
                
            data["alerts"].append(alert_data)
            
        elif item_type == "jam":
            jam_data = {}
            for child in item_node:
                if child.tag == "line":
                    parts = child.text.strip().split()
                    points = []
                    # georss:line is a flat list: "lat1 lon1 lat2 lon2 ..."
                    for i in range(0, len(parts) - 1, 2):
                        try:
                            points.append({
                                "x": float(parts[i+1]), # longitude
                                "y": float(parts[i])    # latitude
                            })
                        except Exception as e:
                            logger.warning(f"Failed to parse line point: {parts[i:i+2]}: {e}")
                    jam_data["line"] = points
                elif child.tag in ["pubMillis", "level", "length", "delay"]:
                    try:
                        jam_data[child.tag] = int(child.text)
                    except ValueError:
                        jam_data[child.tag] = 0
                elif child.tag == "speed":
                    # In Waze XML, speed represents the average travel speed, map it to speedKMH
                    try:
                        jam_data["speedKMH"] = float(child.text)
                    except ValueError:
                        jam_data["speedKMH"] = 0.0
                else:
                    jam_data[child.tag] = child.text
                    
            if "uuid" not in jam_data and "id" in jam_data:
                jam_data["uuid"] = jam_data["id"]
                
            data["jams"].append(jam_data)
            
    return data

def fetch_waze_data():
    """
    Validation Gate 1: Fetch Waze Partner Hub feed (JSON or XML) and perform schema validations.
    """
    if not WAZE_FEED_URL:
        raise ValueError("WAZE_FEED_URL environment variable is not set.")
    
    logger.info(f"Fetching data from Waze feed...")
    try:
        response = requests.get(WAZE_FEED_URL, timeout=30)
        response.raise_for_status()
    except Exception as e:
        logger.error(f"Validation Gate 1 failed: Connection / Request error: {e}")
        return None
    
    raw_text = response.text.strip()
    
    # Validation Gate 1: Automatically detect format (XML vs JSON)
    if raw_text.startswith("<?xml") or raw_text.startswith("<"):
        logger.info("XML feed detected. Parsing XML...")
        data = parse_xml_feed(raw_text)
        if not data:
            logger.error("Validation Gate 1 failed: XML parsing returned empty dict.")
            return None
    else:
        logger.info("JSON feed detected. Parsing JSON...")
        try:
            data = response.json()
        except json.JSONDecodeError as e:
            logger.error(f"Validation Gate 1 failed: Response is not valid JSON: {e}")
            return None
            
        if not isinstance(data, dict):
            logger.error("Validation Gate 1 failed: Root element of feed must be a JSON object.")
            return None
            
        if "alerts" not in data and "jams" not in data:
            logger.error("Validation Gate 1 failed: JSON payload must contain 'alerts' or 'jams' keys.")
            return None
            
    logger.info("Validation Gate 1 Passed: Fetch and schema verified.")
    return data

def save_to_bronze(conn, data):
    """
    Staging Layer (Bronze): Log raw JSON structure in Postgres.
    """
    logger.info("Ingesting raw data to Staging (Bronze Layer)...")
    cur = conn.cursor()
    try:
        if "alerts" in data and data["alerts"]:
            cur.execute(
                "INSERT INTO bronze_waze_alerts (raw_data) VALUES (%s)",
                (json.dumps(data["alerts"]),)
            )
        if "jams" in data and data["jams"]:
            cur.execute(
                "INSERT INTO bronze_waze_jams (raw_data) VALUES (%s)",
                (json.dumps(data["jams"]),)
            )
        conn.commit()
        logger.info("Bronze Layer Load Completed.")
    except Exception as e:
        conn.rollback()
        logger.error(f"Bronze Layer Ingestion failed: {e}")
    finally:
        cur.close()

def transform_and_load_alerts(conn, alerts, weather_id=None, time_id=None):
    """
    Validation Gate 3 & 4 -> Silver Layer: Transform and load Waze alerts.
    - Converted coordinates are mapped to PostGIS Geometries.
    - Spatial segment mapping is performed.
    - Upsert logic tracks active incidents.
    """
    if not alerts:
        logger.info("No alerts in current feed payload.")
        return []
    
    logger.info(f"Processing {len(alerts)} alerts for Silver Layer...")
    cur = conn.cursor()
    active_uuids = []
    
    for alert in alerts:
        uuid = alert.get("uuid")
        if not uuid:
            continue
        
        # Extract fields
        alert_type = alert.get("type", "UNKNOWN")
        subtype = alert.get("subtype", "")
        street = alert.get("street", "")
        city = alert.get("city", "")
        country = alert.get("country", "")
        desc = alert.get("reportDescription", "")
        reliability = alert.get("reliability", 0)
        confidence = alert.get("confidence", 0)
        
        # Handle pubMillis and Timestamp conversion
        pub_millis = alert.get("pubMillis")
        published_at = datetime.now(timezone.utc)
        if pub_millis:
            try:
                published_at = datetime.fromtimestamp(pub_millis / 1000.0, timezone.utc)
            except Exception as timestamp_err:
                logger.warning(f"Could not convert pubMillis {pub_millis}: {timestamp_err}")
        
        # Coordinate mapping
        loc = alert.get("location", {})
        lon = loc.get("x")
        lat = loc.get("y")
        
        if lon is None or lat is None:
            logger.warning(f"Alert {uuid} skipped: missing coordinates.")
            continue
            
        # PII scrub
        if desc:
            desc = desc.replace("User reported: ", "").strip()
            
        # Get or create the incident_type_id
        cur.execute(
            """
            INSERT INTO dim_incident_type (category, severity_level, report_source)
            VALUES (%s, %s, 'Waze Partner Hub')
            ON CONFLICT (category, severity_level, report_source)
            DO UPDATE SET report_source = EXCLUDED.report_source
            RETURNING incident_type_id
            """,
            (alert_type, subtype)
        )
        incident_type_id = cur.fetchone()[0]
        
        # Spatial Lookup: Find nearest dim_location segment within 100 meters
        cur.execute(
            """
            SELECT location_id 
            FROM dim_location 
            WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 0.001)
            ORDER BY ST_Distance(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)) ASC
            LIMIT 1
            """,
            (lon, lat, lon, lat)
        )
        loc_row = cur.fetchone()
        location_id = loc_row[0] if loc_row else None
        
        # Skip alerts outside NLEX corridor (where location_id is NULL)
        if location_id is None:
            logger.info(f"Skipping alert {uuid}: outside NLEX corridor buffer.")
            continue
            
        active_uuids.append(uuid)
        
        # Perform UPSERT into fact_incident_log (Silver Layer)
        cur.execute(
            """
            INSERT INTO fact_incident_log (
                incident_log_id, time_id, weather_id, location_id, incident_type_id,
                is_active, first_seen_at, last_seen_at, cleared_at,
                street, city, report_description, reliability, confidence, geom
            )
            VALUES (
                %s, %s, %s, %s, %s,
                TRUE, NOW(), NOW(), NULL,
                %s, %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            )
            ON CONFLICT (incident_log_id)
            DO UPDATE SET
                last_seen_at = NOW(),
                reliability = EXCLUDED.reliability,
                confidence = EXCLUDED.confidence,
                is_active = TRUE,
                cleared_at = NULL
            """,
            (
                uuid, time_id, weather_id, location_id, incident_type_id,
                street, city, desc, reliability, confidence, lon, lat
            )
        )
        
    conn.commit()
    cur.close()
    return active_uuids

def transform_and_load_jams(conn, jams, time_id=None):
    """
    Transform and load Waze jams into fact_waze_jams.
    Converts polylines to PostGIS LineString geometry.
    """
    if not jams:
        logger.info("No jams in current feed payload.")
        return []
        
    logger.info(f"Processing {len(jams)} jams for Silver Layer...")
    cur = conn.cursor()
    active_uuids = []
    
    for jam in jams:
        uuid = jam.get("uuid")
        if not uuid:
            continue
            
        street = jam.get("street", "")
        city = jam.get("city", "")
        level = jam.get("level", 0)
        speed = jam.get("speedKMH", 0.0)
        length = jam.get("length", 0)
        delay = jam.get("delay", 0)
        
        # pubMillis and Timestamp conversion
        pub_millis = jam.get("pubMillis")
        published_at = datetime.now(timezone.utc)
        if pub_millis:
            try:
                published_at = datetime.fromtimestamp(pub_millis / 1000.0, timezone.utc)
            except Exception as e:
                logger.warning(f"Could not convert jam timestamp {pub_millis}: {e}")
                
        # Jam Polyline processing
        line = jam.get("line", [])
        if len(line) < 2:
            logger.warning(f"Jam {uuid} skipped: Less than 2 coordinates to form a LineString.")
            continue
            
        # Construct LineString WKT
        wkt_coords = ", ".join([f"{pt.get('x')} {pt.get('y')}" for pt in line if pt.get('x') is not None and pt.get('y') is not None])
        line_wkt = f"LINESTRING({wkt_coords})"
        
        # Spatial Lookup: Find nearest dim_location segment within 100 meters
        cur.execute(
            """
            SELECT location_id 
            FROM dim_location 
            WHERE ST_DWithin(geom, ST_GeomFromText(%s, 4326), 0.001)
            ORDER BY ST_Distance(geom, ST_GeomFromText(%s, 4326)) ASC
            LIMIT 1
            """,
            (line_wkt, line_wkt)
        )
        loc_row = cur.fetchone()
        location_id = loc_row[0] if loc_row else None
        
        # Skip jams outside NLEX corridor (where location_id is NULL)
        if location_id is None:
            logger.info(f"Skipping jam {uuid}: outside NLEX corridor buffer.")
            continue
            
        active_uuids.append(uuid)
        
        # Perform UPSERT into fact_waze_jams (Silver Layer)
        cur.execute(
            """
            INSERT INTO fact_waze_jams (
                jam_id, time_id, location_id, street, city, level, speed_kmh,
                length_meters, delay_seconds, is_active, first_seen_at, last_seen_at, cleared_at, geom
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, TRUE, NOW(), NOW(), NULL, ST_GeomFromText(%s, 4326)
            )
            ON CONFLICT (jam_id)
            DO UPDATE SET
                last_seen_at = NOW(),
                level = EXCLUDED.level,
                speed_kmh = EXCLUDED.speed_kmh,
                delay_seconds = EXCLUDED.delay_seconds,
                is_active = TRUE,
                cleared_at = NULL
            """,
            (
                uuid, time_id, location_id, street, city, level, speed,
                length, delay, line_wkt
            )
        )
        
    conn.commit()
    cur.close()
    return active_uuids

def clear_inactive_records(conn, active_alert_uuids, active_jam_uuids):
    """
    State Machine / MTTC Engine:
    Identify alerts/jams marked active in DB but missing from the current live feed.
    These are flagged inactive (cleared) and cleared_at is set.
    """
    logger.info("Executing MTTC Engine: clearing resolved alerts and jams...")
    cur = conn.cursor()
    try:
        # 1. Clear Alerts
        if active_alert_uuids:
            cur.execute(
                """
                UPDATE fact_incident_log
                SET 
                    is_active = FALSE,
                    cleared_at = NOW(),
                    incident_duration_minutes = EXTRACT(EPOCH FROM (NOW() - first_seen_at)) / 60.0,
                    mttc_minutes = EXTRACT(EPOCH FROM (NOW() - first_seen_at)) / 60.0
                WHERE is_active = TRUE AND incident_log_id NOT IN %s
                """,
                (tuple(active_alert_uuids),)
            )
        else:
            cur.execute(
                """
                UPDATE fact_incident_log
                SET 
                    is_active = FALSE,
                    cleared_at = NOW(),
                    incident_duration_minutes = EXTRACT(EPOCH FROM (NOW() - first_seen_at)) / 60.0,
                    mttc_minutes = EXTRACT(EPOCH FROM (NOW() - first_seen_at)) / 60.0
                WHERE is_active = TRUE
                """
            )
            
        # 2. Clear Jams
        if active_jam_uuids:
            cur.execute(
                """
                UPDATE fact_waze_jams
                SET 
                    is_active = FALSE,
                    cleared_at = NOW()
                WHERE is_active = TRUE AND jam_id NOT IN %s
                """,
                (tuple(active_jam_uuids),)
            )
        else:
            cur.execute(
                """
                UPDATE fact_waze_jams
                SET 
                    is_active = FALSE,
                    cleared_at = NOW()
                WHERE is_active = TRUE
                """
            )
            
        conn.commit()
        logger.info("MTTC Engine: Clearance states synchronized successfully.")
    except Exception as e:
        conn.rollback()
        logger.error(f"Clear inactive records failed: {e}")
    finally:
        cur.close()

def update_redis_cache(conn):
    if not REDIS_REST_URL or not REDIS_REST_TOKEN:
        logger.info("REDIS_REST_URL or REDIS_REST_TOKEN is not set. Skipping Redis cache update.")
        return
        
    logger.info(f"Connecting to Upstash Redis REST API at {REDIS_REST_URL}...")
    try:
        cur = conn.cursor()
        
        # 1. Fetch active alerts (incidents)
        cur.execute(
            """
            SELECT json_agg(t) FROM (
                SELECT 
                    f.incident_log_id AS uuid,
                    f.street,
                    f.city,
                    f.report_description,
                    f.reliability,
                    f.confidence,
                    t.category AS type,
                    t.severity_level AS subtype,
                    ST_X(f.geom) AS longitude,
                    ST_Y(f.geom) AS latitude,
                    f.first_seen_at::text AS first_seen_at,
                    f.last_seen_at::text AS last_seen_at
                FROM fact_incident_log f
                LEFT JOIN dim_incident_type t ON f.incident_type_id = t.incident_type_id
                WHERE f.is_active = TRUE
            ) t;
            """
        )
        alerts_row = cur.fetchone()
        alerts_json = json.dumps(alerts_row[0]) if alerts_row and alerts_row[0] else "[]"
        
        # 2. Fetch active jams
        cur.execute(
            """
            SELECT json_agg(t) FROM (
                SELECT 
                    jam_id AS uuid,
                    street,
                    city,
                    level,
                    speed_kmh::float AS speed_kmh,
                    length_meters,
                    delay_seconds,
                    ST_AsText(geom) AS polyline,
                    first_seen_at::text AS first_seen_at,
                    last_seen_at::text AS last_seen_at
                FROM fact_waze_jams
                WHERE is_active = TRUE
            ) t;
            """
        )
        jams_row = cur.fetchone()
        jams_json = json.dumps(jams_row[0]) if jams_row and jams_row[0] else "[]"
        
        cur.close()
        
        # Save to Upstash Redis using REST API
        headers = {
            "Authorization": f"Bearer {REDIS_REST_TOKEN}",
            "Content-Type": "application/json"
        }
        
        url = REDIS_REST_URL.rstrip('/')
        
        payload_alerts = ["SET", "waze:active_alerts", alerts_json, "EX", "600"]
        response1 = requests.post(url, json=payload_alerts, headers=headers, timeout=10)
        response1.raise_for_status()
        
        payload_jams = ["SET", "waze:active_jams", jams_json, "EX", "600"]
        response2 = requests.post(url, json=payload_jams, headers=headers, timeout=10)
        response2.raise_for_status()
        
        logger.info("Successfully updated live active data cache in Upstash Redis via REST API.")
        
    except Exception as e:
        logger.error(f"Failed to update Upstash Redis cache: {e}")

def run_etl():
    """
    Main orchestrator of the Waze live ingestion.
    """
    # 1. Fetch Waze feed
    waze_data = fetch_waze_data()
    if not waze_data:
        logger.warning("No data retrieved from Waze. ETL run aborted.")
        return
        
    # 2. Connect to database
    try:
        conn = get_db_connection()
        logger.info("Database connection established.")
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        return
        
    try:
        # 3. Save to Bronze Layer (Raw)
        save_to_bronze(conn, waze_data)
        
        # 4. Process Alerts (Silver)
        alerts = waze_data.get("alerts", [])
        active_alert_uuids = transform_and_load_alerts(conn, alerts)
        
        # 5. Process Jams (Silver)
        jams = waze_data.get("jams", [])
        active_jam_uuids = transform_and_load_jams(conn, jams)
        
        # 6. Clear Resolved incidents (State Machine)
        clear_inactive_records(conn, active_alert_uuids, active_jam_uuids)
        
        # 7. Update Redis Cache for frontend UI
        update_redis_cache(conn)
        
    except Exception as e:
        logger.error(f"Error during ETL operations: {e}")
    finally:
        conn.close()
        logger.info("Database connection closed. ETL run complete.")

if __name__ == "__main__":
    logger.info("Starting Waze Live ETL Scheduler (polling every 120 seconds)...")
    import time
    while True:
        try:
            run_etl()
        except Exception as err:
            logger.error(f"ETL Execution Loop encountered error: {err}")
        time.sleep(120)
