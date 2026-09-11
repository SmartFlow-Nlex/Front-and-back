import cors from "cors";
import compression from "compression";
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
  // Local development shares one IP across every dashboard tab, so the per-IP
  // cap trips on normal use — exempt loopback traffic only (user-approved).
  skip: (req) => req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1",
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 15 minutes"
  }
});

/**
 * Allow every origin listed in FRONTEND_ORIGIN, plus requests that carry no
 * Origin header at all.
 *
 * That last case is the mobile app: a React Native fetch is not a browser
 * request, so it sends no Origin and there is nothing to allow it against.
 * Such a request is passed rather than rejected; it still comes back without an
 * Access-Control-Allow-Origin header, which is fine, because nothing on the
 * native side is looking for one.
 *
 * None of this is a security boundary. CORS only ever restrains browsers, and
 * these routes carry no auth at all — what has to gate them before the app
 * leaves the LAN is the Supabase middleware in auth.middleware.ts.
 */
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || env.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(null, false);
    },
  }),
);
/* gzip every response. The forecast payload is ~615 KB of JSON and was going
   over the wire uncompressed; text this repetitive compresses about 5:1. */
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// Mount API routes with rate limiter
app.use("/api", apiLimiter, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
