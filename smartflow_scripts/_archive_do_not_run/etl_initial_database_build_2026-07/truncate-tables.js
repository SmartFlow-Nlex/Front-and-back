throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("Connecting to database to truncate tables...");
        
        try {
            await pool.query("TRUNCATE TABLE nlex_emissions RESTART IDENTITY CASCADE");
            console.log("✅ Truncated 'nlex_emissions' successfully.");
        } catch (e) {
            console.log("⚠️ Could not truncate 'nlex_emissions': " + e.message);
        }
        
        try {
            await pool.query("TRUNCATE TABLE hourly_weather RESTART IDENTITY CASCADE");
            console.log("✅ Truncated 'hourly_weather' successfully.");
        } catch (e) {
            console.log("⚠️ Could not truncate 'hourly_weather': " + e.message);
        }
        
        console.log("\nDatabase reset complete. Space has been reclaimed.");
        
    } catch (e) {
        console.error("Fatal Error:", e.message);
    } finally {
        await pool.end();
    }
}

run();
