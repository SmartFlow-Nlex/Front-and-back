from dotenv import load_dotenv
load_dotenv()  # DB credentials come from .env, never from source
import os
import pandas as pd
import glob
from sqlalchemy import create_engine

# Engine connection
engine = create_engine(os.environ["PG_URL"])

folder = 'C:/Users/Hans/.gemini/antigravity/scratch/2020_2021_synthetic'

mapping = {
    'apprehension_reports_2020_2021_synthetic.csv': 'apprehensions',
    'motorcycle_crash_reports_2020_2021_synthetic.csv': 'motorcycle_crashes',
    'road_crash_reports_2020_2021_synthetic.csv': 'road_crashes',
    'stalled_vehicles_reports_2020_2021_synthetic.csv': 'stalled_vehicles',
    'traffic_volume_2020_2021_synthetic.csv': 'traffic_volume'
}

column_mappings = {
    'apprehensions': {
        'No.': 'no', 'Date': 'date', 'Time': 'time', 'Vehicle Model': 'vehicle_model', 
        "Driver's Gender": 'driver_gender', 'Violation': 'violation', 'Action Taken': 'action_taken'
    },
    'motorcycle_crashes': {
        'No.': 'no', 'Date': 'date', 'Reported Time': 'reported_time', 'Response Time': 'response_time', 
        'Cleared Time': 'cleared_time', 'Location': 'location', 'Lane Occupied': 'lane_occupied', 
        'No. of Vehicles Involved': 'no_of_vehicles_involved', 'Cause of Accident': 'cause_of_accident', 
        'Type of Accident': 'type_of_accident', 'Weather Condition': 'weather_condition', 
        'Type of Pavement': 'type_of_pavement', 'No. of Injuries (Male)': 'injuries_male', 
        'No. of Injuries (Female)': 'injuries_female', 'No. of Fatalities (Male)': 'fatalities_male', 
        'No. of Fatalities (Female)': 'fatalities_female', 'Damage/s to Toll Road Property': 'damage_to_toll_property'
    },
    'road_crashes': {
        'No.': 'no', 'Date': 'date', 'Reported Time': 'reported_time', 'Response Time': 'response_time', 
        'Cleared Time': 'cleared_time', 'Location': 'location', 'Lane Occupied': 'lane_occupied', 
        'No. of Vehicles Involved': 'no_of_vehicles_involved', 'Cause of Accident': 'cause_of_accident', 
        'Type of Accident': 'type_of_accident', 'Weather Condition': 'weather_condition', 
        'Type of Pavement': 'type_of_pavement', 'No. of Injuries (Male)': 'injuries_male', 
        'No. of Injuries (Female)': 'injuries_female', 'No. of Fatalities (Male)': 'fatalities_male', 
        'No. of Fatalities (Female)': 'fatalities_female', 'Damage/s to Toll Road Property': 'damage_to_toll_property'
    },
    'stalled_vehicles': {
        'No.': 'no', 'Date': 'date', 'Reported Time': 'reported_time', 'Responded Time': 'responded_time', 
        'Cleared Time': 'cleared_time', 'Entry Point': 'entry_point', 'Vehicle Cause': 'vehicle_cause', 
        'Location': 'location', "Driver's Gender": 'driver_gender', 'Assistance Rendered': 'assistance_rendered', 
        'Remarks': 'remarks'
    },
    'traffic_volume': {
        'Date': 'date', 'Direction': 'direction', 'Type': 'type', 'Toll Plaza': 'toll_plaza', 'Vehicle Class': 'vehicle_class',
        '00:00': 'h00', '01:00': 'h01', '02:00': 'h02', '03:00': 'h03', '04:00': 'h04', '05:00': 'h05',
        '06:00': 'h06', '07:00': 'h07', '08:00': 'h08', '09:00': 'h09', '10:00': 'h10', '11:00': 'h11',
        '12:00': 'h12', '13:00': 'h13', '14:00': 'h14', '15:00': 'h15', '16:00': 'h16', '17:00': 'h17',
        '18:00': 'h18', '19:00': 'h19', '20:00': 'h20', '21:00': 'h21', '22:00': 'h22', '23:00': 'h23'
    }
}

for file, table in mapping.items():
    path = f"{folder}/{file}"
    try:
        print(f"Reading {file}...")
        df = pd.read_csv(path)
        
        # Check if there are unwanted index columns like Unnamed: 0
        if 'Unnamed: 0' in df.columns:
            df = df.drop(columns=['Unnamed: 0'])
            
        df = df.rename(columns=column_mappings[table])
            
        print(f"Uploading {len(df)} rows to bronze.{table}...")
        df.to_sql(table, engine, schema='bronze', if_exists='append', index=False)
        print(f"Successfully appended {table}!\n")
    except Exception as e:
        print(f"Error processing {table}: {e}\n")

engine.dispose()
