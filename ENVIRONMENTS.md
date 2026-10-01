# Environment configuration

Every configuration variable the system reads, and what it holds in each of the
three environments. Values are never written here — this file names keys and
says where each one is set.

## How this system is delivered

The dashboard ships as a **desktop application**, not as a public website. It is
an Electron app (`electron/main.js`, `npm run dist` → an NSIS installer) that
loads the static export produced by `next build`. The corridor dashboard is an
operations tool for the traffic control centre, so it is installed on the
machines that use it rather than published at a URL.

That decision is what the rest of this file is shaped by. There is no Vercel
project and no public origin.

| | Dashboard | Backend | Database |
| --- | --- | --- | --- |
| **Development** | `next dev` on `localhost:3002` | `tsx watch` on `localhost:4000` | AWS RDS (shared) |
| **Desktop (unpackaged)** | `npm run start:desktop` — serves `out/` on `127.0.0.1:3002`, Electron loads it | `tsx watch` or `node dist/server.js` | AWS RDS (shared) |
| **Desktop (packaged)** | NSIS installer from `npm run dist` | a reachable host | AWS RDS (shared) |

One database serves every mode. With a single corridor dataset and a four-person
team there is nothing to gain from duplicating it, and a second copy would drift
from the first. The consequence is that there is no isolated environment in which
to exercise destructive operations.

## A consequence of the static export worth knowing first

The dashboard builds with `output: 'export'`, so every `NEXT_PUBLIC_*` value is
**compiled into the JavaScript bundle at build time**, not read at runtime.

Two things follow, and both have caught us:

1. **Changing a variable after the fact changes nothing** until the app is
   rebuilt. There is no running server to re-read it.
2. **The backend URL is frozen into the installer.** Whatever
   `NEXT_PUBLIC_BACKEND_URL` held at build time is what every installed copy
   will ask for, on every machine it is installed on.

A build made with the development value ships an app that asks each user's own
machine for data on port 4000. It works on the machine that built it and fails
everywhere else, in a way that looks like a backend outage rather than a
configuration error.

## Backend variables

Set in `Back-End/.env` locally; in the Railway console for staging and
production. Never committed.

| Variable | Development | Staging / Production | Notes |
| --- | --- | --- | --- |
| `PORT` | `4000` | **leave unset** | Railway injects it. Hardcoding makes the container unreachable. |
| `NODE_ENV` | unset | `production` | |
| `FRONTEND_ORIGIN` | `http://localhost:3002` | the Vercel URL for that environment | Comma-separated. CORS rejects anything not listed, with no useful message in the UI. |
| `POSTGRES_URL` | blank | blank | Leave blank and supply the `PG_*` parts; `config/env.ts` assembles the URL and percent-encodes the password. |
| `PG_HOST` `PG_PORT` `PG_DATABASE` `PG_USER` `PG_PASSWORD` | RDS instance | same RDS instance | One database across all three environments. |
| `PG_SSL_MODE` | `relaxed` | `relaxed` | RDS requires TLS but presents a regional CA that Node does not ship. `verify` needs `PG_CA_CERT`. |
| `PG_CA_CERT` | unset | optional | Path to the RDS CA bundle if using `verify`. |
| `REDIS_REST_URL` `REDIS_REST_TOKEN` | Upstash | Upstash | Live Waze feed. **These were once exposed publicly — confirm the current token is a rotated one.** |
| `SUPABASE_URL` `SUPABASE_ANON_KEY` | Supabase | Supabase | Audit log and sandbox auth. |
| `CLIMATIQ_API_KEY` | Climatiq | Climatiq | Emission factors. |
| `GLM_API_KEY` `GLM_MODEL` | Z.ai | Z.ai | The LLM layer. Endpoint is OpenAI-compatible, so `GLM_BASE_URL` can point at another OpenAI-shaped server without code changes. |
| `GLM_BASE_URL` `GLM_THINKING` `GLM_TIMEOUT_MS` `GLM_ZDR` `GLM_SITE_URL` `GLM_SITE_NAME` | defaults | defaults | Declared in `config/env.ts`; all optional. |

## Frontend variables

Set in `Front-End-Dashboard/.env` locally; in the Vercel console per
environment. This file **is** committed, because every key is `NEXT_PUBLIC_*`
and therefore public once the bundle ships.

| Variable | Development | Staging | Production |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | `http://localhost:4000` | Railway staging URL | Railway production URL |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox token | same | same, URL-restricted to the deployed domain |

The Mapbox token cannot be kept secret in a browser application. It is
restricted by URL in the Mapbox console instead, which is the control that
actually works for a public token.

## Build order

The order is forced by the build-time baking described above.

1. Start the backend where the installed app will reach it, and note that address.
2. Add the dashboard's origin to `FRONTEND_ORIGIN` on the backend.
3. Set `NEXT_PUBLIC_BACKEND_URL` in `Front-End-Dashboard/.env` to that address.
4. **`npm run dist`.** Not before step 3 — step 3 is what gets compiled in.
5. Install the output on a second machine and open a page that fetches data.

Reversing steps 3 and 4 produces an installer that looks finished and works for
nobody but its author.

## Known gap in the packaged build

`npm run start:desktop` works: it serves `out/` over `http://127.0.0.1:3002`,
which is already listed in `FRONTEND_ORIGIN`, so the backend accepts its
requests.

The **packaged** app does not take that path. `electron/main.js` calls
`loadFile()` when `app.isPackaged`, which loads the pages over `file://`.
A `file://` page sends `Origin: null` on cross-origin requests, and the backend's
CORS check admits only the origins in `FRONTEND_ORIGIN` — `null` is not one of
them. The installed app would therefore render and fail every data call.

Two ways to close it, neither yet done:

- have the packaged app serve `out/` on `127.0.0.1` and `loadURL()` that, so the
  origin matches what the backend already allows; or
- register a custom protocol in Electron and allow that origin on the backend.

The first is preferred: it reuses an origin already configured and keeps one
code path for packaged and unpackaged runs.

`package.json` also has **no `build` block**, so `electron-builder` has no
`appId`, no file allow-list, and no icon configuration. `npm run dist` needs
that section before it produces a correct installer.

## Verifying a build

- [ ] `git ls-files | grep -i '\.env'` lists only `.env.example` files and `Front-End-Dashboard/.env`
- [ ] `npx next build` exits 0 and regenerates `out/`
- [ ] The bundle in `out/` contains the intended backend address, not a stale one
- [ ] The app opens on a machine that is not the one that built it, and the Traffic page fills
- [ ] The backend starts without a boot crash, confirming every required variable parsed
