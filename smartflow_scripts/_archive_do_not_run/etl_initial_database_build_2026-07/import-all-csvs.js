throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';
import fs from 'fs';
import pgCopyStreams from 'pg-copy-streams';
const { Client } = pg;
const { from: copyFrom } = pgCopyStreams;

const AWS_PG = {
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
};

const TABLES = [
  {
    name: 'nlex_apprehensions',
    file: 'C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\apprehension_reports_synthetic.csv',
    schema: `
      no INTEGER,
      date TEXT,
      time TEXT,
      vehicle_model TEXT,
      driver_gender TEXT,
      violation TEXT,
      action_taken TEXT
    `,
    columns: 'no, date, time, vehicle_model, driver_gender, violation, action_taken'
  },
  {
    name: 'nlex_motorcycle_crashes',
    file: 'C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\motorcycle_crash_reports_synthetic.csv',
    schema: `
      no INTEGER,
      date TEXT,
      reported_time TEXT,
      response_time TEXT,
      cleared_time TEXT,
      location TEXT,
      lane_occupied TEXT,
      no_of_vehicles_involved INTEGER,
      cause_of_accident TEXT,
      type_of_accident TEXT,
      weather_condition TEXT,
      type_of_pavement TEXT,
      injuries_male INTEGER,
      injuries_female INTEGER,
      fatalities_male INTEGER,
      fatalities_female INTEGER,
      damage_to_toll_property TEXT
    `,
    columns: 'no, date, reported_time, response_time, cleared_time, location, lane_occupied, no_of_vehicles_involved, cause_of_accident, type_of_accident, weather_condition, type_of_pavement, injuries_male, injuries_female, fatalities_male, fatalities_female, damage_to_toll_property'
  },
  {
    name: 'nlex_road_crashes',
    file: 'C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\road_crash_reports_synthetic.csv',
    schema: `
      no INTEGER,
      date TEXT,
      reported_time TEXT,
      response_time TEXT,
      cleared_time TEXT,
      location TEXT,
      lane_occupied TEXT,
      no_of_vehicles_involved INTEGER,
      cause_of_accident TEXT,
      type_of_accident TEXT,
      weather_condition TEXT,
      type_of_pavement TEXT,
      injuries_male INTEGER,
      injuries_female INTEGER,
      fatalities_male INTEGER,
      fatalities_female INTEGER,
      damage_to_toll_property TEXT
    `,
    columns: 'no, date, reported_time, response_time, cleared_time, location, lane_occupied, no_of_vehicles_involved, cause_of_accident, type_of_accident, weather_condition, type_of_pavement, injuries_male, injuries_female, fatalities_male, fatalities_female, damage_to_toll_property'
  },
  {
    name: 'nlex_stalled_vehicles',
    file: 'C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\stalled_vehicles_reports_synthetic.csv',
    schema: `
      no INTEGER,
      date TEXT,
      reported_time TEXT,
      responded_time TEXT,
      cleared_time TEXT,
      entry_point TEXT,
      vehicle_cause TEXT,
      location TEXT,
      driver_gender TEXT,
      assistance_rendered TEXT,
      remarks TEXT
    `,
    columns: 'no, date, reported_time, responded_time, cleared_time, entry_point, vehicle_cause, location, driver_gender, assistance_rendered, remarks'
  }
];

async function importAll() {
  const client = new Client(AWS_PG);
  await client.connect();
  
  for (const table of TABLES) {
    console.log(`📦 Creating table ${table.name}...`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${table.name} (
        ${table.schema}
      );
      TRUNCATE TABLE ${table.name};
    `);

    console.log(`⏳ Streaming ${table.file} into ${table.name}...`);
    
    await new Promise((resolve, reject) => {
      const stream = client.query(copyFrom(`
        COPY ${table.name} (${table.columns}) FROM STDIN WITH (FORMAT csv, HEADER true)
      `));
      
      const fileStream = fs.createReadStream(table.file);
      
      fileStream.on('error', reject);
      stream.on('error', reject);
      stream.on('finish', resolve);
      
      fileStream.pipe(stream);
    });
    
    const res = await client.query(`SELECT COUNT(*) FROM ${table.name}`);
    console.log(`✅ Loaded ${res.rows[0].count} rows into ${table.name}`);
  }
  
  await client.end();
  console.log('🎉 All files imported successfully!');
}

importAll().catch(console.error);
