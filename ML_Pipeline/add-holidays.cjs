const pg = require('pg');

const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

const holidays = [
  // 2022
  { date: '2022-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2022-02-01', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2022-02-25', name: "EDSA People Power Revolution Anniversary", type: 'Special Non-Working Day' },
  { date: '2022-04-09', name: "Araw ng Kagitingan", type: 'Regular Holiday' },
  { date: '2022-04-14', name: "Maundy Thursday", type: 'Regular Holiday' },
  { date: '2022-04-15', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2022-04-16', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2022-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2022-05-03', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2022-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2022-07-09', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2022-08-21', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2022-08-29', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2022-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2022-11-02', name: "All Souls' Day", type: 'Special Non-Working Day' },
  { date: '2022-11-30', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2022-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2022-12-24', name: "Christmas Eve", type: 'Special Non-Working Day' },
  { date: '2022-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2022-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2022-12-31', name: "Last Day of the Year", type: 'Special Non-Working Day' },

  // 2023
  { date: '2023-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2023-01-22', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2023-02-24', name: "EDSA People Power Revolution Anniversary", type: 'Special Non-Working Day' },
  { date: '2023-04-06', name: "Maundy Thursday", type: 'Regular Holiday' },
  { date: '2023-04-07', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2023-04-08', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2023-04-10', name: "Araw ng Kagitingan", type: 'Regular Holiday' },
  { date: '2023-04-21', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2023-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2023-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2023-06-28', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2023-08-21', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2023-08-28', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2023-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2023-11-02', name: "All Souls' Day", type: 'Special Non-Working Day' },
  { date: '2023-11-27', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2023-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2023-12-24', name: "Christmas Eve", type: 'Special Non-Working Day' },
  { date: '2023-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2023-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2023-12-31', name: "Last Day of the Year", type: 'Special Non-Working Day' },

  // 2024
  { date: '2024-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2024-02-10', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2024-03-28', name: "Maundy Thursday", type: 'Regular Holiday' },
  { date: '2024-03-29', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2024-03-30', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2024-04-09', name: "Araw ng Kagitingan", type: 'Regular Holiday' },
  { date: '2024-04-10', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2024-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2024-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2024-06-17', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2024-08-23', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2024-08-26', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2024-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2024-11-02', name: "All Souls' Day", type: 'Special Non-Working Day' },
  { date: '2024-11-30', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2024-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2024-12-24', name: "Christmas Eve", type: 'Special Non-Working Day' },
  { date: '2024-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2024-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2024-12-31', name: "Last Day of the Year", type: 'Special Non-Working Day' },

  // 2025
  { date: '2025-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2025-01-29', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2025-02-25', name: "EDSA People Power Revolution Anniversary", type: 'Special Non-Working Day' },
  { date: '2025-04-01', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2025-04-09', name: "Araw ng Kagitingan", type: 'Regular Holiday' },
  { date: '2025-04-17', name: "Maundy Thursday", type: 'Regular Holiday' },
  { date: '2025-04-18', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2025-04-19', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2025-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2025-06-06', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2025-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2025-08-21', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2025-08-25', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2025-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2025-11-02', name: "All Souls' Day", type: 'Special Non-Working Day' },
  { date: '2025-11-30', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2025-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2025-12-24', name: "Christmas Eve", type: 'Special Non-Working Day' },
  { date: '2025-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2025-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2025-12-31', name: "Last Day of the Year", type: 'Special Non-Working Day' },

  // 2026
  { date: '2026-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2026-02-17', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2026-02-25', name: "EDSA People Power Revolution Anniversary", type: 'Special Non-Working Day' },
  { date: '2026-03-20', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2026-04-02', name: "Maundy Thursday", type: 'Regular Holiday' },
  { date: '2026-04-03', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2026-04-04', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2026-04-09', name: "Araw ng Kagitingan", type: 'Regular Holiday' },
  { date: '2026-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2026-05-27', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2026-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2026-08-21', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2026-08-31', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2026-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2026-11-02', name: "All Souls' Day", type: 'Special Non-Working Day' },
  { date: '2026-11-30', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2026-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2026-12-24', name: "Christmas Eve", type: 'Special Non-Working Day' },
  { date: '2026-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2026-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2026-12-31', name: "Last Day of the Year", type: 'Special Non-Working Day' }
];

async function main() {
  const client = await pool.connect();

  try {
    console.log('Starting transaction...');
    await client.query('BEGIN');

    console.log('Adding columns to dim_time...');
    // We add IF NOT EXISTS in case the columns already exist, though we assume they don't
    await client.query(`
      ALTER TABLE dim.dim_time 
      ADD COLUMN IF NOT EXISTS is_holiday BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS holiday_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS holiday_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS is_holiday_window BOOLEAN DEFAULT false;
    `);

    // Add columns to public view as well (wait, the public view was created with SELECT * FROM dim.dim_time, so we must recreate the view for it to pick up new columns)
    await client.query('DROP VIEW IF EXISTS public.dim_time;');
    await client.query('CREATE VIEW public.dim_time AS SELECT * FROM dim.dim_time;');

    console.log('Inserting holiday markers...');
    for (const h of holidays) {
      await client.query(
        `UPDATE dim.dim_time 
         SET is_holiday = true, holiday_name = $1, holiday_type = $2 
         WHERE date_day = $3::date`,
        [h.name, h.type, h.date]
      );
    }

    console.log('Setting is_holiday_window (day before and after)...');
    await client.query(`
      UPDATE dim.dim_time
      SET is_holiday_window = true
      WHERE date_day IN (
        SELECT date_day - interval '1 day' FROM dim.dim_time WHERE is_holiday = true
        UNION
        SELECT date_day + interval '1 day' FROM dim.dim_time WHERE is_holiday = true
      )
    `);

    // Verify
    const countQuery = await client.query(`
      SELECT EXTRACT(YEAR FROM date_day) as year, COUNT(DISTINCT date_day) as holiday_count
      FROM dim.dim_time 
      WHERE is_holiday = true 
      GROUP BY year 
      ORDER BY year
    `);
    console.log('\n--- Holiday Count Per Year ---');
    console.table(countQuery.rows);

    const listQuery = await client.query(`
      SELECT DISTINCT to_char(date_day, 'YYYY-MM-DD') as date_day, holiday_name, holiday_type 
      FROM dim.dim_time 
      WHERE is_holiday = true 
      ORDER BY date_day
    `);
    console.log('\\n--- Complete List of Holidays (2022-2026) ---');
    console.table(listQuery.rows);

    await client.query('COMMIT');
    console.log('\\nTransaction committed successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in transaction, rolled back:', e);
  } finally {
    client.release();
    pool.end();
  }
}

main();
