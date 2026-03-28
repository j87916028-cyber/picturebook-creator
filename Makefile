.PHONY: test test-backend test-frontend typecheck build dev up down logs

# ── Test ─────────────────────────────────────────────────────
test: test-backend test-frontend  ## Run all 36 tests (backend + frontend)

test-backend:  ## Run 20 backend smoke tests
	cd backend && python -m pytest test_smoke.py -v

test-frontend:  ## Run 16 frontend unit tests
	cd frontend && npm run test

# ── Quality ──────────────────────────────────────────────────
typecheck:  ## TypeScript type-check (no build output)
	cd frontend && npm run typecheck

build:  ## Production build (frontend)
	cd frontend && npm run build

# ── Docker ───────────────────────────────────────────────────
up:  ## Start all services (build + detach)
	docker compose up --build -d

down:  ## Stop all services
	docker compose down

logs:  ## Tail all service logs
	docker compose logs -f --tail=50

# ── Local dev (no Docker) ────────────────────────────────────
dev:  ## Start backend + frontend for local development
	@echo "Starting backend..."
	cd backend && uvicorn main:app --reload --port 8000 &
	@echo "Starting frontend..."
	cd frontend && npm run dev
