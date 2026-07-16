import psycopg2

DB_HOST = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
DB_NAME = "nlex_capstone"
DB_USER = "postgres"
DB_PASSWORD = "Hanszy123"
DB_PORT = "5432"

sql = """
CREATE TABLE IF NOT EXISTS fact_incident_log (
    incident_log_id VARCHAR(100) PRIMARY KEY,
    time_id INT,
    weather_id INT,
    location_id INT,
    incident_type_id INT,
    mttc_minutes NUMERIC(8,2),
    incident_duration_minutes NUMERIC(8,2),
    impact_length_km NUMERIC(6,3),
    is_active BOOLEAN DEFAULT TRUE,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cleared_at TIMESTAMP WITH TIME ZONE,
    street VARCHAR(255),
    city VARCHAR(100),
    report_description TEXT,
    reliability INT,
    confidence INT,
    geom GEOMETRY(Point, 4326)
);

CREATE TABLE IF NOT EXISTS fact_waze_jams (
    jam_id VARCHAR(100) PRIMARY KEY,
    time_id INT,
    location_id INT,
    street VARCHAR(255),
    city VARCHAR(100),
    level INT,
    speed_kmh NUMERIC(6,2),
    length_meters INT,
    delay_seconds INT,
    is_active BOOLEAN DEFAULT TRUE,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cleared_at TIMESTAMP WITH TIME ZONE,
    geom GEOMETRY(LineString, 4326)
);
"""

try:
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        database=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(sql)
    print("Created fact_incident_log and fact_waze_jams successfully without FKs.")
    cur.close()
    conn.close()
except Exception as e:
    print(f"Error: {e}")
