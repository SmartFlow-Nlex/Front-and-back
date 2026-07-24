const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── NLEX Corridor Configuration ─────────────────────────────
// Bounding box from nlex_exits table + 1km buffer
const NLEX_BOUNDS = {
  minLat: 14.669,
  maxLat: 15.232,
  minLon: 120.578,
  maxLon: 121.010
};

// Maximum distance (km) from any NLEX exit to be considered "on the corridor"
const MAX_DISTANCE_KM = 3.0;

// NLEX Exits (20 physical locations from database)
const NLEX_EXITS = [
  { id: 1,  name: 'Balintawak',                lat: 14.6788, lon: 121.0003 },
  { id: 2,  name: 'Mindanao Ave / Bignay',     lat: 14.6862, lon: 120.9913 },
  { id: 3,  name: 'Karuhatan',                 lat: 14.7064, lon: 120.9703 },
  { id: 4,  name: 'Valenzuela',                lat: 14.7117, lon: 120.9622 },
  { id: 5,  name: 'Meycauayan',                lat: 14.7346, lon: 120.9508 },
  { id: 6,  name: 'Marilao',                   lat: 14.7578, lon: 120.9484 },
  { id: 7,  name: 'Bocaue',                    lat: 14.7976, lon: 120.9316 },
  { id: 8,  name: 'Balagtas',                  lat: 14.8148, lon: 120.9130 },
  { id: 9,  name: 'Tabang',                    lat: 14.8379, lon: 120.8900 },
  { id: 10, name: 'Plaridel',                  lat: 14.8710, lon: 120.8630 },
  { id: 11, name: 'Pulilan',                   lat: 14.8948, lon: 120.8471 },
  { id: 12, name: 'Calumpit',                  lat: 14.9168, lon: 120.8235 },
  { id: 13, name: 'Apalit',                    lat: 14.9520, lon: 120.7640 },
  { id: 14, name: 'San Simon',                 lat: 14.9843, lon: 120.7293 },
  { id: 15, name: 'San Fernando',              lat: 15.0282, lon: 120.6882 },
  { id: 16, name: 'Mexico',                    lat: 15.0659, lon: 120.6571 },
  { id: 17, name: 'Angeles',                   lat: 15.0936, lon: 120.6369 },
  { id: 18, name: 'Dau / Mabalacat',           lat: 15.1468, lon: 120.5966 },
  { id: 19, name: 'Sta. Ines / SCTEX',         lat: 15.1742, lon: 120.5896 },
  { id: 20, name: 'Tipo / TPLEX',              lat: 15.2220, lon: 120.5878 }
];

// ── Haversine Distance ──────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Find the nearest NLEX exit and its distance
function findNearestExit(lat, lon) {
  let minDist = Infinity;
  let nearestExit = null;
  for (const exit of NLEX_EXITS) {
    const dist = haversineKm(lat, lon, exit.lat, exit.lon);
    if (dist < minDist) {
      minDist = dist;
      nearestExit = exit;
    }
  }
  return { exit: nearestExit, distanceKm: minDist };
}

// ── Coordinate Parsing ──────────────────────────────────────
// Parse POINT(lon lat) → { lat, lon }
function parsePoint(geoStr) {
  if (!geoStr) return null;
  const m = geoStr.match(/POINT\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return null;
  return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

// Parse LINESTRING(lon lat, lon lat, ...) → [{ lat, lon }, ...]
function parseLineString(geoStr) {
  if (!geoStr) return [];
  const m = geoStr.match(/LINESTRING\((.+)\)/i);
  if (!m) return [];
  const points = [];
  const pairs = m[1].split(',');
  for (const pair of pairs) {
    const parts = pair.trim().split(/\s+/);
    if (parts.length >= 2) {
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lon) && !isNaN(lat)) {
        points.push({ lon, lat });
      }
    }
  }
  return points;
}

// Check if a point is within the NLEX bounding box (quick rejection)
function isInBoundingBox(lat, lon) {
  return lat >= NLEX_BOUNDS.minLat && lat <= NLEX_BOUNDS.maxLat &&
         lon >= NLEX_BOUNDS.minLon && lon <= NLEX_BOUNDS.maxLon;
}

// ── CSV Parsing (handles quoted fields with commas) ─────────
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Process a single CSV file ───────────────────────────────
async function processFile(filePath, dataType, headerMap, outputStream) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    let lineNum = 0;
    let kept = 0;
    let discarded = 0;
    let isFirstLine = true;

    rl.on('line', (line) => {
      lineNum++;

      // Skip header
      if (isFirstLine) {
        isFirstLine = false;
        return;
      }

      // Skip empty lines
      if (!line.trim()) return;

      const fields = parseCSVLine(line);
      
      let matchPoint = null;
      let nearestResult = null;

      if (dataType === 'alerts') {
        // Alerts: geo column is POINT format
        const geoIdx = headerMap['geo'];
        if (geoIdx === undefined || !fields[geoIdx]) { discarded++; return; }
        
        const pt = parsePoint(fields[geoIdx]);
        if (!pt) { discarded++; return; }

        // Quick bounding box check
        if (!isInBoundingBox(pt.lat, pt.lon)) { discarded++; return; }

        // Precise corridor check
        nearestResult = findNearestExit(pt.lat, pt.lon);
        if (nearestResult.distanceKm > MAX_DISTANCE_KM) { discarded++; return; }

        matchPoint = pt;

      } else if (dataType === 'jams') {
        // Jams: geo column is LINESTRING format
        const geoIdx = headerMap['geo'];
        if (geoIdx === undefined || !fields[geoIdx]) { discarded++; return; }

        const points = parseLineString(fields[geoIdx]);
        if (points.length === 0) { discarded++; return; }

        // Check if ANY point in the linestring is within NLEX corridor
        let bestResult = null;
        let bestPoint = null;
        for (const pt of points) {
          if (!isInBoundingBox(pt.lat, pt.lon)) continue;
          const result = findNearestExit(pt.lat, pt.lon);
          if (result.distanceKm <= MAX_DISTANCE_KM) {
            if (!bestResult || result.distanceKm < bestResult.distanceKm) {
              bestResult = result;
              bestPoint = pt;
            }
          }
        }

        if (!bestResult) { discarded++; return; }
        nearestResult = bestResult;
        matchPoint = bestPoint;

      } else if (dataType === 'irregularities') {
        // Irregularities: geo column is LINESTRING format
        const geoIdx = headerMap['geo'];
        if (geoIdx === undefined || !fields[geoIdx]) { discarded++; return; }

        const points = parseLineString(fields[geoIdx]);
        if (points.length === 0) { discarded++; return; }

        // Check if ANY point in the linestring is within NLEX corridor
        let bestResult = null;
        let bestPoint = null;
        for (const pt of points) {
          if (!isInBoundingBox(pt.lat, pt.lon)) continue;
          const result = findNearestExit(pt.lat, pt.lon);
          if (result.distanceKm <= MAX_DISTANCE_KM) {
            if (!bestResult || result.distanceKm < bestResult.distanceKm) {
              bestResult = result;
              bestPoint = pt;
            }
          }
        }

        if (!bestResult) { discarded++; return; }
        nearestResult = bestResult;
        matchPoint = bestPoint;
      }

      // Row passed all filters — write to output
      // Append: nearest_exit_id, nearest_exit_name, match_lat, match_lon, distance_km
      const enrichedLine = line + ',' +
        nearestResult.exit.id + ',' +
        '"' + nearestResult.exit.name + '",' +
        matchPoint.lat.toFixed(6) + ',' +
        matchPoint.lon.toFixed(6) + ',' +
        nearestResult.distanceKm.toFixed(3);

      outputStream.write(enrichedLine + '\n');
      kept++;
    });

    rl.on('close', () => resolve({ kept, discarded, lines: lineNum - 1 }));
    rl.on('error', reject);
  });
}

// ── Main Pipeline ───────────────────────────────────────────
async function main() {
  const WAZE_BASE = path.join(__dirname, '..', 'Waze Parntner Hub');
  const OUTPUT_BASE = path.join(__dirname, 'waze-cleaned');

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  🚗 WAZE PARTNER HUB → NLEX CORRIDOR ETL PIPELINE');
  console.log('  Following Manuscript Section 3.2.1.2.1 Pipeline Architecture');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  NLEX Bounding Box: Lat [${NLEX_BOUNDS.minLat}, ${NLEX_BOUNDS.maxLat}]`);
  console.log(`                     Lon [${NLEX_BOUNDS.minLon}, ${NLEX_BOUNDS.maxLon}]`);
  console.log(`  Max Distance from Exit: ${MAX_DISTANCE_KM} km`);
  console.log(`  NLEX Exits: ${NLEX_EXITS.length} physical locations`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // Create output directories
  const outputDirs = ['alerts', 'irregularities', 'jams'];
  for (const dir of outputDirs) {
    fs.mkdirSync(path.join(OUTPUT_BASE, dir), { recursive: true });
  }

  const grandStats = { alerts: { kept: 0, discarded: 0, files: 0 }, irregularities: { kept: 0, discarded: 0, files: 0 }, jams: { kept: 0, discarded: 0, files: 0 } };

  // ── PHASE 1: ALERTS ─────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📢 PHASE 1: Processing ALERTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const alertsDir = path.join(WAZE_BASE, 'alerts');
  const alertFiles = fs.readdirSync(alertsDir).filter(f => f.endsWith('.csv')).sort();
  
  // Read header from first file
  const alertHeader = fs.readFileSync(path.join(alertsDir, alertFiles[0]), 'utf-8').split('\n')[0].trim();
  const alertHeaderFields = alertHeader.split(',');
  const alertHeaderMap = {};
  alertHeaderFields.forEach((h, i) => alertHeaderMap[h.trim().toLowerCase()] = i);

  // Single output file for all alerts
  const alertOutPath = path.join(OUTPUT_BASE, 'alerts', 'nlex_alerts_cleaned.csv');
  const alertOut = fs.createWriteStream(alertOutPath);
  alertOut.write(alertHeader + ',nearest_exit_id,nearest_exit_name,match_lat,match_lon,distance_km\n');

  for (let i = 0; i < alertFiles.length; i++) {
    const file = alertFiles[i];
    const filePath = path.join(alertsDir, file);
    const startTime = Date.now();
    
    const stats = await processFile(filePath, 'alerts', alertHeaderMap, alertOut);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    grandStats.alerts.kept += stats.kept;
    grandStats.alerts.discarded += stats.discarded;
    grandStats.alerts.files++;

    console.log(`  [${i + 1}/${alertFiles.length}] ${file} → ✅ ${stats.kept.toLocaleString()} kept / ❌ ${stats.discarded.toLocaleString()} discarded (${elapsed}s)`);
  }

  alertOut.end();
  console.log(`\n  📢 ALERTS COMPLETE: ${grandStats.alerts.kept.toLocaleString()} NLEX rows kept from ${grandStats.alerts.discarded.toLocaleString() + grandStats.alerts.kept.toLocaleString()} total\n`);

  // ── PHASE 2: IRREGULARITIES ─────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ⚠️  PHASE 2: Processing IRREGULARITIES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const irregDir = path.join(WAZE_BASE, 'irregularities');
  const irregFiles = fs.readdirSync(irregDir).filter(f => f.endsWith('.csv')).sort();

  const irregHeader = fs.readFileSync(path.join(irregDir, irregFiles[0]), 'utf-8').split('\n')[0].trim();
  const irregHeaderFields = irregHeader.split(',');
  const irregHeaderMap = {};
  irregHeaderFields.forEach((h, i) => irregHeaderMap[h.trim().toLowerCase()] = i);

  const irregOutPath = path.join(OUTPUT_BASE, 'irregularities', 'nlex_irregularities_cleaned.csv');
  const irregOut = fs.createWriteStream(irregOutPath);
  irregOut.write(irregHeader + ',nearest_exit_id,nearest_exit_name,match_lat,match_lon,distance_km\n');

  for (let i = 0; i < irregFiles.length; i++) {
    const file = irregFiles[i];
    const filePath = path.join(irregDir, file);
    const startTime = Date.now();

    const stats = await processFile(filePath, 'irregularities', irregHeaderMap, irregOut);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    grandStats.irregularities.kept += stats.kept;
    grandStats.irregularities.discarded += stats.discarded;
    grandStats.irregularities.files++;

    if ((i + 1) % 10 === 0 || i === irregFiles.length - 1) {
      console.log(`  [${i + 1}/${irregFiles.length}] ${file} → ✅ ${stats.kept.toLocaleString()} kept / ❌ ${stats.discarded.toLocaleString()} discarded (${elapsed}s) | Running total: ${grandStats.irregularities.kept.toLocaleString()} NLEX rows`);
    }
  }

  irregOut.end();
  console.log(`\n  ⚠️  IRREGULARITIES COMPLETE: ${grandStats.irregularities.kept.toLocaleString()} NLEX rows kept\n`);

  // ── PHASE 3: JAMS ───────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🚦 PHASE 3: Processing JAMS (largest dataset ~180 GB)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const jamsBaseDir = path.join(WAZE_BASE, 'jams');
  const jamYears = fs.readdirSync(jamsBaseDir).filter(d => fs.statSync(path.join(jamsBaseDir, d)).isDirectory()).sort();

  let jamsHeaderWritten = false;
  let jamsHeader = '';
  let jamsHeaderMap = {};

  const jamsOutPath = path.join(OUTPUT_BASE, 'jams', 'nlex_jams_cleaned.csv');
  const jamsOut = fs.createWriteStream(jamsOutPath);

  let totalJamFiles = 0;
  let processedJamFiles = 0;

  // Count total files first
  for (const year of jamYears) {
    const yearDir = path.join(jamsBaseDir, year);
    const files = fs.readdirSync(yearDir).filter(f => f.endsWith('.csv'));
    totalJamFiles += files.length;
  }

  for (const year of jamYears) {
    const yearDir = path.join(jamsBaseDir, year);
    const files = fs.readdirSync(yearDir).filter(f => f.endsWith('.csv')).sort();

    console.log(`\n  📅 Processing ${year} (${files.length} files)...`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(yearDir, file);

      // Read header from first jam file
      if (!jamsHeaderWritten) {
        jamsHeader = fs.readFileSync(filePath, 'utf-8').split('\n')[0].trim();
        const jamsHeaderFields = jamsHeader.split(',');
        jamsHeaderFields.forEach((h, idx) => jamsHeaderMap[h.trim().toLowerCase()] = idx);
        jamsOut.write(jamsHeader + ',nearest_exit_id,nearest_exit_name,match_lat,match_lon,distance_km\n');
        jamsHeaderWritten = true;
      }

      const startTime = Date.now();
      const stats = await processFile(filePath, 'jams', jamsHeaderMap, jamsOut);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      grandStats.jams.kept += stats.kept;
      grandStats.jams.discarded += stats.discarded;
      grandStats.jams.files++;
      processedJamFiles++;

      // Print progress every 25 files or on last file
      if (processedJamFiles % 25 === 0 || i === files.length - 1) {
        const pct = ((processedJamFiles / totalJamFiles) * 100).toFixed(1);
        console.log(`  [${processedJamFiles}/${totalJamFiles}] (${pct}%) ${year}/${file} → ✅ ${stats.kept.toLocaleString()} kept (${elapsed}s) | Total NLEX jams: ${grandStats.jams.kept.toLocaleString()}`);
      }
    }
  }

  jamsOut.end();
  console.log(`\n  🚦 JAMS COMPLETE: ${grandStats.jams.kept.toLocaleString()} NLEX rows kept\n`);

  // ── FINAL SUMMARY ───────────────────────────────────────
  const totalKept = grandStats.alerts.kept + grandStats.irregularities.kept + grandStats.jams.kept;
  const totalDiscarded = grandStats.alerts.discarded + grandStats.irregularities.discarded + grandStats.jams.discarded;
  const totalProcessed = totalKept + totalDiscarded;

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  📊 ETL PIPELINE COMPLETE — FINAL SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  📢 Alerts:          ${grandStats.alerts.kept.toLocaleString()} NLEX rows (from ${(grandStats.alerts.kept + grandStats.alerts.discarded).toLocaleString()} total)`);
  console.log(`  ⚠️  Irregularities:  ${grandStats.irregularities.kept.toLocaleString()} NLEX rows (from ${(grandStats.irregularities.kept + grandStats.irregularities.discarded).toLocaleString()} total)`);
  console.log(`  🚦 Jams:            ${grandStats.jams.kept.toLocaleString()} NLEX rows (from ${(grandStats.jams.kept + grandStats.jams.discarded).toLocaleString()} total)`);
  console.log('  ──────────────────────────────────────────────────────────');
  console.log(`  ✅ TOTAL KEPT:      ${totalKept.toLocaleString()} NLEX corridor rows`);
  console.log(`  ❌ TOTAL DISCARDED: ${totalDiscarded.toLocaleString()} non-NLEX rows`);
  console.log(`  📈 Filter Rate:     ${((totalKept / totalProcessed) * 100).toFixed(2)}% kept`);
  console.log('  ──────────────────────────────────────────────────────────');
  console.log(`  📁 Output Files:`);
  console.log(`     ${alertOutPath}`);
  console.log(`     ${irregOutPath}`);
  console.log(`     ${jamsOutPath}`);
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ Pipeline failed:', err);
  process.exit(1);
});
