throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
/**
 * Ingest synthetic data into AWS Gold Layer (Datamart ONLY).
 * 
 * Logic:
 *   - Raw CSVs stay LOCAL only (bronze/silver)
 *   - ONLY aggregated datamart tables go to AWS gold schema
 * 
 * Tables populated:
 *   gold.daily_traffic_volume    — daily traffic by vehicle class (2020-2026)
 *   gold.daily_incident_summary  — daily incident counts by type (2020-2026)
 *   gold.incident_details        — individual incident records for drill-down
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const db = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  database: 'nlex_capstone',
  user: 'postgres',
  password: 'REMOVED',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const DATA_DIR = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/01_dataset';

function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] ? vals[idx].trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

async function run() {
  const client = await db.connect();
  try {
    console.log('=== Ingesting Synthetic Data into AWS Gold Layer ===\n');

    // ───────────────────────────────────────────────
    // STEP 1: Create gold datamart tables
    // ───────────────────────────────────────────────
    console.log('1) Creating gold datamart tables...');

    // Drop existing to start fresh
    await client.query(`DROP TABLE IF EXISTS gold.daily_traffic_volume CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS gold.daily_incident_summary CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS gold.incident_details CASCADE;`);

    // gold.daily_traffic_volume — aggregated daily traffic by vehicle class
    await client.query(`
      CREATE TABLE gold.daily_traffic_volume (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        day_of_week     TEXT,
        is_weekend      BOOLEAN DEFAULT false,
        month_name      TEXT,
        quarter         TEXT,
        volume_class1   BIGINT DEFAULT 0,
        volume_class2   BIGINT DEFAULT 0,
        volume_class3   BIGINT DEFAULT 0,
        total_volume    BIGINT DEFAULT 0,
        avg_speed_kmh   DOUBLE PRECISION,
        avg_jam_level   DOUBLE PRECISION,
        avg_temperature DOUBLE PRECISION,
        total_rainfall  DOUBLE PRECISION,
        avg_humidity    DOUBLE PRECISION,
        is_holiday      BOOLEAN DEFAULT false,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.daily_traffic_volume');

    // gold.daily_incident_summary — aggregated daily incident counts
    await client.query(`
      CREATE TABLE gold.daily_incident_summary (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        day_of_week     TEXT,
        is_weekend      BOOLEAN DEFAULT false,
        total_incidents INTEGER DEFAULT 0,
        crash_count     INTEGER DEFAULT 0,
        stall_count     INTEGER DEFAULT 0,
        total_injuries  INTEGER DEFAULT 0,
        total_fatalities INTEGER DEFAULT 0,
        avg_clearance_min DOUBLE PRECISION,
        avg_vehicles_involved DOUBLE PRECISION,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.daily_incident_summary');

    // gold.incident_details — individual incident records
    await client.query(`
      CREATE TABLE gold.incident_details (
        id                    BIGSERIAL PRIMARY KEY,
        incident_date         DATE NOT NULL,
        hour_of_day           INTEGER,
        location              TEXT,
        km_value              DOUBLE PRECISION,
        nearest_exit          TEXT,
        incident_type         TEXT,
        no_of_vehicles        INTEGER,
        cause_of_accident     TEXT,
        type_of_accident      TEXT,
        weather_condition     TEXT,
        injuries_male         INTEGER DEFAULT 0,
        injuries_female       INTEGER DEFAULT 0,
        fatalities_male       INTEGER DEFAULT 0,
        fatalities_female     INTEGER DEFAULT 0,
        total_injuries        INTEGER DEFAULT 0,
        total_fatalities      INTEGER DEFAULT 0,
        clearance_minutes     DOUBLE PRECISION,
        severity              TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.incident_details');

    // Create indexes
    await client.query(`CREATE INDEX idx_gold_traffic_vol_date ON gold.daily_traffic_volume(date);`);
    await client.query(`CREATE INDEX idx_gold_incident_sum_date ON gold.daily_incident_summary(date);`);
    await client.query(`CREATE INDEX idx_gold_incident_det_date ON gold.incident_details(incident_date);`);
    await client.query(`CREATE INDEX idx_gold_incident_det_type ON gold.incident_details(incident_type);`);
    console.log('   ✅ Indexes created.\n');

    // ───────────────────────────────────────────────
    // STEP 2: Aggregate & ingest traffic volume data
    // ───────────────────────────────────────────────
    console.log('2) Ingesting traffic volume data (daily aggregates)...');
    const trafficFile = path.join(DATA_DIR, 'traffic_speed_dataset.csv');
    const trafficRows = parseCSV(trafficFile);
    console.log(`   Read ${trafficRows.length} hourly rows from traffic_speed_dataset.csv`);

    // Aggregate hourly → daily
    const dailyTraffic = {};
    for (const row of trafficRows) {
      const date = row.date_day;
      if (!date || date === '') continue;
      if (!dailyTraffic[date]) {
        dailyTraffic[date] = {
          date,
          day_of_week: row.day_of_week || '',
          is_weekend: row.is_weekend === '1',
          month_name: row.month_name || '',
          quarter: row.quarter || '',
          volume_class1: 0,
          volume_class2: 0,
          volume_class3: 0,
          total_volume: 0,
          speed_sum: 0,
          jam_sum: 0,
          temp_sum: 0,
          rain_sum: 0,
          humidity_sum: 0,
          is_holiday: row.is_holiday === '1',
          count: 0,
        };
      }
      const d = dailyTraffic[date];
      d.volume_class1 += parseFloat(row.volume_class1 || '0');
      d.volume_class2 += parseFloat(row.volume_class2 || '0');
      d.volume_class3 += parseFloat(row.volume_class3 || '0');
      d.total_volume += parseFloat(row.total_volume || row.Total || '0');
      d.speed_sum += parseFloat(row.avg_speed_kmh || '0');
      d.jam_sum += parseFloat(row.avg_jam_level || '0');
      d.temp_sum += parseFloat(row.temperature || '0');
      d.rain_sum += parseFloat(row.rainfall || '0');
      d.humidity_sum += parseFloat(row.humidity || '0');
      if (row.is_holiday === '1') d.is_holiday = true;
      d.count++;
    }

    const dailyTrafficArr = Object.values(dailyTraffic);
    console.log(`   Aggregated into ${dailyTrafficArr.length} daily records`);

    // Batch insert in chunks of 100
    let inserted = 0;
    const CHUNK = 100;
    for (let i = 0; i < dailyTrafficArr.length; i += CHUNK) {
      const chunk = dailyTrafficArr.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const d of chunk) {
        const avgSpeed = d.count > 0 ? (d.speed_sum / d.count) : null;
        const avgJam = d.count > 0 ? (d.jam_sum / d.count) : null;
        const avgTemp = d.count > 0 ? (d.temp_sum / d.count) : null;
        const avgHumidity = d.count > 0 ? (d.humidity_sum / d.count) : null;

        values.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9},$${paramIdx+10},$${paramIdx+11},$${paramIdx+12},$${paramIdx+13})`);
        params.push(
          d.date, d.day_of_week, d.is_weekend, d.month_name, d.quarter,
          Math.round(d.volume_class1), Math.round(d.volume_class2), Math.round(d.volume_class3), Math.round(d.total_volume),
          avgSpeed ? +avgSpeed.toFixed(2) : null,
          avgJam ? +avgJam.toFixed(2) : null,
          avgTemp ? +avgTemp.toFixed(1) : null,
          d.rain_sum ? +d.rain_sum.toFixed(1) : 0,
          avgHumidity ? +avgHumidity.toFixed(1) : null
        );
        paramIdx += 14;
      }

      await client.query(`
        INSERT INTO gold.daily_traffic_volume 
          (date, day_of_week, is_weekend, month_name, quarter,
           volume_class1, volume_class2, volume_class3, total_volume,
           avg_speed_kmh, avg_jam_level, avg_temperature, total_rainfall, avg_humidity)
        VALUES ${values.join(',')}
      `, params);
      inserted += chunk.length;
      if (inserted % 500 === 0 || inserted === dailyTrafficArr.length) {
        console.log(`   Inserted ${inserted} / ${dailyTrafficArr.length} daily traffic records`);
      }
    }
    console.log(`   ✅ Traffic volume: ${inserted} daily records ingested.\n`);

    // ───────────────────────────────────────────────
    // STEP 3: Aggregate & ingest incident summary data
    // ───────────────────────────────────────────────
    console.log('3) Ingesting incident summary data (daily aggregates)...');
    const incidentGlobalFile = path.join(DATA_DIR, 'incident_dataset_global.csv');
    const incidentRows = parseCSV(incidentGlobalFile);
    console.log(`   Read ${incidentRows.length} hourly rows from incident_dataset_global.csv`);

    // Aggregate hourly → daily
    const dailyIncidents = {};
    for (const row of incidentRows) {
      const date = row.date_day;
      if (!date || date === '') continue;
      if (!dailyIncidents[date]) {
        dailyIncidents[date] = {
          date,
          day_of_week: row.day_of_week || '',
          is_weekend: row.is_weekend === '1',
          total_incidents: 0,
          crash_count: 0,
          stall_count: 0,
          total_injuries: 0,
          total_fatalities: 0,
          clearance_sum: 0,
          vehicles_sum: 0,
          incident_hours: 0,
        };
      }
      const d = dailyIncidents[date];
      d.total_incidents += parseInt(row.incident_count || '0');
      d.crash_count += parseInt(row.crash_count || '0');
      d.stall_count += parseInt(row.stall_count || '0');
      d.total_injuries += parseInt(row.total_injuries || '0');
      d.total_fatalities += parseInt(row.total_fatalities || '0');
      const cl = parseFloat(row.avg_clearance_min || '0');
      const ve = parseFloat(row.avg_vehicles_involved || '0');
      if (cl > 0 || ve > 0) {
        d.clearance_sum += cl;
        d.vehicles_sum += ve;
        d.incident_hours++;
      }
    }

    const dailyIncArr = Object.values(dailyIncidents);
    console.log(`   Aggregated into ${dailyIncArr.length} daily records`);

    inserted = 0;
    for (let i = 0; i < dailyIncArr.length; i += CHUNK) {
      const chunk = dailyIncArr.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const d of chunk) {
        const avgCl = d.incident_hours > 0 ? (d.clearance_sum / d.incident_hours) : 0;
        const avgVe = d.incident_hours > 0 ? (d.vehicles_sum / d.incident_hours) : 0;

        values.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9})`);
        params.push(
          d.date, d.day_of_week, d.is_weekend,
          d.total_incidents, d.crash_count, d.stall_count,
          d.total_injuries, d.total_fatalities,
          avgCl ? +avgCl.toFixed(1) : 0,
          avgVe ? +avgVe.toFixed(1) : 0
        );
        paramIdx += 10;
      }

      await client.query(`
        INSERT INTO gold.daily_incident_summary
          (date, day_of_week, is_weekend,
           total_incidents, crash_count, stall_count,
           total_injuries, total_fatalities,
           avg_clearance_min, avg_vehicles_involved)
        VALUES ${values.join(',')}
      `, params);
      inserted += chunk.length;
      if (inserted % 500 === 0 || inserted === dailyIncArr.length) {
        console.log(`   Inserted ${inserted} / ${dailyIncArr.length} daily incident records`);
      }
    }
    console.log(`   ✅ Incident summary: ${inserted} daily records ingested.\n`);

    // ───────────────────────────────────────────────
    // STEP 4: Ingest individual incident details
    // ───────────────────────────────────────────────
    console.log('4) Ingesting individual incident details...');
    const incidentDetailFile = path.join(DATA_DIR, 'incidents_raw_combined.csv');
    const detailRows = parseCSV(incidentDetailFile);
    console.log(`   Read ${detailRows.length} incident records from incidents_raw_combined.csv`);

    inserted = 0;
    for (let i = 0; i < detailRows.length; i += CHUNK) {
      const chunk = detailRows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const r of chunk) {
        values.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9},$${paramIdx+10},$${paramIdx+11},$${paramIdx+12},$${paramIdx+13},$${paramIdx+14},$${paramIdx+15},$${paramIdx+16})`);
        params.push(
          r.incident_date || null,
          parseInt(r.hour_of_day || '0'),
          r.location || '',
          parseFloat(r.km_value || '0'),
          r.nearest_exit || '',
          r.incident_type || '',
          parseInt(r.no_of_vehicles_involved || '0'),
          r.cause_of_accident || '',
          r.type_of_accident || '',
          r.weather_condition || '',
          parseInt(r.no_of_injuries_male || '0'),
          parseInt(r.no_of_injuries_female || '0'),
          parseInt(r.no_of_fatalities_male || '0'),
          parseInt(r.no_of_fatalities_female || '0'),
          parseInt(r.total_injuries || '0'),
          parseInt(r.total_fatalities || '0'),
          parseFloat(r.clearance_minutes || '0')
        );
        paramIdx += 17;
      }

      await client.query(`
        INSERT INTO gold.incident_details
          (incident_date, hour_of_day, location, km_value, nearest_exit,
           incident_type, no_of_vehicles, cause_of_accident, type_of_accident,
           weather_condition, injuries_male, injuries_female,
           fatalities_male, fatalities_female, total_injuries, total_fatalities,
           clearance_minutes)
        VALUES ${values.join(',')}
      `, params);
      inserted += chunk.length;
      if (inserted % 1000 === 0 || inserted === detailRows.length) {
        console.log(`   Inserted ${inserted} / ${detailRows.length} incident detail records`);
      }
    }
    console.log(`   ✅ Incident details: ${inserted} records ingested.\n`);

    // ───────────────────────────────────────────────
    // STEP 5: Verify
    // ───────────────────────────────────────────────
    console.log('5) Verifying...');
    const trafficCount = await client.query('SELECT COUNT(*) as cnt, MIN(date) as min_date, MAX(date) as max_date FROM gold.daily_traffic_volume');
    console.log(`   gold.daily_traffic_volume: ${trafficCount.rows[0].cnt} rows (${trafficCount.rows[0].min_date} → ${trafficCount.rows[0].max_date})`);

    const incSumCount = await client.query('SELECT COUNT(*) as cnt, MIN(date) as min_date, MAX(date) as max_date FROM gold.daily_incident_summary');
    console.log(`   gold.daily_incident_summary: ${incSumCount.rows[0].cnt} rows (${incSumCount.rows[0].min_date} → ${incSumCount.rows[0].max_date})`);

    const incDetCount = await client.query('SELECT COUNT(*) as cnt, MIN(incident_date) as min_date, MAX(incident_date) as max_date FROM gold.incident_details');
    console.log(`   gold.incident_details: ${incDetCount.rows[0].cnt} rows (${incDetCount.rows[0].min_date} → ${incDetCount.rows[0].max_date})`);

    // Quick sample
    const sampleTraffic = await client.query('SELECT date, volume_class1, volume_class2, volume_class3, total_volume FROM gold.daily_traffic_volume ORDER BY date LIMIT 3');
    console.log('\n   Sample traffic data:');
    sampleTraffic.rows.forEach(r => console.log(`     ${r.date}: C1=${r.volume_class1} C2=${r.volume_class2} C3=${r.volume_class3} Total=${r.total_volume}`));

    const sampleInc = await client.query('SELECT date, total_incidents, crash_count, stall_count FROM gold.daily_incident_summary WHERE total_incidents > 0 ORDER BY date LIMIT 3');
    console.log('   Sample incident data:');
    sampleInc.rows.forEach(r => console.log(`     ${r.date}: incidents=${r.total_incidents} crashes=${r.crash_count} stalls=${r.stall_count}`));

    console.log('\n=== ✅ GOLD LAYER DATAMART INGESTION COMPLETE ===');

  } finally {
    client.release();
    await db.end();
  }
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
