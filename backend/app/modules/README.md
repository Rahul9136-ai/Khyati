# Domain modules (bounded contexts)

Every product module is a self-contained package here, with the **same layered shape**.
This is the template each future module follows:

```
modules/<domain>/
├── __init__.py
├── models.py          # SQLAlchemy ORM entities (compose db/mixins)
├── schemas.py         # Pydantic DTOs (request/response) — the public contract
├── repository.py      # data access; the ONLY layer importing the ORM session
├── service.py         # business rules, transactions, orchestration
├── dependencies.py    # FastAPI injectables (guards, repo/service factories)
├── router.py          # HTTP endpoints only; delegates to the service
└── tests/             # unit (service w/ fake repo) + integration (router)
```

## Rules (SOLID)

- **Routers** never contain business logic — they validate input, call a service, shape output.
- **Services** depend on a **repository Protocol**, not a concrete class → unit-testable with fakes
  (Dependency Inversion). They own transactions and raise `app.core.exceptions.AppError` subtypes.
- **Repositories** are the only place that touch `AsyncSession`/ORM models.
- **Schemas** are the contract; ORM models never leak out of the service boundary.
- Cross-module calls go **service → service**, never repository → another module's repository.

## Planned packages

| Package | Product modules |
| --- | --- |
| `identity` | User Mgmt, RBAC, Org Setup, Audit Logs, API keys |
| `workforce` | Employees, Skills, PTO/Leave, Shift Bidding |
| `planning` | Forecasting, Capacity, Budget, Headcount, Erlang, Multi-skill, Scheduling, What-if |
| `realtime` | Intraday, RTA, Alert Engine |
| `analytics` | Dashboards, KPI Reporting, Import/Export |
| `ai` | Copilot, AI recommendations, RAG, NL/Voice analytics |
| `notifications` | Notification Center |
