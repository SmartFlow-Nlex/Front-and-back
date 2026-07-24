const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pg = require('pg');

const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

const BASE_DIR = 'C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\cleaned\\waze-cleaned';

// Helper to extract date and hour from a timestamp string (e.g. "2024-06-01 04:59:58 UTC")
function parseTime(tsString) {
  if (!tsString) return null;
  const match = tsString.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):/);
  if (match) {
    return { date: match[1], hour: parseInt(match[2], 10) };
  }
  return null;
}

// Memory stores for aggregation
const jamsAgg = new Map();
const alertsAgg = new Map();
const irregAgg = new Map();

async function initDB() {
  console.log('Initializing Aggregation Tables in PostgreSQL...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fact_hourly_jams (
      id BIGSERIAL PRIMARY KEY,
      date_day DATE NOT NULL,
      hour_of_day INTEGER NOT NULL,
      nlex_exit_id INTEGER,
      total_jam_reports INTEGER,
      avg_speed_kmh NUMERIC(8,2),
      max_delay_seconds INTEGER,
      avg_jam_level NUMERIC(4,2),
      UNIQUE(date_day, hour_of_day, nlex_exit_id)
    );

    CREATE TABLE IF NOT EXISTS fact_hourly_alerts (
      id BIGSERIAL PRIMARY KEY,
      date_day DATE NOT NULL,
      hour_of_day INTEGER NOT NULL,
      nlex_exit_id INTEGER,
      total_alerts INTEGER,
      hazard_count INTEGER,
      accident_count INTEGER,
      weather_count INTEGER,
      UNIQUE(date_day, hour_of_day, nlex_exit_id)
    );

    CREATE TABLE IF NOT EXISTS fact_hourly_irregularities (
      id BIGSERIAL PRIMARY KEY,
      date_day DATE NOT NULL,
      hour_of_day INTEGER NOT NULL,
      nlex_exit_id INTEGER,
      total_irregularities INTEGER,
      avg_speed_kmh NUMERIC(8,2),
      avg_regular_speed_kmh NUMERIC(8,2),
      max_delay_seconds INTEGER,
      max_severity INTEGER,
      UNIQUE(date_day, hour_of_day, nlex_exit_id)
    );
  `);
  console.log('Tables initialized successfully.');
}

async function aggregateFile(filePath, type) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      console.log(`File not found, skipping: ${filePath}`);
      return resolve();
    }

    console.log(`\nReading and aggregating: ${filePath}`);
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    let isFirstLine = true;
    let headerMap = {};
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount % 1000000 === 0) {
        console.log(`  Processed ${lineCount.toLocaleString()} rows...`);
      }

      if (isFirstLine) {
        const headers = line.split(',');
        headers.forEach((h, i) => headerMap[h.trim().toLowerCase()] = i);
        isFirstLine = false;
        return;
      }

      if (!line.trim()) return;

      // Basic CSV split (since we control the output now, it's fairly clean)
      const fields = line.split(',');

      let tsStr = type === 'irregularities' ? fields[headerMap['detectiondatets']] : fields[headerMap['ts']];
      let exitIdStr = fields[headerMap['nearest_exit_id']];
      
      const timeInfo = parseTime(tsStr);
      if (!timeInfo || !exitIdStr) return;

      const exitId = parseInt(exitIdStr, 10);
      if (Number.isNaN(exitId)) return;
      const key = `${timeInfo.date}_${timeInfo.hour}_${exitId}`;

      if (type === 'jams') {
        let speed = parseFloat(fields[headerMap['speedkmh']]) || 0;
        let delay = parseInt(fields[headerMap['delay']], 10) || 0;
        let level = parseInt(fields[headerMap['level']], 10) || 0;

        if (!jamsAgg.has(key)) {
          jamsAgg.set(key, { date: timeInfo.date, hour: timeInfo.hour, exitId, count: 0, sumSpeed: 0, maxDelay: 0, sumLevel: 0 });
        }
        let agg = jamsAgg.get(key);
        agg.count++;
        agg.sumSpeed += speed;
        if (delay > agg.maxDelay) agg.maxDelay = delay;
        agg.sumLevel += level;

      } else if (type === 'alerts') {
        let alertType = (fields[headerMap['type']] || '').toUpperCase();
        
        if (!alertsAgg.has(key)) {
          alertsAgg.set(key, { date: timeInfo.date, hour: timeInfo.hour, exitId, count: 0, hazards: 0, accidents: 0, weather: 0 });
        }
        let agg = alertsAgg.get(key);
        agg.count++;
        if (alertType.includes('HAZARD')) agg.hazards++;
        if (alertType.includes('ACCIDENT')) agg.accidents++;
        if (alertType.includes('WEATHER')) agg.weather++;

      } else if (type === 'irregularities') {
        let speed = parseFloat(fields[headerMap['speedkmh']]) || 0;
        let regularSpeed = parseFloat(fields[headerMap['regularspeed']]) || 0;
        let delay = parseInt(fields[headerMap['delayseconds']], 10) || 0;
        let severity = parseInt(fields[headerMap['severity']], 10) || 0;

        if (!irregAgg.has(key)) {
          irregAgg.set(key, { date: timeInfo.date, hour: timeInfo.hour, exitId, count: 0, sumSpeed: 0, sumRegSpeed: 0, maxDelay: 0, maxSeverity: 0 });
        }
        let agg = irregAgg.get(key);
        agg.count++;
        agg.sumSpeed += speed;
        agg.sumRegSpeed += regularSpeed;
        if (delay > agg.maxDelay) agg.maxDelay = delay;
        if (severity > agg.maxSeverity) agg.maxSeverity = severity;
      }
    });

    rl.on('close', () => {
      console.log(`Finished reading ${filePath} (${lineCount.toLocaleString()} rows). Memory Keys: Jams(${jamsAgg.size}), Alerts(${alertsAgg.size}), Irreg(${irregAgg.size})`);
      resolve();
    });
    rl.on('error', reject);
  });
}

async function bulkInsert(tableName, columns, dataRows) {
  if (dataRows.length === 0) return;
  console.log(`Inserting ${dataRows.length.toLocaleString()} aggregated rows into ${tableName}...`);
  
  const batchSize = 1000;
  for (let i = 0; i < dataRows.length; i += batchSize) {
    const batch = dataRows.slice(i, i + batchSize);
    
    // Construct parameterized query
    let valueStrings = [];
    let queryValues = [];
    let paramIndex = 1;
    
    for (const row of batch) {
      let rowParams = [];
      for (const val of row) {
        queryValues.push(val);
        rowParams.push(`$${paramIndex++}`);
      }
      valueStrings.push(`(${rowParams.join(',')})`);
    }
    
    const query = `
      INSERT INTO ${tableName} (${columns.join(',')}) 
      VALUES ${valueStrings.join(',')}
      ON CONFLICT (date_day, hour_of_day, nlex_exit_id) DO NOTHING
    `;
    
    await pool.query(query, queryValues);
    process.stdout.write(`\r  Inserted ${Math.min(i + batchSize, dataRows.length)} / ${dataRows.length}`);
  }
  console.log('\n');
}

async function main() {
  await initDB();

  // 1. Read files and aggregate in memory
  await aggregateFile(path.join(BASE_DIR, 'alerts', 'nlex_alerts_cleaned.csv'), 'alerts');
  await aggregateFile(path.join(BASE_DIR, 'irregularities', 'nlex_irregularities_cleaned.csv'), 'irregularities');
  await aggregateFile(path.join(BASE_DIR, 'jams', 'nlex_jams_cleaned.csv'), 'jams');

  console.log('\n=======================================');
  console.log('AGGREGATION COMPLETE. STARTING DB INSERT');
  console.log('=======================================');

  // 2. Prepare data arrays for bulk insert
  const alertData = [];
  for (const agg of alertsAgg.values()) {
    alertData.push([agg.date, agg.hour, agg.exitId, agg.count, agg.hazards, agg.accidents, agg.weather]);
  }

  function s(val) {
    if (val === 'NaN' || Number.isNaN(val)) return 0;
    return val;
  }

  const irregData = [];
  for (const agg of irregAgg.values()) {
    irregData.push([
      agg.date, agg.hour, agg.exitId, agg.count, 
      s((agg.sumSpeed / agg.count).toFixed(2)), 
      s((agg.sumRegSpeed / agg.count).toFixed(2)), 
      s(agg.maxDelay), s(agg.maxSeverity)
    ]);
  }

  const jamData = [];
  for (const agg of jamsAgg.values()) {
    jamData.push([
      agg.date, agg.hour, agg.exitId, agg.count, 
      s((agg.sumSpeed / agg.count).toFixed(2)), 
      s(agg.maxDelay), 
      s((agg.sumLevel / agg.count).toFixed(2))
    ]);
  }

  // 3. Insert into Database
  await bulkInsert('fact_hourly_alerts', 
    ['date_day', 'hour_of_day', 'nlex_exit_id', 'total_alerts', 'hazard_count', 'accident_count', 'weather_count'], 
    alertData);

  await bulkInsert('fact_hourly_irregularities', 
    ['date_day', 'hour_of_day', 'nlex_exit_id', 'total_irregularities', 'avg_speed_kmh', 'avg_regular_speed_kmh', 'max_delay_seconds', 'max_severity'], 
    irregData);

  await bulkInsert('fact_hourly_jams', 
    ['date_day', 'hour_of_day', 'nlex_exit_id', 'total_jam_reports', 'avg_speed_kmh', 'max_delay_seconds', 'avg_jam_level'], 
    jamData);

  console.log('All data inserted successfully! Pipeline Complete.');
  pool.end();
}

main().catch(err => {
  console.error('Fatal Error:', err);
  pool.end();
  process.exit(1);
});
