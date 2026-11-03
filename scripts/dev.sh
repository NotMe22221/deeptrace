#!/usr/bin/env bash
# Start the DEEPTRACE backend (FastAPI :8000) and frontend (Next.js :3000) together.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d backend/.venv ]; then
  echo "› creating backend virtualenv"
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi
if [ ! -d node_modules ]; then
  echo "› installing frontend dependencies"
  npm install
fi
if [ ! -f backend/datasets/regions/"${DEEPTRACE_REGION:-atlanta-downtown}"/network.json ]; then
  echo "› generating network dataset"
  (cd backend && .venv/bin/python -m app.networks.generate)
fi

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd backend && .venv/bin/uvicorn app.main:app --port 8000 --reload) &
npx next dev -p 3000 &
echo "› DEEPTRACE → http://localhost:3000   (API docs → http://localhost:8000/docs)"
wait
