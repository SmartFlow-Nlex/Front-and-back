import { app } from "./app.js";
import { env } from "./config/env.js";
import { verifyDbConnection } from "./config/db.js";

// Express 4 does not catch a rejected async route handler. Without this, one
// handler that lets a database error escape — a dropped RDS connection, say —
// becomes an unhandled rejection, Node exits, and every page of the dashboard
// reports the backend as unreachable. Log it and keep serving: the request
// that failed is the only thing that should be affected.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("[unhandledRejection] kept the server running:", msg);
});

app.listen(env.PORT, async () => {
  console.log(`smartflow-backend running on http://localhost:${env.PORT}`);
  await verifyDbConnection();
});
