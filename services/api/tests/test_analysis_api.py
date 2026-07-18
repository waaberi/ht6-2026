from __future__ import annotations

import hashlib
import io
import json

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw


def test_analysis_returns_validated_evidence_without_mutating_source(client: TestClient, image_bytes: bytes) -> None:
    before = hashlib.sha256(image_bytes).hexdigest()
    response = client.post(
        "/v1/analyze",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={
            "version_id": "version-1",
            "checksum": before,
            "exif_json": '{"ISO": 200, "GPSLatitude": 45.4, "Camera": "Fixture"}',
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["versionId"] == "version-1"
    assert payload["checksum"] == before
    assert payload["deterministicModel"] == "exposure-deterministic-1"
    assert 0 <= payload["lighting"]["clippedHighlights"] <= 1
    assert all(issue["location"]["width"] > 0 for issue in payload["issues"])
    assert hashlib.sha256(image_bytes).hexdigest() == before
    assert "GPS" not in response.text


def test_analysis_cache_rebinds_the_requested_version(client: TestClient, image_bytes: bytes) -> None:
    checksum = hashlib.sha256(image_bytes).hexdigest()
    first = client.post("/v1/analyze", files={"image": ("one.png", image_bytes, "image/png")}, data={"version_id": "one", "checksum": checksum})
    second = client.post("/v1/analyze", files={"image": ("two.png", image_bytes, "image/png")}, data={"version_id": "two", "checksum": checksum})
    assert first.status_code == second.status_code == 200
    assert second.json()["versionId"] == "two"


def test_camera_advice_does_not_invent_missing_exif(client: TestClient, image_bytes: bytes) -> None:
    response = client.post("/v1/analyze", files={"image": ("photo.png", image_bytes, "image/png")}, data={"version_id": "v", "exif_json": "{}"})
    assert response.status_code == 200
    recommendations = response.json()["cameraRecommendations"]
    assert all(item.get("setting") != "iso" or "EXIF.ISO" in item["basedOn"] for item in recommendations)


def test_upload_validation(client: TestClient) -> None:
    response = client.post("/v1/analyze", files={"image": ("bad.txt", b"not an image", "text/plain")}, data={"version_id": "v"})
    assert response.status_code == 415


def test_tilt_fixture_produces_a_reversible_transform_fix(client: TestClient) -> None:
    image = Image.new("RGB", (240, 140), "#303030")
    ImageDraw.Draw(image).line((5, 105, 235, 58), fill="white", width=8)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    response = client.post(
        "/v1/analyze",
        files={"image": ("tilted.png", encoded.getvalue(), "image/png")},
        data={"version_id": "tilt-fixture"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert abs(float(payload["metrics"]["estimatedTiltDegrees"])) > 3
    assert any((issue.get("fix") or {}).get("kind") == "transform" for issue in payload["issues"])


def test_uneven_lighting_fixture_is_localized(client: TestClient) -> None:
    image = Image.new("RGB", (120, 80), "#181818")
    ImageDraw.Draw(image).rectangle((60, 0, 119, 79), fill="#eeeeee")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    response = client.post(
        "/v1/analyze",
        files={"image": ("uneven.png", encoded.getvalue(), "image/png")},
        data={"version_id": "lighting-fixture"},
    )
    assert response.status_code == 200, response.text
    findings = [issue for issue in response.json()["issues"] if issue["title"] == "Illumination is uneven"]
    assert findings and findings[0]["fix"]["kind"] == "masked-adjustment"
    assert findings[0]["location"]["width"] == 0.5


def test_heic_import_is_decoded(client: TestClient) -> None:
    image = Image.new("RGB", (48, 32), "#567890")
    encoded = io.BytesIO()
    image.save(encoded, format="HEIF")
    response = client.post(
        "/v1/analyze",
        files={"image": ("photo.heic", encoded.getvalue(), "image/heic")},
        data={"version_id": "heic-fixture"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["metrics"]["width"] == 48


def test_analysis_measures_the_rendered_current_stack(client: TestClient, image_bytes: bytes) -> None:
    base = client.post(
        "/v1/analyze",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={"version_id": "original", "checksum": hashlib.sha256(image_bytes).hexdigest()},
    )
    stack = {
        "canvasTransform": {"rotationDegrees": 0, "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1]},
        "layers": [{"type": "adjustment", "enabled": True, "opacity": 1, "adjustments": {"exposure": 0.8}}],
    }
    edited = client.post(
        "/v1/analyze",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={
            "version_id": "edited",
            "checksum": hashlib.sha256(image_bytes).hexdigest(),
            "layer_stack_json": json.dumps(stack),
            "asset_ids_json": "[]",
        },
    )
    assert base.status_code == edited.status_code == 200
    assert edited.json()["metrics"]["meanLuminance"] > base.json()["metrics"]["meanLuminance"]
    assert edited.json()["checksum"] != base.json()["checksum"]


def test_coach_returns_structured_fallback(client: TestClient, image_bytes: bytes) -> None:
    analysis = client.post(
        "/v1/analyze",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={"version_id": "coach"},
    ).json()
    response = client.post("/v1/coach", json={"analysis": analysis, "question": "What should I change?"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["headline"]
    assert payload["reason"]
    assert isinstance(payload["evidence"], list)
    assert isinstance(payload["captureAdvice"], list)
    assert len(payload["actions"]) <= 2
