import os
import waze_etl

os.environ["WAZE_FEED_URL"] = "https://www.waze.com/row-partnerhub-api/partners/16732951409/waze-feeds/c08eda8f-0505-4324-b2e4-2eeffb8ba66f?format=2"
os.environ["DB_HOST"] = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
os.environ["DB_NAME"] = "nlex_capstone"
os.environ["DB_USER"] = "postgres"
os.environ["DB_PASSWORD"] = "Hanszy123"
os.environ["DB_PORT"] = "5432"
os.environ["REDIS_REST_URL"] = "https://united-mayfly-138714.upstash.io"
os.environ["REDIS_REST_TOKEN"] = "gQAAAAAAAh3aAAIgcDFhYjk2NjA4N2FiNDQ0YjlmYjVkOGZlOTliNGRkZDMyYw"

if __name__ == "__main__":
    print("Starting a manual ETL run...")
    waze_etl.run_etl()
    print("Manual ETL run complete.")
