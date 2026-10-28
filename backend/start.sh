#!/bin/sh
# Container start-up for hosted deploys (e.g. Render: start command `sh start.sh`):
# apply database migrations, load the demo data (idempotent), then serve.
set -e
alembic upgrade head
python -m app.db.seed
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
