from __future__ import annotations

import asyncio
import hashlib
import io
import json

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from exposure_api import main
from exposure_api.models import SemanticAnalysis
from exposure_api.providers import SemanticProviderResult


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
    assert payload["deterministicModel"] == "exposure-deterministic-2"
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


def test_analysis_handles_odd_width_images(client: TestClient) -> None:
    image = Image.new("RGB", (121, 200), "#253b38")
    ImageDraw.Draw(image).rectangle((61, 36, 102, 164), fill="#eabda8")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")

    response = client.post(
        "/v1/analyze",
        files={"image": ("odd-width.png", encoded.getvalue(), "image/png")},
        data={"version_id": "odd-width"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["metrics"]["width"] == 121
    assert 0 <= response.json()["metrics"]["mirrorDifference"] <= 1


def test_analysis_returns_deterministic_result_when_semantic_provider_times_out(
    client: TestClient,
    monkeypatch,
) -> None:
    class SlowProvider:
        configured = True
        semantic_model = "slow-semantic-fixture"

        async def analyze_semantics(self, *_args, **_kwargs):
            await asyncio.sleep(0.05)
            raise AssertionError("semantic response should have timed out")

    image = Image.new("RGB", (137, 91), "#45635e")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    monkeypatch.setattr(main, "provider", SlowProvider())
    monkeypatch.setattr(main, "SEMANTIC_TIMEOUT_SECONDS", 0.01)

    response = client.post(
        "/v1/analyze",
        files={"image": ("slow-semantic.png", encoded.getvalue(), "image/png")},
        data={"version_id": "slow-semantic"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["deterministicModel"] == "exposure-deterministic-2"
    assert "semanticModel" not in response.json() or response.json()["semanticModel"] is None


def test_semantic_timeout_does_not_poison_the_retry_cache(client: TestClient, monkeypatch) -> None:
    class RecoveringProvider:
        configured = True
        semantic_model = "recovering-semantic-fixture"
        calls = 0

        async def analyze_semantics(self, *_args, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                await asyncio.sleep(0.05)
                return None
            return SemanticAnalysis(summary="Semantic retry succeeded.", apparent_intent="A measured test image.")

    image = Image.new("RGB", (139, 93), "#526b63")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    provider = RecoveringProvider()
    monkeypatch.setattr(main, "provider", provider)
    monkeypatch.setattr(main, "SEMANTIC_TIMEOUT_SECONDS", 0.01)

    request = {
        "files": {"image": ("recovering-semantic.png", encoded.getvalue(), "image/png")},
        "data": {"version_id": "semantic-retry"},
    }
    first = client.post("/v1/analyze", **request)
    second = client.post("/v1/analyze", **request)

    assert first.status_code == second.status_code == 200
    assert first.json().get("semanticModel") is None
    assert second.json()["semanticModel"] == "recovering-semantic-fixture"
    assert second.json()["summary"] == "Semantic retry succeeded."
    assert provider.calls == 2


def test_analysis_reports_the_text_model_that_succeeded(client: TestClient, monkeypatch) -> None:
    class FallbackProvider:
        configured = True
        semantic_model = "primary-fixture"
        semantic_models = (semantic_model, "fallback-fixture")

        async def analyze_semantics(self, *_args, **_kwargs):
            return SemanticProviderResult(
                analysis=SemanticAnalysis(summary="Fallback model succeeded."),
                model="fallback-fixture",
            )

    image = Image.new("RGB", (141, 95), "#526b63")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    monkeypatch.setattr(main, "provider", FallbackProvider())

    response = client.post(
        "/v1/analyze",
        files={"image": ("fallback-semantic.png", encoded.getvalue(), "image/png")},
        data={"version_id": "fallback-semantic"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["semanticModel"] == "fallback-fixture"
    assert response.json()["summary"] == "Fallback model succeeded."


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
    assert any((signal.get("fix") or {}).get("kind") == "transform" for signal in payload["signals"])


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
    signals = [signal for signal in response.json()["signals"] if signal["signalKey"] == "lighting.quadrant-unevenness"]
    assert signals and signals[0]["fix"]["kind"] == "masked-adjustment"
    assert signals[0]["location"]["width"] == 0.5


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


def test_coach_timeout_returns_structured_local_response(
    client: TestClient,
    image_bytes: bytes,
    monkeypatch,
) -> None:
    analysis = client.post(
        "/v1/analyze",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={"version_id": "coach-timeout"},
    ).json()

    class SlowCoachProvider:
        configured = True
        semantic_model = "slow-coach"
        semantic_models = (semantic_model,)
        image_model = "image-fixture"

        async def coach(self, *_args, **_kwargs):
            await asyncio.sleep(0.05)
            raise AssertionError("Coach should have timed out")

    monkeypatch.setattr(main, "provider", SlowCoachProvider())
    monkeypatch.setattr(main, "COACH_TIMEOUT_SECONDS", 0.01)

    response = client.post("/v1/coach", json={"analysis": analysis, "question": "What should I change?"})

    assert response.status_code == 200, response.text
    assert response.json()["model"] == "exposure-fallback-coach-1"


def test_image_generation_timeout_is_bounded(
    client: TestClient,
    image_bytes: bytes,
    monkeypatch,
) -> None:
    class SlowImageProvider:
        configured = True
        semantic_model = "semantic-fixture"
        semantic_models = (semantic_model,)
        image_model = "slow-image"

        async def generate_candidate(self, *_args, **_kwargs):
            await asyncio.sleep(0.05)
            raise AssertionError("image generation should have timed out")

    monkeypatch.setattr(main, "provider", SlowImageProvider())
    monkeypatch.setattr(main, "IMAGE_TIMEOUT_SECONDS", 0.01)

    response = client.post(
        "/v1/layers/generative",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={
            "target_json": '{"x":0.25,"y":0.25,"width":0.5,"height":0.5}',
            "prompt": "Remove the center detail.",
            "source_version_id": "image-timeout",
        },
    )

    assert response.status_code == 504, response.text
    assert response.json()["detail"] == "Gemini image generation timed out."
