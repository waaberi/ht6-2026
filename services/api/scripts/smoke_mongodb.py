from __future__ import annotations

import asyncio
from uuid import uuid4

from exposure_api.database import MongoDatabase


async def main() -> None:
    database = MongoDatabase()
    if not database.configured:
        raise SystemExit("MONGODB_URI is not configured.")

    await database.startup()
    identifier = f"connectivity:{uuid4()}"
    try:
        checks = database._collection("connectivity_checks")
        await checks.insert_one({"_id": identifier, "service": "Exposure"})
        stored = await checks.find_one({"_id": identifier})
        if not stored or stored.get("service") != "Exposure":
            raise RuntimeError("MongoDB Atlas did not round-trip the connectivity document.")
        deleted = await checks.delete_one({"_id": identifier})
        if deleted.deleted_count != 1:
            raise RuntimeError("MongoDB Atlas did not remove the connectivity document.")
        print(f"MongoDB Atlas: read/write ok ({database.database_name})")
    finally:
        await database.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
