from __future__ import annotations

import io
import json

import numpy as np
from PIL import Image
import pytest

from exposure_api import main
from exposure_api.models import GenerativeLayerPlan


IDENTITY = {"rotationDegrees": 0, "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1]}


@pytest.mark.parametrize("operation", ["remove", "add"])
def test_legacy_add_remove_modes_are_not_public_operations(client, operation) -> None:
    image = Image.new("RGB", (20, 20), "#665544")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")

    response = client.post(
        "/v1/layers/generative",
        files={"image": ("photo.png", encoded.getvalue(), "image/png")},
        data={
            "target_json": json.dumps({"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}),
            "prompt": "Change the selected area.",
            "source_version_id": "source-v1",
            "operation": operation,
        },
    )

    assert response.status_code == 422


def test_generation_source_defers_collective_adjustments_until_final_render(client, monkeypatch) -> None:
    class CapturingProvider:
        configured = True
        image_model = "capture-image-fixture"
        received: bytes | None = None

        async def generate_candidate(self, image_bytes, *_args, **_kwargs):
            self.received = image_bytes
            return image_bytes

    provider = CapturingProvider()
    monkeypatch.setattr(main, "provider", provider)
    image = Image.new("RGB", (20, 12), (20, 30, 40))
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")

    response = client.post(
        "/v1/layers/generative",
        files={"image": ("photo.png", encoded.getvalue(), "image/png")},
        data={
            "target_json": json.dumps({"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}),
            "prompt": "Remove the selected object.",
            "source_version_id": "source-v1",
            "operation": "amplify",
            "layer_stack_json": json.dumps({
                "canvasTransform": IDENTITY,
                "adjustments": {"exposure": 1},
                "layers": [],
            }),
        },
    )

    assert response.status_code == 200, response.text
    assert provider.received is not None
    generation_pixels = np.asarray(Image.open(io.BytesIO(provider.received)).convert("RGB"))
    assert tuple(generation_pixels[6, 10]) == (20, 30, 40)


def test_amplify_splits_one_prompt_into_independently_generated_layers(client, monkeypatch) -> None:
    class LayerPlanningProvider:
        configured = True
        image_model = "layered-image-fixture"
        prompts: list[str] = []

        async def plan_generation(self, prompt, **_kwargs):
            assert prompt == "Give me a green beard, blue eyes, and red hair."
            return GenerativeLayerPlan.model_validate({
                "layers": [
                    {"name": "Green beard", "prompt": "Make the beard green."},
                    {"name": "Blue eyes", "prompt": "Make the eyes blue."},
                    {"name": "Red hair", "prompt": "Make the hair red."},
                ],
            })

        async def generate_candidate(self, image_bytes, _mime_type, prompt, *_args, **_kwargs):
            self.prompts.append(prompt)
            return image_bytes

    provider = LayerPlanningProvider()
    monkeypatch.setattr(main, "provider", provider)
    image = Image.new("RGB", (80, 80), "#665544")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")

    response = client.post(
        "/v1/layers/generative",
        files={"image": ("portrait.png", encoded.getvalue(), "image/png")},
        data={
            "target_json": json.dumps({"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9}),
            "prompt": "Give me a green beard, blue eyes, and red hair.",
            "source_version_id": "source-v1",
            "operation": "amplify",
            "layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": []}),
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert [layer["name"] for layer in payload["layers"]] == ["Green beard", "Blue eyes", "Red hair"]
    assert [layer["prompt"] for layer in payload["layers"]] == provider.prompts
    assert len({layer["patchBase64"] for layer in payload["layers"]}) == 1
    assert payload["expansion"] is None


def test_expand_response_includes_the_pre_expansion_reference_canvas(client, monkeypatch) -> None:
    class EchoImageProvider:
        configured = True
        image_model = "echo-image-fixture"

        async def generate_candidate(self, image_bytes, *_args, **_kwargs):
            return image_bytes

    monkeypatch.setattr(main, "provider", EchoImageProvider())
    image = Image.new("RGB", (100, 60), "#335577")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")

    response = client.post(
        "/v1/layers/generative",
        files={"image": ("photo.png", encoded.getvalue(), "image/png")},
        data={
            "target_json": json.dumps({"x": 0.3, "y": 0.3, "width": 0.4, "height": 0.4}),
            "prompt": "Continue the scene naturally.",
            "source_version_id": "source-v1",
            "operation": "expand",
            "expansion_json": json.dumps({"direction": "right", "fraction": 0.25}),
            "layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": []}),
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["expansion"] == {
        "top": 0,
        "right": 25,
        "bottom": 0,
        "left": 0,
        "referenceWidth": 100,
        "referenceHeight": 60,
    }

    cumulative = client.post(
        "/v1/layers/generative",
        files={"image": ("photo.png", encoded.getvalue(), "image/png")},
        data={
            "target_json": json.dumps({"x": 0.3, "y": 0.3, "width": 0.4, "height": 0.4}),
            "prompt": "Continue the scene naturally.",
            "source_version_id": "source-v2",
            "operation": "expand",
            "expansion_json": json.dumps({"direction": "right", "fraction": 0.25}),
            "layer_stack_json": json.dumps({
                "canvasTransform": {
                    **IDENTITY,
                    "expansion": {
                        "top": 0,
                        "right": 40,
                        "bottom": 0,
                        "left": 0,
                        "referenceWidth": 200,
                        "referenceHeight": 120,
                    },
                },
                "layers": [],
            }),
        },
    )

    # The existing 40px inset scales to 20px on this 100px content canvas;
    # expanding the resulting 120px canvas by 25% adds another 30px.
    assert cumulative.status_code == 200, cumulative.text
    assert cumulative.json()["expansion"] == {
        "top": 0,
        "right": 50,
        "bottom": 0,
        "left": 0,
        "referenceWidth": 100,
        "referenceHeight": 60,
    }
