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

async function importCSV() {
  console.log('🚀 Starting CSV Import to AWS RDS...');
  const client = new Client(AWS_PG);
  await client.connect();

  console.log('📦 Creating table nlex_traffic_volume...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS nlex_traffic_volume (
      date DATE,
      direction TEXT,
      type TEXT,
      toll_plaza TEXT,
      vehicle_class TEXT,
      h00 INTEGER, h01 INTEGER, h02 INTEGER, h03 INTEGER, h04 INTEGER, h05 INTEGER,
      h06 INTEGER, h07 INTEGER, h08 INTEGER, h09 INTEGER, h10 INTEGER, h11 INTEGER,
      h12 INTEGER, h13 INTEGER, h14 INTEGER, h15 INTEGER, h16 INTEGER, h17 INTEGER,
      h18 INTEGER, h19 INTEGER, h20 INTEGER, h21 INTEGER, h22 INTEGER, h23 INTEGER
    );
    TRUNCATE TABLE nlex_traffic_volume;
  `);

  console.log('⏳ Streaming 75MB CSV across the ocean... this will take a minute...');
  
  const stream = client.query(copyFrom(`
    COPY nlex_traffic_volume (
      date, direction, type, toll_plaza, vehicle_class,
      h00, h01, h02, h03, h04, h05, h06, h07, h08, h09, h10, h11,
      h12, h13, h14, h15, h16, h17, h18, h19, h20, h21, h22, h23
    ) FROM STDIN WITH (FORMAT csv, HEADER true)
  `));

  const fileStream = fs.createReadStream('C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\traffic_volume_synthetic.csv');

  fileStream.on('error', (err) => {
    console.error('❌ File error:', err);
    client.end();
  });

  stream.on('error', (err) => {
    console.error('❌ Stream error:', err);
    client.end();
  });

  stream.on('finish', async () => {
    console.log('✅ CSV Import Complete!');
    
    // Check row count
    const res = await client.query('SELECT COUNT(*) FROM nlex_traffic_volume');
    console.log(`📊 Total rows in database: ${res.rows[0].count}`);
    
    client.end();
  });

  fileStream.pipe(stream);
}

importCSV().catch(console.error);
