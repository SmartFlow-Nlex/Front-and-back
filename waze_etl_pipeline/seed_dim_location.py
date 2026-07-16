import psycopg2

DB_HOST = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
DB_NAME = "nlex_capstone"
DB_USER = "postgres"
DB_PASSWORD = "Hanszy123"
DB_PORT = "5432"

def seed_locations():
    try:
        conn = psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD
        )
        cur = conn.cursor()
        
        # 1. Fetch all exits in order of latitude
        cur.execute("SELECT name, longitude, latitude FROM nlex_exits ORDER BY latitude ASC;")
        exits = cur.fetchall()
        
        if len(exits) < 2:
            print("Not enough exits to create segments!")
            cur.close()
            conn.close()
            return
            
        print("Truncating dim.dim_location...")
        cur.execute("TRUNCATE TABLE dim.dim_location CASCADE;")
        
        print("Inserting segments into dim.dim_location...")
        inserted_count = 0
        for i in range(len(exits) - 1):
            start_name, start_lon, start_lat = exits[i]
            end_name, end_lon, end_lat = exits[i+1]
            
            segment_name = f"{start_name} to {end_name}"
            wkt_geom = f"LINESTRING({start_lon} {start_lat}, {end_lon} {end_lat})"
            
            cur.execute("""
                INSERT INTO dim.dim_location (segment_name, start_node, end_node, street, city, geom)
                VALUES (%s, %s, %s, 'NLEX', %s, ST_GeomFromText(%s, 4326))
                ON CONFLICT (segment_name) DO NOTHING;
            """, (segment_name, start_name, end_name, start_name, wkt_geom))
            inserted_count += 1
            
        conn.commit()
        print(f"Successfully seeded {inserted_count} segments into dim_location!")
        
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Database error during seeding: {e}")

if __name__ == "__main__":
    seed_locations()
