from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import psycopg2
import pandas as pd
import sys

def audit_database():
    print("Connecting to AWS RDS database...")
    try:
        conn = psycopg2.connect(
            host=os.environ["PG_HOST"],
            port=5432,
            user=os.environ["PG_USER"],
            password=os.environ["PG_PASSWORD"],
            dbname=os.environ.get("PG_DATABASE", "nlex_capstone"),
            sslmode="require"
        )
        cur = conn.cursor()
    except Exception as e:
        print(f"Failed to connect: {e}")
        sys.exit(1)

    schemas = ['bronze', 'silver']
    audit_results = []
    
    for schema in schemas:
        audit_results.append(f"\n## Schema: `{schema}`")
        
        cur.execute(f"""
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = '{schema}'
            ORDER BY table_name;
        """)
        tables = [row[0] for row in cur.fetchall()]
        
        if not tables:
            audit_results.append(f"*(No tables found in schema {schema})*")
            continue
            
        for table in tables:
            audit_results.append(f"### Table: `{schema}.{table}`")
            
            # Row count
            try:
                cur.execute(f"SELECT COUNT(*) FROM {schema}.{table}")
                row_count = cur.fetchone()[0]
                audit_results.append(f"- **Total Rows:** {row_count}")
            except Exception as e:
                audit_results.append(f"- **Error getting row count:** {e}")
                conn.rollback()
                continue
                
            if row_count == 0:
                audit_results.append("- ⚠️ **WARNING:** Table is empty!")
                
            # Column definitions and sample completeness
            cur.execute(f"""
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_schema = '{schema}' AND table_name = '{table}'
                ORDER BY ordinal_position;
            """)
            columns = cur.fetchall()
            
            audit_results.append("#### Columns")
            audit_results.append("| Column Name | Data Type | Null Count | % Null |")
            audit_results.append("|-------------|-----------|------------|--------|")
            
            for col_name, data_type in columns:
                if row_count > 0:
                    try:
                        # Check nulls safely
                        cur.execute(f'SELECT COUNT(*) FROM {schema}.{table} WHERE "{col_name}" IS NULL')
                        null_count = cur.fetchone()[0]
                        null_pct = (null_count / row_count) * 100
                        null_str = f"{null_count}"
                        null_pct_str = f"{null_pct:.1f}%"
                    except Exception as e:
                        conn.rollback()
                        null_str = "Error"
                        null_pct_str = "Error"
                else:
                    null_str = "-"
                    null_pct_str = "-"
                    
                audit_results.append(f"| `{col_name}` | {data_type} | {null_str} | {null_pct_str} |")
                
            # Peek at the date range if there is a 'date' or 'date_day' column
            date_col = None
            for col_name, _ in columns:
                if col_name.lower() in ['date', 'date_day', 'incident_date']:
                    date_col = col_name
                    break
                    
            if date_col and row_count > 0:
                try:
                    cur.execute(f'SELECT MIN("{date_col}"), MAX("{date_col}") FROM {schema}.{table}')
                    min_date, max_date = cur.fetchone()
                    audit_results.append(f"- **Date Range:** {min_date} to {max_date}")
                except Exception as e:
                    conn.rollback()
    
    conn.close()
    
    # Write to markdown file
    report_path = 'C:/Users/Hans/.gemini/antigravity/scratch/database_audit_report.md'
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("# AWS RDS Database Audit Report\n")
        f.write("\n".join(audit_results))
        
    print(f"Audit complete. Report saved to {report_path}")

if __name__ == "__main__":
    audit_database()
