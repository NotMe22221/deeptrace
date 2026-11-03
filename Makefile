# DEEPTRACE — common tasks
PY := backend/.venv/bin/python

.PHONY: setup dev backend frontend test test-backend typecheck build generate snapshot ingest assets

setup:            ## install frontend + backend dependencies
	npm install
	python3 -m venv backend/.venv
	backend/.venv/bin/pip install -r backend/requirements.txt

dev:              ## run backend (:8000) and frontend (:3000)
	./scripts/dev.sh

backend:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend:
	npx next dev -p 3000

test: test-backend typecheck

test-backend:
	cd backend && .venv/bin/python -m pytest -q

typecheck:
	npx tsc --noEmit

build:
	npx next build

generate:         ## regenerate the region network dataset (deterministic)
	cd backend && .venv/bin/python -m app.networks.generate

snapshot:         ## export precomputed engine outputs for offline demo mode
	cd backend && .venv/bin/python -m app.scripts.export_snapshot

ingest:           ## fetch + cache OpenStreetMap data for the region (needs network access)
	cd backend && .venv/bin/python -m app.ingest.overpass
	cd backend && .venv/bin/python -m app.networks.generate --use-osm

assets:           ## download CC0 Poly Haven models into public/assets/models (needs network access)
	cd backend && .venv/bin/python -m app.ingest.assets
