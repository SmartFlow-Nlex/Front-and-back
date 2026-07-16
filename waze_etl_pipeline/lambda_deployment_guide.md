# AWS Lambda & EventBridge Deployment Guide

This guide describes how to deploy the Waze Live Ingestion pipeline on AWS to run serverless every 2 minutes.

---

## Part 1: Preparing the Code ZIP Package

AWS Lambda needs a single `.zip` file containing the scripts and python dependencies (`requests` and `psycopg2-binary`).

### Step-by-step packaging instructions:

1. **Create a clean workspace folder** on your local machine.
2. Copy `waze_etl.py` and `lambda_function.py` into it.
3. Open a terminal (PowerShell on Windows, or Bash on Linux/Mac) inside that folder.
4. Install the required libraries locally to the same directory:
   ```bash
   pip install requests -t .
   ```
5. **Important for PostgreSQL on AWS Lambda:** Standard `psycopg2` requires compiled C libraries that are not present in AWS Lambda's environment. To resolve this, you can package the compiled `psycopg2-binary` library:
   ```bash
   pip install psycopg2-binary -t .
   ```
6. Zip all files and folders in that directory together.
   - *On Windows:* Select all files and folders in the workspace, right-click -> **Send to** -> **Compressed (zipped) folder**. Name it `waze_etl_deployment.zip`.
   - *On Linux/Mac:* Run `zip -r waze_etl_deployment.zip .`
   
   > [!IMPORTANT]
   > Make sure the scripts (`waze_etl.py` and `lambda_function.py`) are at the **root** of the ZIP file, not inside a subfolder.

---

## Part 2: Creating the AWS Lambda Function

1. Log in to your **AWS Management Console**.
2. Search for **Lambda** in the search bar and click on it.
3. Click the orange **Create function** button.
4. Select **Author from scratch** and configure the settings:
   - **Function name:** `waze-live-ingest` (or any name you prefer).
   - **Runtime:** `Python 3.9` (or `Python 3.10` / `Python 3.11`).
   - **Architecture:** `x86_64`.
5. Click **Create function** at the bottom.
6. Once the function is created:
   - Scroll down to the **Code** tab.
   - Click the **Upload from** dropdown on the right and select **.zip file**.
   - Click **Upload**, choose your `waze_etl_deployment.zip` file, and click **Save**.
7. In the **Runtime settings** section (bottom of the Code tab):
   - Verify the **Handler** is set to: `lambda_function.lambda_handler` (this tells AWS to trigger the `lambda_handler` function inside `lambda_function.py`).
8. Scroll to the **Configuration** tab at the top of the function page:
   - Select **General configuration** on the left menu, click **Edit**, change **Timeout** to **1 minute** (default is 3 seconds, which is too short for network polling), and click **Save**.
   - Select **Environment variables** on the left menu, click **Edit**, and add the following keys:
     - `WAZE_FEED_URL` = *Your Waze XML/JSON feed URL*
     - `DB_HOST` = *Your AWS RDS PostgreSQL hostname (Endpoint)*
     - `DB_PORT` = `5432`
     - `DB_NAME` = `nlex_capstone`
     - `DB_USER` = *Your DB Username (e.g. postgres)*
     - `DB_PASSWORD` = *Your DB Password*
   - Click **Save**.

---

## Part 3: Creating the EventBridge Scheduling Rule (Every 2 Minutes)

To trigger the Lambda function every 2 minutes automatically:

1. Inside your Lambda function page, click the **+ Add trigger** button in the Function overview section.
2. In the dropdown, select **EventBridge (CloudWatch Events)**.
3. Configure the trigger:
   - **Rule:** Select **Create a new rule**.
   - **Rule name:** `waze-ingest-every-2m`.
   - **Rule description:** Triggers Waze live ingestion every 2 minutes.
   - **Rule type:** Select **Schedule expression**.
   - **Schedule expression:** Type `rate(2 minutes)` or cron expression `cron(*/2 * * * ? *)`.
4. Click **Add** at the bottom.

Your pipeline is now **live**! AWS EventBridge will trigger the Lambda function every 2 minutes, which pulls the XML/JSON data, writes the raw data to the Bronze Layer, and processes it into your pgAdmin PostgreSQL database (Silver Layer).

---

## 🔒 Security Group Setup (pgAdmin / RDS Troubleshooting)

If your Lambda function fails with a database timeout, it is because your AWS RDS Security Group is blocking connections from Lambda.
1. Go to the **RDS Console** in AWS.
2. Click **Databases** and select your `nlex_capstone` instance.
3. Look at the **Connectivity & security** tab and click on the **VPC security groups** link.
4. Select the security group and go to **Inbound rules > Edit inbound rules**.
5. Add a rule:
   - **Type:** PostgreSQL (`5432`)
   - **Source:** Custom -> Enter the IP address range of your VPC, or select **Anywhere-IPv4** (`0.0.0.0/0`) if your RDS instance is publicly accessible (ensure you use strong passwords!).
6. Click **Save rules**.
