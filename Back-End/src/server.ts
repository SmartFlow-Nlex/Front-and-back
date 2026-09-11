import { app } from "./app.js";
import { env } from "./config/env.js";
import { verifyDbConnection } from "./config/db.js";

app.listen(env.PORT, async () => {
  console.log(`smartflow-backend running on http://localhost:${env.PORT}`);
  await verifyDbConnection();
});
