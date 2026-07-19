from __future__ import annotations

import asyncio
import argparse
import os
from collections import defaultdict
from typing import Any

import httpx

from exposure_api.database import MongoDatabase
from exposure_api.models import AnalysisResult
from exposure_api.sync_models import (
    AnalysisWrite,
    CloudLayerAsset,
    CloudPhoto,
    CloudPhotoVersion,
    CloudPreferences,
    CloudStyleProfile,
)


TABLES = (
    "profiles",
    "photos",
    "photo_versions",
    "layer_assets",
    "analyses",
    "style_profiles",
    "portfolio_reviews",
    "jobs",
)


class SupabaseReader:
    def __init__(self) -> None:
        self.url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
        self.key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.getenv("SUPABASE_SECRET_KEY", "").strip()
        )
        if not self.url or not self.key:
            raise RuntimeError("SUPABASE_URL and a Supabase service key are required for migration.")

    async def read_table(self, table: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=30) as client:
            for offset in range(0, 100_000, 1_000):
                response = await client.get(
                    f"{self.url}/rest/v1/{table}",
                    params={"select": "*", "order": "created_at.asc.nullsfirst"},
                    headers={
                        "apikey": self.key,
                        "Authorization": f"Bearer {self.key}",
                        "Range": f"{offset}-{offset + 999}",
                    },
                )
                response.raise_for_status()
                page = response.json()
                if not isinstance(page, list):
                    raise RuntimeError(f"Supabase returned an invalid {table} response.")
                rows.extend(page)
                if len(page) < 1_000:
                    return rows
        raise RuntimeError(f"Supabase {table} exceeded the migration safety limit.")


async def migrate(*, source_counts_only: bool = False) -> None:
    reader = SupabaseReader()
    source = {table: await reader.read_table(table) for table in TABLES}
    if source_counts_only:
        print("Supabase source rows: " + ", ".join(f"{table}={len(source[table])}" for table in TABLES))
        return
    database = MongoDatabase()
    if not database.configured:
        raise RuntimeError("MONGODB_URI is required for migration.")
    await database.startup()
    migrated = defaultdict(int)
    try:
        versions_by_photo: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for version in source["photo_versions"]:
            versions_by_photo[str(version["photo_id"])].append(version)
        assets_by_photo: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for asset in source["layer_assets"]:
            assets_by_photo[str(asset["photo_id"])].append(asset)

        for row in source["photos"]:
            photo_id = str(row["id"])
            versions = versions_by_photo[photo_id]
            if not versions:
                raise RuntimeError(f"Supabase photo {photo_id} has no version history.")
            versions.sort(key=lambda item: str(item.get("created_at") or ""))
            current_version_id = str(row.get("current_version_id") or versions[-1]["id"])
            photo = CloudPhoto(
                id=photo_id,
                original_path=str(row["original_path"]),
                original_name=str(row["original_name"]),
                original_mime_type=str(row["original_mime_type"]),
                original_byte_size=int(row["original_byte_size"]),
                original_checksum=str(row["original_checksum"]),
                capture_source=row["capture_source"],
                width=row.get("width"),
                height=row.get("height"),
                exif=row.get("exif") or {},
                current_version_id=current_version_id,
                created_at=str(row["created_at"]),
                versions=[
                    CloudPhotoVersion(
                        id=str(version["id"]),
                        parent_version_id=_optional_string(version.get("parent_version_id")),
                        restored_from_version_id=_optional_string(version.get("restored_from_version_id")),
                        label=str(version["label"]),
                        stack={
                            "canvasTransform": version["canvas_transform"],
                            "adjustments": version.get("adjustments") or {},
                            "layers": version.get("layer_stack") or [],
                        },
                        analysis_proxy_path=_optional_string(version.get("analysis_proxy_path")),
                        thumbnail_path=_optional_string(version.get("thumbnail_path")),
                        created_at=str(version["created_at"]),
                    )
                    for version in versions
                ],
                layer_assets=[
                    CloudLayerAsset(
                        id=str(asset["id"]),
                        kind=asset["kind"],
                        storage_path=str(asset["storage_path"]),
                        checksum=str(asset["checksum"]),
                        mime_type=str(asset["mime_type"]),
                    )
                    for asset in assets_by_photo[photo_id]
                ],
            )
            await database.upsert_photo(str(row["owner_id"]), photo)
            migrated["photos"] += 1

        for row in source["analyses"]:
            analysis = AnalysisResult(
                version_id=str(row["version_id"]),
                checksum=str(row["checksum"]),
                created_at=str(row["created_at"]),
                deterministic_model=str(row["deterministic_model"]),
                semantic_model=_optional_string(row.get("semantic_model")),
                metrics=row.get("metrics") or {},
                lighting=row["lighting"],
                signals=row.get("signals") or [],
                issues=row.get("issues") or [],
                camera_recommendations=row.get("camera_recommendations") or [],
                summary=str(row["summary"]),
            )
            await database.upsert_analysis(
                str(row["owner_id"]),
                AnalysisWrite(photo_id=str(row["photo_id"]), analysis=analysis),
            )
            migrated["analyses"] += 1

        for row in source["style_profiles"]:
            style = CloudStyleProfile(
                id=str(row["id"]),
                name=str(row["name"]),
                reference_photo_ids=[str(value) for value in row.get("reference_photo_ids") or []],
                palette=row.get("palette") or [],
                adjustments=row.get("adjustments") or {},
                mood=str(row["mood"]),
                model_versions=row.get("model_versions") or {},
                created_at=str(row["created_at"]),
                updated_at=str(row.get("updated_at") or row["created_at"]),
            )
            await database.upsert_style_profile(str(row["owner_id"]), style)
            migrated["style_profiles"] += 1

        for row in source["profiles"]:
            preferences = CloudPreferences(
                skill_level=row.get("skill_level") or "enthusiast",
                feedback_detail=row.get("feedback_detail") or "detailed",
                desired_mood=row.get("desired_mood") or "",
                export_metadata=bool(row.get("export_metadata", True)),
                export_gps=bool(row.get("export_gps", False)),
                recommendation_feedback=row.get("recommendation_feedback") or {"accepted": [], "rejected": []},
                camera_preferences=row.get("camera_preferences") or {},
            )
            await database.upsert_preferences(str(row["id"]), preferences)
            migrated["profiles"] += 1

        await _replace_raw_rows(database, "portfolio_reviews", source["portfolio_reviews"])
        await _replace_raw_rows(database, "jobs", source["jobs"])
        migrated["portfolio_reviews"] = len(source["portfolio_reviews"])
        migrated["jobs"] = len(source["jobs"])
    finally:
        await database.shutdown()

    summary = ", ".join(f"{table}={migrated[table]}" for table in TABLES if table not in {"photo_versions", "layer_assets"})
    print(f"Supabase to MongoDB Atlas migration complete: {summary}")


async def _replace_raw_rows(database: MongoDatabase, collection_name: str, rows: list[dict[str, Any]]) -> None:
    collection = database._collection(collection_name)
    for row in rows:
        owner_id = str(row["owner_id"])
        identifier = str(row["id"])
        document = _camelize_record(row)
        document.update({"_id": f"{owner_id}:{identifier}", "ownerId": owner_id})
        await collection.replace_one({"_id": document["_id"]}, document, upsert=True)


def _camelize_record(record: dict[str, Any]) -> dict[str, Any]:
    return {_camel(key): value for key, value in record.items() if key != "owner_id"}


def _camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


def _optional_string(value: Any) -> str | None:
    return str(value) if value is not None else None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate Exposure structured data from Supabase to MongoDB Atlas.")
    parser.add_argument(
        "--source-counts",
        action="store_true",
        help="Read and report Supabase row counts without connecting to Atlas.",
    )
    arguments = parser.parse_args()
    asyncio.run(migrate(source_counts_only=arguments.source_counts))
