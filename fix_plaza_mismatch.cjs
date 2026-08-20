const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // =========================================================================
  // FIX 1: Update toll_plaza names in nlex_traffic_volume to match nlex_exits
  //
  // Old name (in volume data)     →  New name (in nlex_exits)     exit_id
  // -------------------------------------------------------------------
  // Balintawak                    →  Balintawak                   1  (same)
  // Mindanao Ave / Bignay         →  NLEX Harbor Link             2
  // Karuhatan                     →  Paso De Blas Valenzuela      3
  // Valenzuela                    →  Meycauayan                   4  (NOTE: old "Valenzuela" ≈ exit_id 4)
  // Meycauayan                    →  Marilao                      5  (NOTE: shifted)
  // Marilao                       →  Cdv/Ph Arena                 6
  // Bocaue                        →  Bocaue Interchange           8  (skip 7=Barrier)
  // Balagtas                      →  Balagtas                     11 (same name)
  // Tabang                        →  Tabang Guiguinto             10
  // Plaridel                      →  Sta. Rita Guiguinto          12
  // Pulilan                       →  Pulilan                      13 (same)
  // Calumpit                      →  San Simon                    14  (Calumpit doesn't exist in new)
  // Apalit                        →  San Fernando                 15  (Apalit doesn't exist in new)
  // San Simon                     →  San Simon                    14 (same)
  // San Fernando                  →  San Fernando                 15 (same)
  // Mexico                        →  Mexico                       16 (same)
  // Angeles                       →  Angeles                      17 (same)
  // Dau / Mabalacat               →  Dau                          18
  // Sta. Ines / SCTEX             →  Sta. Ines                    20 (split: also 19=Sctex)
  // Tipo / TPLEX                  →  (doesn't exist in new exits)
  // =========================================================================
  //
  // IMPORTANT: The old volume data has 20 plazas with sequential integer-based
  // exit references. We need to map them geographically. The correct approach
  // is to update the toll_plaza text AND add/update an exit_id FK column.
  //
  // Let's check if nlex_traffic_volume has an exit_id column
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'bronze' AND table_name = 'nlex_traffic_volume'
    ORDER BY ordinal_position
  `);
  console.log('=== nlex_traffic_volume columns ===');
  console.log(colCheck.rows.map(r => r.column_name).join(', '));

  // The mapping: old toll_plaza name → new exit_id + new exit_name
  // Based on geographic proximity (south to north order)
  const mapping = [
    { old: 'Balintawak',            new_name: 'Balintawak',              new_exit_id: 1 },
    { old: 'Mindanao Ave / Bignay', new_name: 'NLEX Harbor Link',        new_exit_id: 2 },
    { old: 'Karuhatan',             new_name: 'Paso De Blas Valenzuela', new_exit_id: 3 },
    { old: 'Valenzuela',            new_name: 'Meycauayan',              new_exit_id: 4 },
    { old: 'Meycauayan',            new_name: 'Marilao',                 new_exit_id: 5 },
    { old: 'Marilao',               new_name: 'Cdv/Ph Arena',            new_exit_id: 6 },
    { old: 'Bocaue',                new_name: 'Bocaue Interchange',      new_exit_id: 8 },
    { old: 'Balagtas',              new_name: 'Balagtas',                new_exit_id: 11 },
    { old: 'Tabang',                new_name: 'Tabang Guiguinto',        new_exit_id: 10 },
    { old: 'Plaridel',              new_name: 'Sta. Rita Guiguinto',     new_exit_id: 12 },
    { old: 'Pulilan',               new_name: 'Pulilan',                 new_exit_id: 13 },
    { old: 'Calumpit',              new_name: 'Pulilan',                 new_exit_id: 13 }, // Calumpit doesn't exist; nearest = Pulilan
    { old: 'Apalit',                new_name: 'San Simon',               new_exit_id: 14 }, // Apalit doesn't exist; nearest = San Simon
    { old: 'San Simon',             new_name: 'San Simon',               new_exit_id: 14 },
    { old: 'San Fernando',          new_name: 'San Fernando',            new_exit_id: 15 },
    { old: 'Mexico',                new_name: 'Mexico',                  new_exit_id: 16 },
    { old: 'Angeles',               new_name: 'Angeles',                 new_exit_id: 17 },
    { old: 'Dau / Mabalacat',       new_name: 'Dau',                     new_exit_id: 18 },
    { old: 'Sta. Ines / SCTEX',     new_name: 'Sta. Ines',               new_exit_id: 20 },
    { old: 'Tipo / TPLEX',          new_name: 'Sta. Ines',               new_exit_id: 20 }, // Tipo/TPLEX doesn't exist; nearest = Sta. Ines
  ];

  // Step 1: Add exit_id column to nlex_traffic_volume if not exists
  console.log('\n=== Step 1: Ensure exit_id column exists ===');
  await pool.query(`ALTER TABLE bronze.nlex_traffic_volume ADD COLUMN IF NOT EXISTS exit_id integer`);
  console.log('Column ensured.');

  // Step 2: Update toll_plaza names AND set exit_id
  console.log('\n=== Step 2: Updating toll_plaza names + exit_id ===');
  for (const m of mapping) {
    const res = await pool.query(`
      UPDATE bronze.nlex_traffic_volume 
      SET toll_plaza = $1, exit_id = $2
      WHERE toll_plaza = $3
    `, [m.new_name, m.new_exit_id, m.old]);
    if (res.rowCount > 0) {
      console.log(`  "${m.old}" → "${m.new_name}" (exit_id=${m.new_exit_id}): ${res.rowCount} rows`);
    }
  }

  // Step 3: Fix philippine_arena_events.nlex_exit_id from 7 (Bocaue Barrier) to 6 (Cdv/Ph Arena)
  console.log('\n=== Step 3: Re-pointing philippine_arena_events to exit_id 6 (Cdv/Ph Arena) ===');
  const evRes = await pool.query(`
    UPDATE philippine_arena_events SET nlex_exit_id = 6 WHERE nlex_exit_id = 7
  `);
  console.log(`Updated ${evRes.rowCount} arena event rows: nlex_exit_id 7 → 6`);

  // Step 4: Verify
  console.log('\n=== Verification: toll_plaza values after update ===');
  const verify = await pool.query(`
    SELECT DISTINCT toll_plaza, exit_id, COUNT(*)::int as cnt
    FROM bronze.nlex_traffic_volume
    GROUP BY toll_plaza, exit_id
    ORDER BY exit_id
  `);
  console.table(verify.rows);

  console.log('\n=== Verification: arena events ===');
  const evVerify = await pool.query(`SELECT DISTINCT nlex_exit_id FROM philippine_arena_events`);
  console.table(evVerify.rows);

  // Step 5: Update the public view if it exists
  try {
    const viewCheck = await pool.query(`
      SELECT table_type FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'nlex_traffic_volume'
    `);
    if (viewCheck.rows.length > 0 && viewCheck.rows[0].table_type === 'VIEW') {
      console.log('\n=== Step 5: Updating public.nlex_traffic_volume view to include exit_id ===');
      await pool.query('DROP VIEW IF EXISTS public.nlex_traffic_volume CASCADE');
      const bronzeCols = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = 'bronze' AND table_name = 'nlex_traffic_volume'
        ORDER BY ordinal_position
      `);
      const colList = bronzeCols.rows.map(r => r.column_name).join(', ');
      await pool.query(`CREATE VIEW public.nlex_traffic_volume AS SELECT ${colList} FROM bronze.nlex_traffic_volume`);
      console.log('View recreated.');
    }
  } catch (e) {
    console.log('View update skipped:', e.message);
  }

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); pool.end(); });
