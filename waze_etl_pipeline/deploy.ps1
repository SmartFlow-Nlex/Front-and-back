# deploy.ps1
# Automates the deployment of the Waze ETL pipeline to AWS Lambda and EventBridge scheduler.

# Exit immediately if any command fails
$ErrorActionPreference = "Stop"

# Define credentials configuration variables
$feedUrl = "https://www.waze.com/row-partnerhub-api/partners/16732951409/waze-feeds/c08eda8f-0505-4324-b2e4-2eeffb8ba66f?format=2"
$dbHost = "smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com"
$dbName = "nlex_capstone"
$dbUser = "postgres"
$dbPassword = "Hanszy123"
$dbPort = "5432"

# Redis Configuration (Upstash REST API)
$redisRestUrl = "https://united-mayfly-138714.upstash.io"
$redisRestToken = "gQAAAAAAAh3aAAIgcDFhYjk2NjA4N2FiNDQ0YjlmYjVkOGZlOTliNGRkZDMyYw"



# 1. Find AWS CLI path
$awsPath = "aws"
if (-not (Get-Command "aws" -ErrorAction SilentlyContinue)) {
    $userScriptsAws = "C:\Users\Bela\AppData\Roaming\Python\Python313\Scripts\aws.exe"
    $userScriptsAwsCmd = "C:\Users\Bela\AppData\Roaming\Python\Python313\Scripts\aws.cmd"
    if (Test-Path $userScriptsAws) {
        $awsPath = $userScriptsAws
    } elseif (Test-Path $userScriptsAwsCmd) {
        $awsPath = $userScriptsAwsCmd
    } else {
        Write-Error "AWS CLI executable not found. Please ensure it is installed and on the PATH."
        exit 1
    }
}
Write-Host "Using AWS CLI executable: $awsPath"

# 2. Check AWS Connection
Write-Host "Verifying AWS authentication..."
$identity = & $awsPath sts get-caller-identity
Write-Host "Connected as: $identity"

# 3. Create trust-policy.json for IAM Role
$trustPolicy = @"
{
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
"@
$trustPolicyFile = "trust-policy.json"
Set-Content -Path $trustPolicyFile -Value $trustPolicy

# 4. Create/Get IAM Role
$roleArn = ""
$existingRole = ""
try {
    $existingRole = & $awsPath iam get-role --role-name waze-lambda-execution-role --query "Role.Arn" --output text 2>$null
} catch {
    # Role does not exist or access error
}

if ($existingRole) {
    Write-Host "IAM execution role already exists: $existingRole"
    $roleArn = $existingRole
} else {
    Write-Host "Creating IAM execution role..."
    $roleArn = & $awsPath iam create-role --role-name waze-lambda-execution-role --assume-role-policy-document file://$trustPolicyFile --query "Role.Arn" --output text
    Write-Host "Created execution role: $roleArn"
    Write-Host "Waiting 15 seconds for IAM role to replicate across AWS regions..."
    Start-Sleep -Seconds 15
}

# Clean up trust policy file
if (Test-Path $trustPolicyFile) {
    Remove-Item $trustPolicyFile
}

# 5. Attach Basic Execution and VPC Access Policies to Role
Write-Host "Attaching execution and VPC access policies to the role..."
& $awsPath iam attach-role-policy --role-name waze-lambda-execution-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
& $awsPath iam attach-role-policy --role-name waze-lambda-execution-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

# 6. Create/Update Lambda Function
Write-Host "Deploying Lambda function 'waze-live-ingest'..."
$lambdaArn = ""
$funcExists = $false
try {
    $getFuncResult = & $awsPath lambda get-function --function-name waze-live-ingest 2>$null
    if ($LASTEXITCODE -eq 0) {
        $funcExists = $true
    }
} catch {
    # Function does not exist
}

$envJson = @"
{
  "Variables": {
    "WAZE_FEED_URL": "$feedUrl",
    "DB_HOST": "$dbHost",
    "DB_NAME": "$dbName",
    "DB_USER": "$dbUser",
    "DB_PASSWORD": "$dbPassword",
    "DB_PORT": "$dbPort",
    "REDIS_REST_URL": "$redisRestUrl",
    "REDIS_REST_TOKEN": "$redisRestToken"
  }
}
"@
$envJsonFile = "env-vars.json"
Set-Content -Path $envJsonFile -Value $envJson

if ($funcExists) {
    Write-Host "Lambda function already exists. Updating deployment package..."
    & $awsPath lambda update-function-code --function-name waze-live-ingest --zip-file fileb://waze_etl_deployment.zip | Out-Null
    
    # Sleep to avoid background update conflicts
    Write-Host "Waiting 10 seconds for code update to finish in background..."
    Start-Sleep -Seconds 10

    Write-Host "Removing VPC configuration and updating environment..."
    & $awsPath lambda update-function-configuration --function-name waze-live-ingest --environment file://$envJsonFile --vpc-config "SubnetIds=[],SecurityGroupIds=[]" --timeout 60 --memory-size 128 | Out-Null
} else {
    Write-Host "Creating new Lambda function 'waze-live-ingest'..."
    & $awsPath lambda create-function --function-name waze-live-ingest --runtime python3.11 --role $roleArn --handler lambda_function.lambda_handler --zip-file fileb://waze_etl_deployment.zip --timeout 60 --memory-size 128 --environment file://$envJsonFile | Out-Null
}

# Clean up env file
if (Test-Path $envJsonFile) {
    Remove-Item $envJsonFile
}

$lambdaArn = & $awsPath lambda get-function --function-name waze-live-ingest --query "Configuration.FunctionArn" --output text
Write-Host "Lambda Function ready. ARN: $lambdaArn"

# 7. Create EventBridge rule
Write-Host "Creating EventBridge scheduling rule 'waze-ingest-every-2m'..."
$ruleArn = & $awsPath events put-rule --name waze-ingest-every-2m --schedule-expression "rate(2 minutes)" --state ENABLED --description "Trigger Waze Live Ingestion Lambda every 2 minutes" --query "RuleArn" --output text
Write-Host "EventBridge Rule ready. ARN: $ruleArn"

# 8. Set Lambda as trigger target for EventBridge rule
Write-Host "Linking EventBridge rule to Lambda target..."
& $awsPath events put-targets --rule waze-ingest-every-2m --targets "Id=1,Arn=$lambdaArn" | Out-Null

# 9. Add Permission for EventBridge to invoke Lambda
Write-Host "Adding invoking permissions to Lambda for EventBridge..."
try {
    & $awsPath lambda add-permission --function-name waze-live-ingest --statement-id waze-eventbridge-trigger --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn $ruleArn 2>$null | Out-Null
    Write-Host "Permissions added successfully."
} catch {
    Write-Host "Permissions statement already exists or could not be verified."
}

Write-Host "AWS Deployment Completed Successfully!"
Write-Host "Your ETL Pipeline is now running serverless every 2 minutes."
