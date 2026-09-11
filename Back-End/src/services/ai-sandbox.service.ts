import { db } from "../config/db.js";

// [DEV-01] Trigger Simulation
export async function triggerSimulationInDb(simulationId: string, parameters: any) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO sandbox_simulations (simulation_id, parameters, status) 
      VALUES ($1, $2, 'running')
      RETURNING *
    `, [simulationId, parameters]);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for trigger simulation:", error);
    return null;
  }
}

// [DEV-03] Fetch Results
export async function getSimulationResultsFromDb(simulationId: string) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT * FROM sandbox_simulations WHERE simulation_id = $1
    `, [simulationId]);
    return rows[0];
  } catch (error) {
    console.error("Database query failed for simulation results:", error);
    return null;
  }
}
