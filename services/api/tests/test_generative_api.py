from __future__ import annotations

import io
import json

from PIL import Image

from exposure_api import main


IDENTITY = {"rotationDegrees": 0, "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1]}


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
