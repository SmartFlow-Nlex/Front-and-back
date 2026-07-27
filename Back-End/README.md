# SmartFlow Back-End

## Run
1. Copy `.env.example` to `.env`
2. Install dependencies: `npm install`
3. Dev server: `npm run dev`

Default URL: `http://localhost:4000`

## API Routes
- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/traffic`
- `GET /api/incident`
- `GET /api/emissions`
- `GET /api/map-comparison`
- `GET /api/ai-sandbox`
- `GET /api/data-management`
- `GET /api/audit-log`

## Structure
- `src/config`: env + db setup
- `src/routes`: route definitions
- `src/controllers`: request handlers
- `src/services`: business logic stubs
- `src/middleware`: error + validation middleware
- `src/validators`: zod schemas
- `src/types`: shared API types

## PostGIS Integration Notes
Use `src/services/*.service.ts` for DB queries. For geospatial data, query with `ST_AsGeoJSON`, `ST_Transform`, and return FeatureCollection JSON.
