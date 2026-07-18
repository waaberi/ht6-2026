from __future__ import annotations

import hashlib
import io
import json

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from exposure_api.models import LayerStack
from exposure_api.renderer import render_layer_stack


IDENTITY = {"rotationDegrees": 0, "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1]}


def _render(client: TestClient, image_bytes: bytes, layers: list[dict]) -> bytes:
    response = client.post(
        "/v1/render",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={"layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": layers}), "output_format": "png"},
    )
    assert response.status_code == 200, response.text
    return response.content


def test_disabling_every_layer_recovers_original_pixels(client: TestClient, image_bytes: bytes) -> None:
    before = hashlib.sha256(image_bytes).hexdigest()
    rendered = _render(client, image_bytes, [{"type": "adjustment", "enabled": False, "opacity": 1, "adjustments": {"exposure": 1}}])
    source_pixels = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    rendered_pixels = np.asarray(Image.open(io.BytesIO(rendered)).convert("RGB"))
    assert np.array_equal(source_pixels, rendered_pixels)
    assert hashlib.sha256(image_bytes).hexdigest() == before


def test_render_cache_can_be_reconstructed_deterministically(client: TestClient, image_bytes: bytes) -> None:
    layer = {"type": "adjustment", "enabled": True, "opacity": 1, "adjustments": {"exposure": 0.4, "contrast": 0.1}}
    first = _render(client, image_bytes, [layer])
    second = _render(client, image_bytes, [layer])
    assert first == second
    assert first != image_bytes


def test_crop_remains_a_canvas_transform(client: TestClient, image_bytes: bytes) -> None:
    response = client.post(
        "/v1/render",
        files={"image": ("photo.png", image_bytes, "image/png")},
        data={"layer_stack_json": json.dumps({"canvasTransform": {**IDENTITY, "crop": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}}, "layers": []}), "output_format": "png"},
    )
    assert response.status_code == 200
    assert Image.open(io.BytesIO(response.content)).size == (60, 40)


def test_jpeg_export_preserves_requested_metadata(client: TestClient) -> None:
    source = Image.new("RGB", (24, 16), "#7a5cff")
    metadata = Image.Exif()
    metadata[271] = "Exposure Fixture Camera"
    metadata[274] = 6
    encoded = io.BytesIO()
    source.save(encoded, format="JPEG", exif=metadata)

    response = client.post(
        "/v1/render",
        files={"image": ("photo.jpg", encoded.getvalue(), "image/jpeg")},
        data={
            "layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": []}),
            "output_format": "jpeg",
            "include_metadata": "true",
            "include_gps": "false",
        },
    )

    assert response.status_code == 200, response.text
    exported = Image.open(io.BytesIO(response.content))
    assert exported.getexif()[271] == "Exposure Fixture Camera"
    assert exported.getexif()[274] == 1


def test_image_asset_remains_an_independent_layer(client: TestClient, image_bytes: bytes) -> None:
    overlay = Image.new("RGBA", (120, 80), (255, 0, 0, 150))
    overlay_bytes = io.BytesIO()
    overlay.save(overlay_bytes, format="PNG")
    layer = {
        "id": "layer",
        "type": "image",
        "enabled": True,
        "opacity": 0.75,
        "assetId": "asset",
        "blendMode": "normal",
        "transform": IDENTITY,
    }
    response = client.post(
        "/v1/render",
        files=[
            ("image", ("photo.png", image_bytes, "image/png")),
            ("assets", ("overlay.png", overlay_bytes.getvalue(), "image/png")),
        ],
        data={
            "layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": [layer]}),
            "asset_ids_json": '["asset"]',
            "output_format": "png",
        },
    )
    assert response.status_code == 200, response.text
    with_layer = np.asarray(Image.open(io.BytesIO(response.content)).convert("RGB"))
    without_layer = np.asarray(Image.open(io.BytesIO(_render(client, image_bytes, [{**layer, "enabled": False}]))).convert("RGB"))
    assert not np.array_equal(with_layer, without_layer)


def test_canvas_space_patch_fills_an_expanded_edge() -> None:
    source = Image.new("RGB", (20, 12), "#335577")
    source_bytes = io.BytesIO()
    source.save(source_bytes, format="PNG")
    patch = Image.new("RGBA", (25, 12), (0, 0, 0, 0))
    patch_pixels = np.asarray(patch).copy()
    patch_pixels[:, 20:] = (238, 189, 168, 255)
    patch = Image.fromarray(patch_pixels, "RGBA")
    patch_bytes = io.BytesIO()
    patch.save(patch_bytes, format="PNG")
    expansion = {"top": 0, "right": 5, "bottom": 0, "left": 0}
    layer = {
        "id": "outpaint",
        "type": "generative-patch",
        "enabled": True,
        "opacity": 1,
        "patchAssetId": "patch",
        "canvasSpace": True,
        "canvasExpansion": expansion,
    }
    rendered_image = render_layer_stack(
        source_bytes.getvalue(),
        LayerStack.model_validate({"canvasTransform": {**IDENTITY, "expansion": expansion}, "layers": [layer]}),
        {"patch": patch_bytes.getvalue()},
    )
    rendered = np.asarray(rendered_image.convert("RGB"))
    assert rendered.shape[:2] == (12, 25)
    assert tuple(rendered[6, 10]) == (51, 85, 119)
    assert tuple(rendered[6, 23]) == (238, 189, 168)


def test_every_collective_adjustment_changes_the_render() -> None:
    yy, xx = np.indices((48, 64), dtype=np.uint8)
    source_pixels = np.stack(
        (
            (xx * 4 + yy * 3) % 255,
            (xx * 7 + yy * 2) % 255,
            (xx * 2 + yy * 9) % 255,
        ),
        axis=2,
    ).astype(np.uint8)
    source = Image.fromarray(source_pixels, "RGB")
    source_bytes = io.BytesIO()
    source.save(source_bytes, format="PNG")
    baseline = np.asarray(
        render_layer_stack(
            source_bytes.getvalue(),
            LayerStack.model_validate({"canvasTransform": IDENTITY, "adjustments": {}, "layers": []}),
        )
    )

    controls = (
        "exposure",
        "contrast",
        "highlights",
        "shadows",
        "temperature",
        "tint",
        "saturation",
        "vibrance",
        "sharpening",
        "denoise",
        "grain",
        "vignette",
    )
    for control in controls:
        rendered = np.asarray(
            render_layer_stack(
                source_bytes.getvalue(),
                LayerStack.model_validate(
                    {"canvasTransform": IDENTITY, "adjustments": {control: 0.5}, "layers": []}
                ),
            )
        )
        assert not np.array_equal(rendered, baseline), f"{control} did not change the render"


def test_rotation_swaps_canvas_without_clipping_and_straighten_avoids_black_corners() -> None:
    source = Image.new("RGB", (30, 10), "#d96b4f")
    encoded = io.BytesIO()
    source.save(encoded, format="PNG")

    rotated = render_layer_stack(
        encoded.getvalue(),
        LayerStack.model_validate({"canvasTransform": {**IDENTITY, "rotationDegrees": 90}, "layers": []}),
    )
    assert rotated.size == (10, 30)
    assert np.min(np.asarray(rotated)) > 0

    straightened = render_layer_stack(
        encoded.getvalue(),
        LayerStack.model_validate({"canvasTransform": {**IDENTITY, "rotationDegrees": 8}, "layers": []}),
    )
    assert straightened.size == source.size
    assert np.min(np.asarray(straightened)) > 0


def test_gps_is_excluded_from_export_unless_explicitly_enabled(client: TestClient) -> None:
    source = Image.new("RGB", (20, 12), "#665544")
    metadata = Image.Exif()
    metadata[271] = "Fixture Camera"
    metadata[34853] = {1: "N", 2: (45.0, 0.0, 0.0), 3: "W", 4: (75.0, 0.0, 0.0)}
    encoded = io.BytesIO()
    source.save(encoded, format="JPEG", exif=metadata)
    common = {
        "layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": []}),
        "output_format": "jpeg",
        "include_metadata": "true",
    }
    private = client.post(
        "/v1/render",
        files={"image": ("photo.jpg", encoded.getvalue(), "image/jpeg")},
        data={**common, "include_gps": "false"},
    )
    explicit = client.post(
        "/v1/render",
        files={"image": ("photo.jpg", encoded.getvalue(), "image/jpeg")},
        data={**common, "include_gps": "true"},
    )
    assert private.status_code == explicit.status_code == 200
    assert Image.open(io.BytesIO(private.content)).getexif().get_ifd(34853) == {}
    assert Image.open(io.BytesIO(explicit.content)).getexif().get_ifd(34853)[1] == "N"
