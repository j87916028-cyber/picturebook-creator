.PHONY: test test-backend test-frontend typecheck lint check build dev up down logs

# ── All-in-one quality check (mirrors CI) ─────────────────────
check: typecheck lint test build  ## Run ALL checks: types + lint + tests + build

# ── Test ─────────────────────────────────────────────────────
test: test-backend test-frontend  ## Run all 36 tests

test-backend:  ## 20 backend smoke tests (pytest)
	cd backend && python -m pytest test_smoke.py -v

test-frontend:  ## 16 frontend unit tests (vitest)
	cd frontend && npm run test

# ── Quality ──────────────────────────────────────────────────
typecheck:  ## TypeScript type-check (no build output)
	cd frontend && npm run typecheck

lint:  ## ESLint (0 errors allowed, ≤50 warnings)
	cd frontend && npx eslint src/ --max-warnings 50

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
