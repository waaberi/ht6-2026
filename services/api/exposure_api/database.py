from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

from pymongo import ASCENDING, DESCENDING, AsyncMongoClient
from pymongo.server_api import ServerApi

from .models import AnalysisResult
from .sync_models import (
    AnalysisWrite,
    CloudPhoto,
    CloudPortfolioReview,
    CloudPreferences,
    CloudStyleProfile,
    DeletedCloudPhoto,
)


class ImmutablePhotoError(ValueError):
    pass


class MongoDatabase:
    def __init__(self, uri: str | None = None, database_name: str | None = None) -> None:
        self.uri = (uri if uri is not None else os.getenv("MONGODB_URI", "")).strip()
        self.database_name = (
            database_name if database_name is not None else os.getenv("MONGODB_DATABASE", "exposure")
        ).strip() or "exposure"
        self.client: AsyncMongoClient[dict[str, Any]] | None = None
        self.database: Any | None = None
        self.connected = False

    @property
    def configured(self) -> bool:
        return self.uri.startswith("mongodb://") or self.uri.startswith("mongodb+srv://")

    async def startup(self) -> None:
        if not self.configured:
            return
        self.client = AsyncMongoClient(
            self.uri,
            server_api=ServerApi("1"),
            serverSelectionTimeoutMS=10_000,
            appname="Exposure API",
        )
        await self.client.admin.command("ping")
        self.database = self.client[self.database_name]
        await self._ensure_indexes()
        self.connected = True

    async def shutdown(self) -> None:
        self.connected = False
        if self.client is not None:
            await self.client.close()
        self.client = None
        self.database = None

    def _collection(self, name: str) -> Any:
        if not self.connected or self.database is None:
            raise RuntimeError("MongoDB Atlas is not configured or connected.")
        return self.database[name]

    async def _ensure_indexes(self) -> None:
        if self.database is None:
            return
        await self.database.photos.create_index([("ownerId", ASCENDING), ("createdAt", DESCENDING)])
        await self.database.analyses.create_index([("ownerId", ASCENDING), ("createdAt", DESCENDING)])
        await self.database.style_profiles.create_index([("ownerId", ASCENDING), ("createdAt", DESCENDING)])
        await self.database.portfolio_reviews.create_index([("ownerId", ASCENDING), ("createdAt", DESCENDING)])

    async def list_photos(self, owner_id: str) -> list[CloudPhoto]:
        cursor = self._collection("photos").find({"ownerId": owner_id}, {"_id": 0, "ownerId": 0})
        documents = await cursor.sort([("createdAt", DESCENDING), ("id", ASCENDING)]).to_list()
        return [CloudPhoto.model_validate(document) for document in documents]

    async def upsert_photo(self, owner_id: str, photo: CloudPhoto) -> CloudPhoto:
        collection = self._collection("photos")
        identifier = f"{owner_id}:{photo.id}"
        existing = await collection.find_one({"_id": identifier})
        document = photo.model_dump(by_alias=True)
        if existing is not None:
            immutable_fields = (
                "originalPath",
                "originalName",
                "originalMimeType",
                "originalByteSize",
                "originalChecksum",
                "captureSource",
                "createdAt",
            )
            if any(existing.get(field) != document.get(field) for field in immutable_fields):
                raise ImmutablePhotoError("A synchronized photo's original metadata cannot be changed.")
            document["versions"] = _merge_by_id(existing.get("versions", []), document["versions"])
            document["layerAssets"] = _merge_by_id(existing.get("layerAssets", []), document["layerAssets"])
        document.update({"_id": identifier, "ownerId": owner_id})
        await collection.replace_one({"_id": identifier}, document, upsert=True)
        return CloudPhoto.model_validate({key: value for key, value in document.items() if key not in {"_id", "ownerId"}})

    async def delete_photo(self, owner_id: str, photo_id: str) -> DeletedCloudPhoto:
        collection = self._collection("photos")
        document = await collection.find_one_and_delete({"_id": f"{owner_id}:{photo_id}", "ownerId": owner_id})
        if document is None:
            return DeletedCloudPhoto(deleted=True)
        await self._collection("analyses").delete_many({"ownerId": owner_id, "photoId": photo_id})
        return DeletedCloudPhoto(
            deleted=True,
            original_path=document.get("originalPath"),
            layer_asset_paths=[
                asset["storagePath"]
                for asset in document.get("layerAssets", [])
                if isinstance(asset, dict) and isinstance(asset.get("storagePath"), str)
            ],
        )

    async def list_analyses(self, owner_id: str) -> list[AnalysisResult]:
        cursor = self._collection("analyses").find({"ownerId": owner_id}, {"_id": 0, "ownerId": 0, "photoId": 0})
        documents = await cursor.sort([("createdAt", DESCENDING), ("versionId", ASCENDING)]).to_list()
        return [AnalysisResult.model_validate(document) for document in documents]

    async def upsert_analysis(self, owner_id: str, request: AnalysisWrite) -> AnalysisResult:
        collection = self._collection("analyses")
        document = request.analysis.model_dump(by_alias=True)
        document.update({
            "_id": f"{owner_id}:{request.analysis.version_id}",
            "ownerId": owner_id,
            "photoId": request.photo_id,
        })
        await collection.replace_one({"_id": document["_id"]}, document, upsert=True)
        return request.analysis

    async def list_style_profiles(self, owner_id: str) -> list[CloudStyleProfile]:
        cursor = self._collection("style_profiles").find({"ownerId": owner_id}, {"_id": 0, "ownerId": 0})
        documents = await cursor.sort([("createdAt", DESCENDING), ("id", ASCENDING)]).to_list()
        return [CloudStyleProfile.model_validate(document) for document in documents]

    async def upsert_style_profile(self, owner_id: str, style: CloudStyleProfile) -> CloudStyleProfile:
        collection = self._collection("style_profiles")
        existing = await collection.find_one({"_id": f"{owner_id}:{style.id}"}, {"createdAt": 1})
        document = style.model_dump(by_alias=True)
        if existing and isinstance(existing.get("createdAt"), str):
            document["createdAt"] = existing["createdAt"]
        document.update({"_id": f"{owner_id}:{style.id}", "ownerId": owner_id})
        await collection.replace_one({"_id": document["_id"]}, document, upsert=True)
        return CloudStyleProfile.model_validate({key: value for key, value in document.items() if key not in {"_id", "ownerId"}})

    async def delete_style_profile(self, owner_id: str, style_id: str) -> None:
        await self._collection("style_profiles").delete_one({"_id": f"{owner_id}:{style_id}", "ownerId": owner_id})

    async def get_preferences(self, owner_id: str) -> CloudPreferences | None:
        document = await self._collection("preferences").find_one(
            {"_id": owner_id, "ownerId": owner_id},
            {"_id": 0, "ownerId": 0},
        )
        return CloudPreferences.model_validate(document) if document else None

    async def upsert_preferences(self, owner_id: str, preferences: CloudPreferences) -> CloudPreferences:
        document = preferences.model_dump(by_alias=True)
        document.update({"_id": owner_id, "ownerId": owner_id})
        await self._collection("preferences").replace_one({"_id": owner_id}, document, upsert=True)
        return preferences

    async def insert_portfolio_review(self, owner_id: str, review: CloudPortfolioReview) -> None:
        document = review.model_dump(by_alias=True)
        document.update({"_id": str(uuid4()), "ownerId": owner_id})
        await self._collection("portfolio_reviews").insert_one(document)


def _merge_by_id(existing: list[Any], incoming: list[Any]) -> list[Any]:
    merged: dict[str, Any] = {}
    for item in [*existing, *incoming]:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            merged[item["id"]] = item
    return list(merged.values())


mongo_database = MongoDatabase()


async def get_mongo_database() -> MongoDatabase:
    return mongo_database
