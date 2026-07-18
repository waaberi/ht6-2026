from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from exposure_api.generative import ExcessiveDriftError, extract_localized_patch
from exposure_api.models import Region


def _png(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_extracts_only_localized_generated_pixels() -> None:
    original = Image.new("RGB", (100, 100), "white")
    candidate = original.copy()
    ImageDraw.Draw(candidate).rectangle((40, 40, 59, 59), fill="red")
    result = extract_localized_patch(_png(original), _png(candidate), Region(x=0.35, y=0.35, width=0.3, height=0.3), model="fixture", source_version_id="v")
    assert result.drift_score == 0
    assert result.patch_base64
    assert result.mask_base64


def test_rejects_unrelated_generated_drift() -> None:
    original = Image.new("RGB", (100, 100), "white")
    candidate = Image.new("RGB", (100, 100), "black")
    with pytest.raises(ExcessiveDriftError):
        extract_localized_patch(_png(original), _png(candidate), Region(x=0.4, y=0.4, width=0.2, height=0.2), model="fixture", source_version_id="v")
