"""Central model registry.

Importing this module registers every ORM model against Base.metadata, which
Alembic autogenerate, `create_all` (dev/test bootstrap) and the seeder rely on.
Add new module model files here as they are created.
"""
from __future__ import annotations

from app.db.base import Base  # noqa: F401
from app.modules.attendance import models as attendance_models  # noqa: F401
from app.modules.forecasting import models as forecasting_models  # noqa: F401
from app.modules.identity import models as identity_models  # noqa: F401
from app.modules.intraday import models as intraday_models  # noqa: F401
from app.modules.notifications import models as notification_models  # noqa: F401
from app.modules.planning import models as planning_models  # noqa: F401
from app.modules.requests import models as request_models  # noqa: F401
from app.modules.scheduling import models as scheduling_models  # noqa: F401
from app.modules.workforce import models as workforce_models  # noqa: F401
