.PHONY: up down logs be-install be-test be-lint fe-install fe-dev fe-test migrate revision

up:            ## Start the full local stack
	docker compose up --build

down:          ## Stop and remove containers
	docker compose down

logs:
	docker compose logs -f backend

be-install:    ## Install backend (dev)
	cd backend && pip install -e ".[dev]"

be-test:
	cd backend && pytest -q

be-lint:
	cd backend && ruff check . && mypy app

fe-install:
	cd frontend && npm install

fe-dev:
	cd frontend && npm run dev

fe-test:
	cd frontend && npm test

migrate:       ## Apply migrations
	cd backend && alembic upgrade head

revision:      ## Autogenerate a migration: make revision m="add users"
	cd backend && alembic revision --autogenerate -m "$(m)"
