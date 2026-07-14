#!/bin/sh
# Self-provisioning boot: when the container knows the database owner URL,
# it provisions the runtime roles and runs migrations itself before starting
# the API. This makes the image work unchanged on any Docker host (Railway,
# Render, Fly, Koyeb, a VPS) with just ADMIN_DB_URL + JWT_SECRET set — no
# pre-deploy hooks or manual migration step required. bootstrap-and-migrate
# is idempotent and never exits non-zero; the API reports database state at
# /health either way. Set MIGRATE_ON_BOOT=false to skip (e.g. docker-compose,
# where a dedicated migrate service owns this step).
if [ -n "${ADMIN_DB_URL:-}" ] && [ "${MIGRATE_ON_BOOT:-true}" != "false" ]; then
  node db-dist/bootstrap-and-migrate.js
fi
exec node dist/main.js
