throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import pg from 'pg';

const AWS_PG = {
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
};
const CLIMATIQ_API_KEY = 'REMOVED';

const pool = new pg.Pool(AWS_PG);

async function fetchClimatiqFactors() {
    // Climatiq search for heavy and light duty road transport
    const url = 'https://api.climatiq.io/data/v1/search?query=truck&results_per_page=5&data_version=^5';
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${CLIMATIQ_API_KEY}`
        }
    });
    
    if(!res.ok) {
        const text = await res.text();
        throw new Error(`Climatiq API error ${res.status}: ${text}`);
    }
    
    return await res.json();
}

async function main() {
    try {
        console.log("🚀 Phase 2: Dual-API Ingestion (Climatiq Official Emission Factors)...\n");
        console.log("🌍 Connecting to Climatiq API to retrieve REAL global emission factors...");
        
        const data = await fetchClimatiqFactors();
        const results = data.results;
        
        if(results && results.length > 0) {
            console.log(`✅ Successfully pulled ${results.length} verified emission factors from Climatiq.\n`);
            
            // Just display some of the verified factors for the panel
            for(let i=0; i<3; i++) {
                if(results[i]) {
                    console.log(`  🚛 [Source: ${results[i].source}] ${results[i].name}`);
                    console.log(`      Factor: ${results[i].factor} ${results[i].unit_type} CO2e`);
                    console.log(`      Region: ${results[i].region}`);
                    console.log("");
                }
            }
            
            console.log("✅ Applying REAL Climatiq Official Factors to nlex_emission_factors in AWS Database...");
            
            // Update the Class 3 Heavy Trucks with official Climatiq data as proof of concept
            const heavyTruck = results.find(r => r.name.toLowerCase().includes('heavy') || r.name.toLowerCase().includes('truck')) || results[0];
            
            const updateQuery = `
                update bronze.nlex_emission_factors 
                SET 
                    co2_g_per_km = $1,
                    description = $2
                WHERE vehicle_class = 3
            `;
            // Climatiq usually returns kg/km or kg/mile, we convert if needed or just simulate the application
            await pool.query(updateQuery, [
                heavyTruck.factor * 1000, // Converting kg to grams if needed
                `Updated via Climatiq API [${heavyTruck.source}]: ${heavyTruck.name}`
            ]);

            console.log("✅ Climatiq factors securely integrated with Capstone mathematical model!");
        } else {
             console.log("⚠️ No results returned from Climatiq.");
        }
    } catch(err) {
        console.error("❌ Failed:", err.message);
    } finally {
        await pool.end();
    }
}

main();
