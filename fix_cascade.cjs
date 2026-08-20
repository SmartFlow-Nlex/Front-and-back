const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // Original old order (by sequential ID blocks of 122,736 each):
  // Block  | ID range          | Old Name               | New Name                  | exit_id
  // -------|-------------------|------------------------|---------------------------|--------
  // 1      | 1-61368 (missing) | (not in data)          | -                         | -
  // 2      | 61369-184104      | Balintawak             | Balintawak                | 1  ✅
  // 3      | 184105-306840     | Mindanao Ave/Bignay    | NLEX Harbor Link          | 2  ✅
  // 4      | 306841-429576     | Karuhatan              | Paso De Blas Valenzuela   | 3  ✅
  // 5      | 429577-552312     | Valenzuela             | Meycauayan                | 4  ❌ (cascade→Cdv/Ph Arena)
  // 6      | 552313-675048     | Meycauayan             | Marilao                   | 5  ❌ (cascade→Cdv/Ph Arena)
  // 7      | 675049-797784     | Marilao                | Cdv/Ph Arena              | 6  ✅ (but absorbed 5+6)
  // 8      | 797785-920520     | Bocaue                 | Bocaue Interchange        | 8  ✅
  // ...

  // Fix: Split the Cdv/Ph Arena block back into 3 proper exits
  const fixes = [
    { min_id: 429577, max_id: 552312, toll_plaza: 'Meycauayan',  exit_id: 4 },   // was Valenzuela
    { min_id: 552313, max_id: 675048, toll_plaza: 'Marilao',     exit_id: 5 },   // was Meycauayan
    // 675049-797784 stays Cdv/Ph Arena exit_id=6 (already correct)
  ];

  console.log('=== Fixing cascaded rename (Cdv/Ph Arena → split into exit 4, 5, 6) ===');
  for (const f of fixes) {
    const res = await pool.query(`
      UPDATE bronze.nlex_traffic_volume
      SET toll_plaza = $1, exit_id = $2
      WHERE id >= $3 AND id <= $4
    `, [f.toll_plaza, f.exit_id, f.min_id, f.max_id]);
    console.log(`  IDs ${f.min_id}-${f.max_id} → "${f.toll_plaza}" (exit_id=${f.exit_id}): ${res.rowCount} rows`);
  }

  // Verify the fix
  console.log('\n=== Verification ===');
  const verify = await pool.query(`
    SELECT exit_id, toll_plaza, COUNT(*)::int as cnt,
           MIN(id)::int as min_id, MAX(id)::int as max_id
    FROM bronze.nlex_traffic_volume
    GROUP BY exit_id, toll_plaza
    ORDER BY min_id
  `);
  console.table(verify.rows);

  // Double-check: every exit should have exactly 122,736 rows (or 245,472 for merged ones)
  console.log('\n=== Row count check ===');
  const countCheck = await pool.query(`
    SELECT exit_id, toll_plaza, COUNT(*)::int as cnt,
           CASE WHEN COUNT(*) = 122736 THEN 'OK (1x)'
                WHEN COUNT(*) = 245472 THEN 'OK (2x merged)'
                ELSE 'PROBLEM'
           END as status
    FROM bronze.nlex_traffic_volume
    GROUP BY exit_id, toll_plaza
    ORDER BY exit_id
  `);
  console.table(countCheck.rows);

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); pool.end(); });
