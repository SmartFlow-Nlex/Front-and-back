import fs from "node:fs"; import path from "node:path"; import pg from "pg";
const env={}; for (const l of fs.readFileSync(path.join(process.cwd(),".env"),"utf8").split(/\r?\n/)){const m=/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l); if(!m)continue; let v=m[2].trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); env[m[1]]=v;}
const url=env.POSTGRES_URL?.trim()||`postgresql://${encodeURIComponent(env.PG_USER)}:${encodeURIComponent(env.PG_PASSWORD??"")}@${env.PG_HOST}:${env.PG_PORT??5432}/${env.PG_DATABASE}`;
const c=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false}}); await c.connect();
const {rows}=await c.query("SELECT COUNT(*) rows, MIN(hours_ahead) lo, MAX(hours_ahead) hi, COUNT(DISTINCT hours_ahead) hs, MAX(base_ts) base FROM gold.ml_predictive_congestion");
console.log(JSON.stringify(rows[0]));
await c.end();
