from __future__ import annotations

from typing import Any

from exposure_api.auth import require_database_user
from exposure_api.database import get_mongo_database
from exposure_api.main import app
from exposure_api.sync_models import CloudPhoto, CloudPreferences, DeletedCloudPhoto


PHOTO = {
    "id": "photo-1",
    "originalPath": "auth0|owner/photo-1/original.jpg",
    "originalName": "original.jpg",
    "originalMimeType": "image/jpeg",
    "originalByteSize": 1024,
    "originalChecksum": "checksum",
    "captureSource": "camera",
    "width": 100,
    "height": 80,
    "exif": {},
    "currentVersionId": "version-1",
    "createdAt": "2026-07-19T00:00:00+00:00",
    "versions": [
        {
            "id": "version-1",
            "label": "Original",
            "stack": {
                "canvasTransform": {
                    "rotationDegrees": 0,
                    "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                },
                "layers": [],
            },
            "analysisProxyPath": "auth0|owner/photo-1/analysis-proxy.jpg",
            "thumbnailPath": "auth0|owner/photo-1/thumbnail.jpg",
            "createdAt": "2026-07-19T00:00:00+00:00",
        },
    ],
    "layerAssets": [],
}


class FakeMongoDatabase:
    connected = True

    def __init__(self) -> None:
        self.photos: dict[str, CloudPhoto] = {}
        self.preferences: dict[str, CloudPreferences] = {}
        self.owner_ids: list[str] = []

    async def list_photos(self, owner_id: str) -> list[CloudPhoto]:
        self.owner_ids.append(owner_id)
        return list(self.photos.values())

    async def upsert_photo(self, owner_id: str, photo: CloudPhoto) -> CloudPhoto:
        self.owner_ids.append(owner_id)
        self.photos[photo.id] = photo
        return photo

    async def delete_photo(self, owner_id: str, photo_id: str) -> DeletedCloudPhoto:
        self.owner_ids.append(owner_id)
        photo = self.photos.pop(photo_id, None)
        return DeletedCloudPhoto(
            deleted=True,
            original_path=photo.original_path if photo else None,
        )

    async def get_preferences(self, owner_id: str) -> CloudPreferences | None:
        self.owner_ids.append(owner_id)
        return self.preferences.get(owner_id)

    async def upsert_preferences(self, owner_id: str, preferences: CloudPreferences) -> CloudPreferences:
        self.owner_ids.append(owner_id)
        self.preferences[owner_id] = preferences
        return preferences


async def _database_user() -> dict[str, Any]:
    return {"sub": "auth0|owner"}


def test_sync_routes_are_owner_scoped_and_round_trip_documents(client) -> None:
    database = FakeMongoDatabase()
    async def fake_database():
        return database
    app.dependency_overrides[get_mongo_database] = fake_database
    app.dependency_overrides[require_database_user] = _database_user
    try:
        write = client.put("/v1/sync/photos/photo-1", json=PHOTO)
        assert write.status_code == 200, write.text

        listed = client.get("/v1/sync/photos")
        assert listed.status_code == 200, listed.text
        assert listed.json()[0]["id"] == PHOTO["id"]
        assert listed.json()[0]["versions"][0]["id"] == "version-1"

        preferences = client.put("/v1/sync/preferences", json={
            "skillLevel": "professional",
            "feedbackDetail": "concise",
            "desiredMood": "cinematic",
            "exportMetadata": True,
            "exportGps": False,
            "recommendationFeedback": {"accepted": [], "rejected": []},
            "cameraPreferences": {"showGrid": True},
        })
        assert preferences.status_code == 200, preferences.text
        assert client.get("/v1/sync/preferences").json()["skillLevel"] == "professional"

        deleted = client.delete("/v1/sync/photos/photo-1")
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["deleted"] is True
        assert client.get("/v1/sync/photos").json() == []
    finally:
        app.dependency_overrides.clear()

    assert database.owner_ids
    assert set(database.owner_ids) == {"auth0|owner"}


def test_sync_photo_path_must_match_body(client) -> None:
    database = FakeMongoDatabase()
    async def fake_database():
        return database
    app.dependency_overrides[get_mongo_database] = fake_database
    app.dependency_overrides[require_database_user] = _database_user
    try:
        response = client.put("/v1/sync/photos/a-different-photo", json=PHOTO)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422
    assert database.photos == {}


def test_sync_photo_rejects_another_owners_storage_path(client) -> None:
    database = FakeMongoDatabase()
    async def fake_database():
        return database
    app.dependency_overrides[get_mongo_database] = fake_database
    app.dependency_overrides[require_database_user] = _database_user
    try:
        response = client.put(
            "/v1/sync/photos/photo-1",
            json={**PHOTO, "originalPath": "auth0|someone-else/photo-1/original.jpg"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422
    assert database.photos == {}
