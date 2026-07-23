const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

const createTablesQuery = `
  CREATE TABLE IF NOT EXISTS ml_predictive_volume (
    id SERIAL PRIMARY KEY,
    forecast_date DATE NOT NULL,
    predicted_volume INT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_predictive_congestion (
    id SERIAL PRIMARY KEY,
    segment_name VARCHAR(255) NOT NULL,
    hours_ahead INT NOT NULL,
    congestion_state INT NOT NULL, -- 0=Free Flow, 1=Heavy, 2=Severe
    probability FLOAT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_event_surge_forecast (
    id SERIAL PRIMARY KEY,
    exit_name VARCHAR(255) NOT NULL,
    event_name VARCHAR(255) NOT NULL,
    baseline_volume INT NOT NULL,
    surge_volume INT NOT NULL
  );
`;

async function seedData() {
  try {
    console.log("Creating ML prediction tables...");
    await pool.query(createTablesQuery);
    
    // Clear old mock data just in case
    await pool.query("TRUNCATE ml_predictive_volume, ml_predictive_congestion, ml_event_surge_forecast");

    console.log("Seeding ml_predictive_volume...");
    for (let i = 0; i < 10; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const vol = 1200000 + Math.floor(Math.random() * 200000) + (i * 10000);
      await pool.query(
        "INSERT INTO ml_predictive_volume (forecast_date, predicted_volume) VALUES ($1, $2)",
        [d.toISOString().split('T')[0], vol]
      );
    }

    console.log("Seeding ml_predictive_congestion...");
    const segments = ["Balintawak", "Mindanao Ave", "Karuhatan", "Valenzuela", "Meycauayan", "Marilao", "Bocaue", "Balagtas", "Tabang"];
    for (const segment of segments) {
      for (let h = 1; h <= 12; h++) {
        let baseProb = Math.random();
        if (segment === "Bocaue" || segment === "Balintawak") baseProb += 0.4;
        if (h >= 3 && h <= 5) baseProb += 0.3;
        
        let state = 0;
        if (baseProb > 1.2) state = 2;
        else if (baseProb > 0.7) state = 1;

        await pool.query(
          "INSERT INTO ml_predictive_congestion (segment_name, hours_ahead, congestion_state, probability) VALUES ($1, $2, $3, $4)",
          [segment, h, state, baseProb]
        );
      }
    }

    console.log("Seeding ml_event_surge_forecast...");
    const exits = [
      { name: "Bocaue Exit", base: 35000, surge: 65000 },
      { name: "Marilao Exit", base: 28000, surge: 42000 },
      { name: "Meycauayan Exit", base: 24000, surge: 31000 },
      { name: "Balintawak Toll Plaza", base: 45000, surge: 52000 },
      { name: "Mindanao Ave Toll Plaza", base: 32000, surge: 38000 }
    ];
    
    for (const exit of exits) {
      await pool.query(
        "INSERT INTO ml_event_surge_forecast (exit_name, event_name, baseline_volume, surge_volume) VALUES ($1, $2, $3, $4)",
        [exit.name, "Philippine Arena Concert", exit.base, exit.surge]
      );
    }

    console.log("Done seeding ML tables into AWS!");
    pool.end();
  } catch (err) {
    console.error(err);
    pool.end();
  }
}

seedData();
