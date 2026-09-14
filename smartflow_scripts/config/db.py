"""
Connection settings and shared paths for every Python script in smartflow_scripts.

Values come from config/.env (copy .env.example to .env and fill it in). Real
environment variables override the file, so CI or a groupmate's machine can set
them without editing anything.

    from db import PG, POSTGRES_URL, WORK, setting

    PG            libpq keyword string   -> psycopg2.connect(PG)
    POSTGRES_URL  URL form               -> psycopg2.connect(POSTGRES_URL) / SQLAlchemy
    WORK          smartflow_scripts/_work (cache/, outputs/, logs/ are created)
    setting(k)    any other value from .env, e.g. setting("REPORTS_DIR")
"""
import os
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = Path(__file__).with_name(".env")


def _load(path):
    vals = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


_FILE = _load(ENV_FILE)


def setting(name, default=None, required=False):
    v = os.environ.get(name, _FILE.get(name, default))
    if required and not v:
        raise SystemExit(
            f"config: {name} is not set. Copy config/.env.example to config/.env and fill it in.")
    return v


_host = setting("DB_HOST", required=True)
_port = setting("DB_PORT", "5432")
_name = setting("DB_NAME", "nlex_capstone")
_user = setting("DB_USER", "postgres")
_pw = setting("DB_PASSWORD", required=True)
_ssl = setting("DB_SSLMODE", "require")

PG = f"host={_host} port={_port} dbname={_name} user={_user} password={_pw} sslmode={_ssl}"
POSTGRES_URL = f"postgresql://{quote(_user)}:{quote(_pw, safe='')}@{_host}:{_port}/{_name}?sslmode={_ssl}"

WORK = ROOT / "_work"
for _d in ("cache", "outputs", "logs"):
    (WORK / _d).mkdir(parents=True, exist_ok=True)
