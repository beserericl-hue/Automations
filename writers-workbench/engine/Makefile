.PHONY: install lint type test cov compose-up compose-down compose-build smoke clean

install:
	uv sync --all-extras

lint:
	uv run ruff check .
	uv run ruff format --check .

format:
	uv run ruff format .
	uv run ruff check --fix .

type:
	uv run mypy

test:
	uv run pytest -q

cov:
	uv run pytest --cov=writer_engine --cov=gateway --cov=orchestrator --cov=library_retrieve_step --cov-report=term-missing

compose-build:
	docker compose build

compose-up:
	docker compose up -d --build

compose-down:
	docker compose down -v

smoke:
	uv run pytest -q -m "not integration and not load"

ci: lint type smoke
