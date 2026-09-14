throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';

const AWS_PG = {
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
};

// 20 UNIQUE physical exit locations along NLEX
// (SB and NB share the same coordinates — they are the same physical place)
const exitsData = [
  { name: 'Sta. Ines', sb_type: 'Entry', nb_type: 'Exit', lat: 15.222036544247922, lon: 120.5878349324598 },
  { name: 'Sctex', sb_type: 'Entry', nb_type: 'Exit', lat: 15.196300930675244, lon: 120.59712067640591 },
  { name: 'Dau', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 15.178009469031895, lon: 120.60462937006393 },
  { name: 'Angeles', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 15.163114265039983, lon: 120.61345871762175 },
  { name: 'Mexico', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 15.105216776242122, lon: 120.66361945309848 },
  { name: 'San Fernando', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 15.049706053892223, lon: 120.69485632354187 },
  { name: 'San Simon', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.990134507492616, lon: 120.74996867688135 },
  { name: 'Pulilan', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.908258043486079, lon: 120.81701519028174 },
  { name: 'Sta. Rita Guiguinto', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.862453405921645, lon: 120.85888660798751 },
  { name: 'Balagtas', sb_type: 'Entry', nb_type: 'Entry And Exit', lat: 14.83443660148125, lon: 120.90063378190028 },
  { name: 'Tabang Guiguinto', sb_type: 'Entry', nb_type: 'Exit', lat: 14.83274649661766, lon: 120.9039112162981 },
  { name: 'Tambubong', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.815123897282831, lon: 120.93507141724179 },
  { name: 'Bocaue Interchange', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.807233925154666, lon: 120.93939984817274 },
  { name: 'Bocaue Barrier', sb_type: 'Exit', nb_type: 'None', lat: 14.802456193901511, lon: 120.94245608845259 },
  { name: 'Cdv/Ph Arena', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.793123785151655, lon: 120.94725606760602 },
  { name: 'Marilao', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.77456202043474, lon: 120.9572673295301 },
  { name: 'Meycauayan', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.74638836470472, lon: 120.9723156192843 },
  { name: 'Paso De Blas Valenzuela', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.708213486172651, lon: 120.99300157701673 },
  { name: 'NLEX Harbor Link', sb_type: 'Entry And Exit', nb_type: 'Entry And Exit', lat: 14.693465298536088, lon: 121.0003079375893 },
  { name: 'Balintawak', sb_type: 'Exit', nb_type: 'Entry', lat: 14.67876672198161, lon: 121.00008900172813 },
];

const pool = new pg.Pool(AWS_PG);

async function seed() {
  try {
    console.log("🚀 Rebuilding nlex_exits with 20 UNIQUE physical locations...\n");

    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // Drop dependent tables first
    await pool.query('DROP TABLE IF EXISTS nlex_theoretical_emissions CASCADE');
    await pool.query('DROP TABLE IF EXISTS nlex_emissions CASCADE');
    await pool.query('DROP TABLE IF EXISTS nlex_exits CASCADE');
    console.log("🗑️  Cleared old tables (exits, emissions, theoretical).\n");

    // Recreate nlex_exits with 20 unique locations
    await pool.query(`
      CREATE TABLE nlex_exits (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        sb_access_type TEXT,
        nb_access_type TEXT,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Recreate nlex_emissions for ambient data
    await pool.query(`
      CREATE TABLE nlex_emissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        exit_id UUID REFERENCES nlex_exits(id),
        aqi INT,
        co DOUBLE PRECISION,
        "no" DOUBLE PRECISION,
        no2 DOUBLE PRECISION,
        o3 DOUBLE PRECISION,
        so2 DOUBLE PRECISION,
        nh3 DOUBLE PRECISION,
        pm2_5 DOUBLE PRECISION,
        pm10 DOUBLE PRECISION,
        api_dt INT,
        raw_response JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Recreate nlex_theoretical_emissions
    await pool.query(`
      CREATE TABLE nlex_theoretical_emissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        exit_id UUID REFERENCES nlex_exits(id),
        timestamp_utc TIMESTAMPTZ NOT NULL,
        direction TEXT NOT NULL,
        vehicle_class INT NOT NULL,
        volume INT NOT NULL,
        segment_distance_km DOUBLE PRECISION,
        co2_grams DOUBLE PRECISION,
        co_grams DOUBLE PRECISION,
        no2_grams DOUBLE PRECISION,
        pm25_grams DOUBLE PRECISION,
        pm10_grams DOUBLE PRECISION,
        so2_grams DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("✅ All 3 tables recreated with proper schema!\n");

    // Insert the 20 unique exits
    let inserted = 0;
    for (const exit of exitsData) {
      await pool.query(`
        INSERT INTO nlex_exits (name, sb_access_type, nb_access_type, latitude, longitude)
        VALUES ($1, $2, $3, $4, $5)
      `, [exit.name, exit.sb_type, exit.nb_type, exit.lat, exit.lon]);
      inserted++;
    }

    console.log(`✅ Successfully inserted ${inserted} UNIQUE physical exits into nlex_exits!`);
    console.log("\n📍 The 20 NLEX Exit Locations:");
    const result = await pool.query("SELECT name, latitude, longitude FROM nlex_exits ORDER BY latitude DESC");
    result.rows.forEach((r, i) => {
      console.log(`  ${(i+1).toString().padStart(2)}. ${r.name.padEnd(25)} (${r.latitude}, ${r.longitude})`);
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

seed();
