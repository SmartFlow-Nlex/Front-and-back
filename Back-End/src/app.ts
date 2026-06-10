import cors from "cors";
import express from "express";
import morgan from "morgan";
import apiRoutes from "./routes/index.js";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";

export const app = express();

app.use(cors({ origin: env.FRONTEND_ORIGIN }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.use("/api", apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
