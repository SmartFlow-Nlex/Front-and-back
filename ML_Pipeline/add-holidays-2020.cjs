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
  // 2020
  { date: '2020-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2020-01-25', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2020-02-25', name: "EDSA People Power Revolution Anniversary", type: 'Special Non-Working Day' },
  { date: '2020-04-09', name: "Araw ng Kagitingan & Maundy Thursday", type: 'Regular Holiday' },
  { date: '2020-04-10', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2020-04-11', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2020-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2020-05-25', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2020-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2020-07-31', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2020-08-21', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2020-08-31', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2020-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2020-11-02', name: "All Souls' Day", type: 'Special Non-Working Day' },
  { date: '2020-11-30', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2020-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2020-12-24', name: "Christmas Eve", type: 'Special Non-Working Day' },
  { date: '2020-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2020-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2020-12-31', name: "Last Day of the Year", type: 'Special Non-Working Day' },

  // 2021
  { date: '2021-01-01', name: "New Year's Day", type: 'Regular Holiday' },
  { date: '2021-02-12', name: "Chinese New Year", type: 'Special Non-Working Day' },
  { date: '2021-02-25', name: "EDSA People Power Revolution Anniversary", type: 'Special Non-Working Day' },
  { date: '2021-04-01', name: "Maundy Thursday", type: 'Regular Holiday' },
  { date: '2021-04-02', name: "Good Friday", type: 'Regular Holiday' },
  { date: '2021-04-03', name: "Black Saturday", type: 'Special Non-Working Day' },
  { date: '2021-04-09', name: "Araw ng Kagitingan", type: 'Regular Holiday' },
  { date: '2021-05-01', name: "Labor Day", type: 'Regular Holiday' },
  { date: '2021-05-13', name: "Eid'l Fitr", type: 'Regular Holiday' },
  { date: '2021-06-12', name: "Independence Day", type: 'Regular Holiday' },
  { date: '2021-07-20', name: "Eid'l Adha", type: 'Regular Holiday' },
  { date: '2021-08-21', name: "Ninoy Aquino Day", type: 'Special Non-Working Day' },
  { date: '2021-08-30', name: "National Heroes Day", type: 'Regular Holiday' },
  { date: '2021-11-01', name: "All Saints' Day", type: 'Special Non-Working Day' },
  { date: '2021-11-02', name: "All Souls' Day", type: 'Special Working Day' }, // 2021 specific
  { date: '2021-11-30', name: "Bonifacio Day", type: 'Regular Holiday' },
  { date: '2021-12-08', name: "Feast of the Immaculate Conception", type: 'Special Non-Working Day' },
  { date: '2021-12-24', name: "Christmas Eve", type: 'Special Working Day' }, // 2021 specific
  { date: '2021-12-25', name: "Christmas Day", type: 'Regular Holiday' },
  { date: '2021-12-30', name: "Rizal Day", type: 'Regular Holiday' },
  { date: '2021-12-31', name: "Last Day of the Year", type: 'Special Working Day' } // 2021 specific
];

async function main() {
  const client = await pool.connect();

  try {
    console.log('Starting transaction...');
    await client.query('BEGIN');

    console.log('Generating base rows for 2020 and 2021...');
    await client.query(`
      INSERT INTO dim.dim_time (date_day, hour_of_day, day_of_week, is_weekend, month_name, quarter, is_rush_hour)
      SELECT
        d.date_day,
        h.hour_of_day,
        trim(to_char(d.date_day, 'Day')) as day_of_week,
        extract(dow from d.date_day) IN (0, 6) as is_weekend,
        trim(to_char(d.date_day, 'Month')) as month_name,
        'Q' || to_char(d.date_day, 'Q') as quarter,
        h.hour_of_day IN (7, 8, 9, 17, 18, 19) as is_rush_hour
      FROM
        (SELECT date::date as date_day FROM generate_series('2020-01-01'::date, '2021-12-31'::date, '1 day'::interval) date) d
      CROSS JOIN
        (SELECT generate_series(0, 23) as hour_of_day) h
      ON CONFLICT (date_day, hour_of_day) DO NOTHING;
    `);

    console.log('Inserting holiday markers for 2020 and 2021...');
    for (const h of holidays) {
      await client.query(
        `UPDATE dim.dim_time 
         SET is_holiday = true, holiday_name = $1, holiday_type = $2 
         WHERE date_day = $3::date`,
        [h.name, h.type, h.date]
      );
    }

    console.log('Re-calculating is_holiday_window globally...');
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
    console.log('\n--- Holiday Count Per Year (2020-2026) ---');
    console.table(countQuery.rows);

    await client.query('COMMIT');
    console.log('\nTransaction committed successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in transaction, rolled back:', e);
  } finally {
    client.release();
    pool.end();
  }
}

main();
