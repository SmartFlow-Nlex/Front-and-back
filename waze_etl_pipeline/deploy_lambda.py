# deploy_lambda.py
import os
import sys
import zipfile
import subprocess
import shutil
import time

def install_and_import(package):
    try:
        __import__(package)
    except ImportError:
        print(f"Installing missing package: {package}...")
        subprocess.run([sys.executable, "-m", "pip", "install", package], check=True)

# Ensure boto3 is installed
install_and_import("boto3")
import boto3
from botocore.exceptions import ClientError

def create_deployment_zip(temp_dir="lambda_package", zip_name="waze_etl_deployment.zip"):
    print("Creating deployment ZIP package...")
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)
    os.makedirs(temp_dir)

    # 1. Install dependencies into package folder
    print("Installing python libraries (requests, psycopg2-binary)...")
    try:
        subprocess.run([
            sys.executable, "-m", "pip", "install", 
            "requests", "psycopg2-binary", 
            "-t", temp_dir
        ], check=True)
    except subprocess.CalledProcessError as e:
        print(f"Failed to install dependencies: {e}")
        return False

    # 2. Copy source files
    print("Copying script files...")
    shutil.copy("waze_etl.py", os.path.join(temp_dir, "waze_etl.py"))
    shutil.copy("lambda_function.py", os.path.join(temp_dir, "lambda_function.py"))

    # 3. Create zip archive
    if os.path.exists(zip_name):
        os.remove(zip_name)
        
    print(f"Writing zip archive to {zip_name}...")
    with zipfile.ZipFile(zip_name, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(temp_dir):
            for file in files:
                file_path = os.path.join(root, file)
                # Calculate zip path relative to temp_dir
                arcname = os.path.relpath(file_path, temp_dir)
                zipf.write(file_path, arcname)

    # Clean up temp folder
    shutil.rmtree(temp_dir)
    print("ZIP package created successfully.")
    return True

def deploy():
    print("==================================================")
    print("    AWS Live Waze ETL Pipeline Deployer           ")
    print("==================================================")
    
    # Prompt user for credentials
    access_key = input("Enter AWS Access Key ID: ").strip()
    secret_key = input("Enter AWS Secret Access Key: ").strip()
    region = input("Enter AWS Region (e.g. ap-southeast-1): ").strip() or "ap-southeast-1"
    
    # Prompt for environment variables
    print("\nConfigure Waze & Database Environment Variables:")
    waze_url = input("Waze Feed URL: ").strip()
    db_host = input("Database Host (AWS RDS Endpoint): ").strip()
    db_name = input("Database Name (default: nlex_capstone): ").strip() or "nlex_capstone"
    db_user = input("Database Username: ").strip()
    db_pass = input("Database Password: ").strip()

    # Create the zip package
    if not create_deployment_zip():
        print("Deployment aborted due to packaging failure.")
        return

    # Initialize boto3 clients
    print("\nConnecting to AWS Services...")
    try:
        iam = boto3.client(
            'iam',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region
        )
        awslambda = boto3.client(
            'lambda',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region
        )
        events = boto3.client(
            'events',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region
        )
    except Exception as e:
        print(f"Failed to connect to AWS: {e}")
        return

    # 1. Create IAM Role for Lambda
    role_name = "WazeLambdaExecutionRole"
    role_arn = None
    
    assume_role_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "Service": "lambda.amazonaws.com"
                },
                "Action": "sts:AssumeRole"
            }
        ]
    }
    
    print(f"Configuring IAM Execution Role '{role_name}'...")
    try:
        role_res = iam.create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=json.dumps(assume_role_policy),
            Description="Execution role for NLEX Waze ETL Lambda function"
        )
        role_arn = role_res['Role']['Arn']
        print(f"Created new IAM Role: {role_arn}")
        
        # Attach basic execution policy (for CloudWatch logging)
        iam.attach_role_policy(
            RoleName=role_name,
            PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        )
        print("Attached basic execution policy to role. Waiting for role propagation...")
        time.sleep(10) # Wait for IAM role to propagate through AWS
    except ClientError as e:
        if e.response['Error']['Code'] == 'EntityAlreadyExists':
            print("IAM Role already exists. Retrieving details...")
            role_res = iam.get_role(RoleName=role_name)
            role_arn = role_res['Role']['Arn']
            print(f"Role ARN: {role_arn}")
        else:
            print(f"Failed to create IAM Role: {e}")
            return

    # 2. Upload / Update Lambda Function
    function_name = "waze-live-ingest"
    lambda_arn = None
    
    with open("waze_etl_deployment.zip", "rb") as f:
        zip_bytes = f.read()

    print(f"Deploying Lambda function '{function_name}'...")
    
    env_config = {
        'Variables': {
            'WAZE_FEED_URL': waze_url,
            'DB_HOST': db_host,
            'DB_PORT': '5432',
            'DB_NAME': db_name,
            'DB_USER': db_user,
            'DB_PASSWORD': db_pass
        }
    }
    
    try:
        # Create function if it doesn't exist
        res = awslambda.create_function(
            FunctionName=function_name,
            Runtime='python3.9',
            Role=role_arn,
            Handler='lambda_function.lambda_handler',
            Code={'ZipFile': zip_bytes},
            Description='Ingests live Waze feeds to AWS RDS PostgreSQL',
            Timeout=60, # 1 minute
            MemorySize=128,
            Environment=env_config
        )
        lambda_arn = res['FunctionArn']
        print(f"Lambda function created successfully! ARN: {lambda_arn}")
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceConflictException':
            print("Lambda function already exists. Updating code & configuration...")
            
            # Update Code
            awslambda.update_function_code(
                FunctionName=function_name,
                ZipFile=zip_bytes
            )
            
            # Update Configuration
            res = awslambda.update_function_configuration(
                FunctionName=function_name,
                Environment=env_config,
                Timeout=60
            )
            lambda_arn = res['FunctionArn']
            print("Lambda function updated successfully.")
        else:
            print(f"Failed to deploy Lambda: {e}")
            return

    # 3. Create EventBridge Scheduler Trigger (Every 2 minutes)
    rule_name = "waze-ingest-trigger-2m"
    print(f"Creating EventBridge trigger rule '{rule_name}' (rate: 2 minutes)...")
    
    try:
        rule_res = events.put_rule(
            Name=rule_name,
            ScheduleExpression="rate(2 minutes)",
            State="ENABLED",
            Description="Trigger Waze ETL Ingestion every 2 minutes"
        )
        rule_arn = rule_res['RuleArn']
        
        # Add target
        events.put_targets(
            Rule=rule_name,
            Targets=[
                {
                    'Id': 'WazeETLLambdaTarget',
                    'Arn': lambda_arn
                }
            ]
        )
        print("EventBridge rule created and targeted to Lambda.")
        
        # Grant EventBridge permission to invoke the Lambda function
        try:
            awslambda.add_permission(
                FunctionName=function_name,
                StatementId='EventBridgeInvokePermission',
                Action='lambda:InvokeFunction',
                Principal='events.amazonaws.com',
                SourceArn=rule_arn
            )
            print("Granted permission to EventBridge to trigger Lambda.")
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceConflictException':
                print("Trigger invocation permissions already exist.")
            else:
                raise e
                
    except Exception as e:
        print(f"Failed to configure EventBridge scheduler: {e}")
        return

    print("\n==================================================")
    print(" 🎉 SUCCESS: Live Waze Ingestion pipeline deployed!")
    print(" Your AWS Lambda function will run every 2 minutes.")
    print("==================================================")

if __name__ == "__main__":
    deploy()
