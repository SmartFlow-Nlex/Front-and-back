# lambda_function.py
import os
import json
import logging
import waze_etl

# Configure logging for AWS CloudWatch
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event, context):
    """
    AWS Lambda entry point. Triggered periodically (e.g. every 2 minutes)
    by AWS EventBridge Rules.
    """
    logger.info("Starting Waze Live ETL Lambda Invocation.")
    
    # Verify environment variables are present in Lambda configuration
    required_vars = ["WAZE_FEED_URL", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    
    if missing_vars:
        error_msg = f"Configuration Error: Missing environment variables in Lambda: {missing_vars}"
        logger.error(error_msg)
        return {
            'statusCode': 500,
            'body': json.dumps({'error': error_msg})
        }
    
    try:
        # Run the ETL cycle once
        waze_etl.run_etl()
        logger.info("Waze Live ETL Lambda completed successfully.")
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Waze live ingestion completed successfully.'})
        }
    except Exception as e:
        logger.error(f"ETL execution failed: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
