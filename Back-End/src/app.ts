import cors from "cors";
import express from "express";
import morgan from "morgan";
import { rateLimit } from "express-rate-limit";
import apiRoutes from "./routes/index.js";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";

export const app = express();

// Rate limiting middleware to throttle request bursts
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 200, // Limit each IP to 200 requests per 15 minutes
  standardHeaders: "draft-7", // Standard headers in HTTP
  legacyHeaders: false, // Disable X-RateLimit-* headers
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 15 minutes"
  }
});

app.use(cors({ origin: env.FRONTEND_ORIGIN }));
app.use(express.json({ limit: "100mb" }));
app.use(morgan("dev"));

// Mount API routes with rate limiter
app.use("/api", apiLimiter, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
