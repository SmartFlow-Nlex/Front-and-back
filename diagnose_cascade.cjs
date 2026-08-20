const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // The cascading rename broke exit_ids 4, 5, 6.
  // Currently Cdv/Ph Arena (exit_id=6) has 368,208 rows that should be split:
  //   - 122,736 originally "Valenzuela" → should be exit_id=4 "Meycauayan"
  //   - 122,736 originally "Meycauayan" → should be exit_id=5 "Marilao"
  //   - 122,736 originally "Marilao"    → should stay exit_id=6 "Cdv/Ph Arena"
  //
  // We need to identify which rows belong to which original plaza.
  // Let's check if there's any distinguishing data.

  console.log('=== Checking Cdv/Ph Arena rows distribution ===');
  const check = await pool.query(`
    SELECT exit_id, toll_plaza, COUNT(*)::int as cnt, 
           MIN(id)::int as min_id, MAX(id)::int as max_id
    FROM bronze.nlex_traffic_volume
    WHERE exit_id = 6
    GROUP BY exit_id, toll_plaza
  `);
  console.table(check.rows);

  // Check if there's a pattern in the IDs
  // Original data had 20 plazas × 122,736 rows each = 2,454,720 total
  // The rows were likely inserted in order: exit 1 (ids 1-122736), exit 2 (ids 122737-245472), etc.
  console.log('\n=== ID ranges per current exit_id ===');
  const idRanges = await pool.query(`
    SELECT exit_id, toll_plaza, COUNT(*)::int as cnt, 
           MIN(id)::int as min_id, MAX(id)::int as max_id
    FROM bronze.nlex_traffic_volume
    GROUP BY exit_id, toll_plaza
    ORDER BY min_id
  `);
  console.table(idRanges.rows);

  // Let's also check the original order - IDs should tell us which "old" exit each row was
  // Old order was: 1=Balintawak, 2=Mindanao/Bignay, 3=Karuhatan, 4=Valenzuela, 
  //                5=Meycauayan, 6=Marilao, 7=Bocaue, 8=Balagtas, 9=Tabang, 10=Plaridel,
  //                11=Pulilan, 12=Calumpit, 13=Apalit, 14=San Simon, 15=San Fernando,
  //                16=Mexico, 17=Angeles, 18=Dau, 19=Sta Ines, 20=Tipo/TPLEX
  // So IDs 368209-491944 = old Valenzuela (should be exit 4 Meycauayan)
  //    IDs 491945-614680 = old Meycauayan (should be exit 5 Marilao)
  //    IDs 614681-737416 = old Marilao (should be exit 6 Cdv/Ph Arena)

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
