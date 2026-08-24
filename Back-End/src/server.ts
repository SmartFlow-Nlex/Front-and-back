import { app } from "./app.js";
import { env } from "./config/env.js";
import { verifyDbConnection } from "./config/db.js";

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught Exception:", err);
});

app.listen(env.PORT, async () => {
  console.log(`smartflow-backend running on http://localhost:${env.PORT}`);
  await verifyDbConnection();
});
