# SmartFlow NLEX: Waze Live Ingestion Pipeline

This project contains the ETL pipeline to ingest live traffic alerts and jams from the **Waze Partner Hub** into your **AWS RDS PostgreSQL** database. It conforms to the architecture and validation gates defined in the capstone manuscript.

---

## 📂 Codebase Structure
- `schema.sql` - PostGIS spatial database migrations.
- `waze_etl.py` - Core ETL engine executing Python-based extraction, validation gates, and PostgreSQL upsert.
- `lambda_function.py` - AWS Lambda handler for serverless scheduling.

---

## 🛠️ Step 1: AWS RDS PostgreSQL & PostGIS Setup

### 1. Enable PostGIS Extension
Connect to your AWS PostgreSQL database (using PgAdmin, DBeaver, or PSQL CLI) and run:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

### 2. Apply Database Schema
Execute the DDL scripts in `schema.sql` to create the staging (Bronze) and core dimensions/fact tables (Silver) in your database.

> [!TIP]
> Ensure your NLEX segment boundaries are populated in `dim_location` with their spatial geometries. The script will automatically calculate proximity and map incoming geolocated Waze incidents to your segments.

---

## 🚀 Step 2: Ingestion & Live Automation Options

You have two main deployment options depending on your capstone budget and infrastructure preference.

### Option A: AWS Lambda + EventBridge (Recommended / Serverless)
This runs the script serverless every 2 minutes, staying within the AWS Free Tier.

#### 1. Package the Code
Because AWS Lambda does not contain the `requests` and `psycopg2` libraries by default, you must package them together:
```bash
# Create a temporary directory
mkdir package
cd package

# Install dependencies locally targeting the folder
pip install requests -t .
# Note: For Lambda, use psycopg2-binary or use an AWS Lambda Layer containing psycopg2
pip install psycopg2-binary -t .

# Copy your scripts into the folder
cp ../waze_etl.py .
cp ../lambda_function.py .

# Zip the package
zip -r ../waze_deployment.zip .
```

#### 2. Create the AWS Lambda Function
- **Runtime:** Python 3.9+
- **Architecture:** x86_64
- **Code:** Upload your `waze_deployment.zip` file.
- **Handler:** `lambda_function.lambda_handler`
- **Timeout:** Set to **1 minute** (the execution normally takes < 10 seconds).
- **Environment Variables:**
  Add the following keys in the Lambda **Configuration > Environment variables** tab:
  - `WAZE_FEED_URL` = *Your unique Waze JSON feed URL*
  - `DB_HOST` = *Your AWS RDS Endpoint*
  - `DB_PORT` = `5432`
  - `DB_NAME` = `smartflow_nlex`
  - `DB_USER` = *Your DB Username*
  - `DB_PASSWORD` = *Your DB Password*

#### 3. Schedule Ingestion
- Go to **Amazon EventBridge > Scheduler** in the AWS Console.
- Create a new rule: **Schedule pattern** -> **Recurring schedule** -> **Rate-based schedule**.
- Set rate to **2 minutes**.
- Set **Target** to your created Lambda function.

---

### Option B: AWS EC2 / Local Server Ingestion (Cron Job)
If you are hosting your dashboard on an EC2 instance, you can run the scheduler as a background service.

#### 1. Setup Environment Variables
Edit your system environment (`/etc/environment` or your user `.bashrc` profile):
```bash
export WAZE_FEED_URL="https://www.waze.com/row-partnerhub-api/partners/.../waze-feeds/...&format=1"
export DB_HOST="your-rds-endpoint.amazonaws.com"
export DB_PORT="5432"
export DB_NAME="smartflow_nlex"
export DB_USER="postgres"
export DB_PASSWORD="your-db-password"
```

#### 2. Run the Scheduler
You can run the script continuously:
```bash
python3 waze_etl.py &
```
*The script has a built-in loop that polls the feed every 120 seconds.*

Alternatively, remove the `while True` loop at the bottom of `waze_etl.py` and run it via a Linux **crontab** every 2 minutes:
```cron
*/2 * * * * /usr/bin/python3 /path/to/waze_etl.py >> /var/log/waze_etl.log 2>&1
```

---

## 🔒 Step 3: Security & Network Access
Ensure that your AWS RDS PostgreSQL **Security Group** allows inbound traffic from the IP address of your Lambda function or EC2 instance on Port `5432`.
- If running on AWS Lambda outside of a VPC, you may need to enable **Publicly Accessible** on your RDS instance (with security group restricted to specific IPs) OR set up a **VPC NAT Gateway** so that Lambda can reach both the internet (Waze API) and your private RDS instance.
