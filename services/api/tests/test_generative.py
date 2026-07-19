from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image, ImageDraw

from exposure_api.generative import embed_localized_patch, extract_localized_patch, prepare_local_generation
from exposure_api.models import Region


def _png(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _jpeg(image: Image.Image, quality: int = 85) -> bytes:
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=quality)
    return output.getvalue()


def test_extracts_only_localized_generated_pixels() -> None:
    original = Image.new("RGB", (100, 100), "white")
    candidate = original.copy()
    ImageDraw.Draw(candidate).rectangle((40, 40, 59, 59), fill="red")
    result = extract_localized_patch(_png(original), _png(candidate), Region(x=0.35, y=0.35, width=0.3, height=0.3), model="fixture", source_version_id="v")
    assert result.drift_score == 0
    assert result.patch_base64
    assert result.mask_base64

    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")
    mask = Image.open(io.BytesIO(base64.b64decode(result.mask_base64))).convert("L")
    composited = Image.alpha_composite(original.convert("RGBA"), patch).convert("RGB")

    assert patch.size == original.size
    assert mask.size == original.size
    assert patch.getchannel("A").getbbox() == mask.getbbox()
    assert patch.getpixel((0, 0))[3] == 0
    assert patch.getpixel((0, 0))[:3] == original.getpixel((0, 0))
    assert composited.getpixel((0, 0)) == original.getpixel((0, 0))
    assert composited.getpixel((50, 50)) == candidate.getpixel((50, 50))


def test_small_real_world_target_is_enlarged_in_a_context_crop() -> None:
    source = Image.new("RGB", (1200, 800), "white")
    target = Region(x=0.6, y=0.45, width=0.05, height=0.1)

    crop, local_target, box = prepare_local_generation(source, target)

    assert crop.size == (256, 256)
    assert box[0] <= 720 < box[2]
    assert box[1] <= 360 < box[3]
    assert local_target.width > target.width * 4
    assert local_target.height > target.height * 3


def test_crop_local_patch_is_embedded_at_full_canvas_coordinates() -> None:
    crop_patch = Image.new("RGBA", (30, 20), (255, 0, 0, 255))
    crop_mask = Image.new("L", crop_patch.size, 255)
    result = extract_localized_patch(
        _png(Image.new("RGB", crop_patch.size, "white")),
        _png(crop_patch.convert("RGB")),
        Region(x=0, y=0, width=1, height=1),
        operation="expand",
        model="fixture",
        source_version_id="v",
    )
    embedded = embed_localized_patch(
        result,
        Image.new("RGB", (100, 80), "white"),
        (40, 30, 70, 50),
    )
    patch = Image.open(io.BytesIO(base64.b64decode(embedded.patch_base64))).convert("RGBA")

    assert patch.size == (100, 80)
    assert patch.getpixel((39, 40))[3] == 0
    assert patch.getpixel((39, 40))[:3] == (255, 255, 255)
    assert patch.getpixel((40, 30))[3] == 255
    assert patch.getpixel((69, 49))[3] == 255


def test_ignores_sub_perceptual_full_image_noise_outside_the_local_edit() -> None:
    original = Image.new("RGB", (100, 100), (120, 120, 120))
    candidate = Image.new("RGB", original.size, (123, 123, 123))
    ImageDraw.Draw(candidate).rectangle((40, 40, 59, 59), fill="red")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.35, y=0.35, width=0.3, height=0.3),
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert patch.getpixel((0, 0))[3] == 0
    assert patch.getpixel((50, 50))[3] == 255


def test_gemini_jpeg_noise_does_not_trigger_outside_drift_rejection() -> None:
    original = Image.new("RGB", (100, 100), "#496b65")
    ImageDraw.Draw(original).rectangle((40, 40, 59, 59), fill="#eabda8")
    candidate = Image.new("RGB", original.size, "#4c6d67")

    result = extract_localized_patch(
        _png(original),
        _jpeg(candidate),
        Region(x=0.35, y=0.35, width=0.3, height=0.3),
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert patch.getpixel((0, 0))[3] == 0
    assert patch.getpixel((50, 50))[3] > 0


def test_global_candidate_color_drift_is_clipped_instead_of_rejecting_the_patch() -> None:
    original = Image.new("RGB", (100, 100), "#34856f")
    ImageDraw.Draw(original).rectangle((40, 40, 59, 59), fill="#eabda8")
    # These backgrounds have nearly identical LAB luminance but materially
    # different chroma, matching a model-wide color drift without reframing.
    candidate = Image.new("RGB", original.size, "#007fcb")
    ImageDraw.Draw(candidate).rectangle((40, 40, 59, 59), fill="red")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.35, y=0.35, width=0.3, height=0.3),
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert result.drift_score > 0.025
    assert patch.getpixel((0, 0))[3] == 0
    assert patch.getpixel((50, 50))[3] > 0


def test_uniform_generated_drift_is_discarded_as_nonlocal() -> None:
    original = Image.new("RGB", (100, 100), "white")
    candidate = Image.new("RGB", (100, 100), "black")
    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.4, y=0.4, width=0.2, height=0.2),
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert result.drift_score > 0.9
    assert patch.getpixel((0, 0))[3] == 0
    assert patch.getpixel((39, 50))[3] == 0
    assert patch.getpixel((50, 50))[3] == 0
    assert patch.getpixel((60, 50))[3] == 0


def test_isolated_noise_is_removed_from_the_local_layer() -> None:
    original = Image.new("RGB", (100, 100), "white")
    candidate = original.copy()
    draw = ImageDraw.Draw(candidate)
    draw.rectangle((45, 45, 55, 55), fill="red")
    draw.point((25, 25), fill="black")
    draw.point((75, 30), fill="black")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.2, y=0.2, width=0.6, height=0.6),
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert patch.getpixel((50, 50))[3] > 0
    assert patch.getpixel((25, 25))[3] == 0
    assert patch.getpixel((75, 30))[3] == 0


def test_thin_connected_edit_survives_noise_cleanup() -> None:
    original = Image.new("RGB", (100, 100), "white")
    candidate = original.copy()
    ImageDraw.Draw(candidate).line((30, 50, 70, 50), fill="black", width=1)

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.2, y=0.4, width=0.6, height=0.2),
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert patch.getpixel((50, 50))[3] > 0
    assert patch.getpixel((20, 50))[3] == 0


def test_amplify_addition_isolates_the_new_object_from_repainted_background_texture() -> None:
    original = Image.new("RGB", (100, 100), "#507050")
    candidate = original.copy()
    draw = ImageDraw.Draw(candidate)
    draw.rectangle((20, 20, 79, 79), fill="#5c795c")
    draw.ellipse((43, 43, 57, 57), fill="#e32636")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.2, y=0.2, width=0.6, height=0.6),
        operation="amplify",
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")
    alpha = np.asarray(patch.getchannel("A"))

    assert patch.getpixel((50, 50))[3] > 245
    assert patch.getpixel((25, 25))[3] == 0
    assert patch.getpixel((37, 50))[3] < 8
    assert np.mean(alpha[20:80, 20:80] > 0) < 0.4


def test_color_edit_keeps_both_eyes_and_discards_black_corner_and_unrelated_changes() -> None:
    original = Image.new("RGB", (160, 120), "#b98570")
    original_draw = ImageDraw.Draw(original)
    original_draw.ellipse((51, 49, 65, 59), fill="#51362f")
    original_draw.ellipse((95, 49, 109, 59), fill="#51362f")
    candidate = original.copy()
    candidate_draw = ImageDraw.Draw(candidate)
    candidate_draw.ellipse((51, 49, 65, 59), fill="#d71928")
    candidate_draw.ellipse((95, 49, 109, 59), fill="#d71928")
    candidate_draw.rectangle((16, 12, 46, 31), fill="black")
    # Connect the artifact to the intended edit. This reproduces the harder
    # case where generic change-component filtering cannot discard the block
    # without also discarding the requested eye change.
    candidate_draw.line((46, 28, 53, 50), fill="black", width=2)
    candidate_draw.ellipse((121, 72, 137, 88), fill="#1f63dd")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.1, y=0.1, width=0.8, height=0.75),
        operation="amplify",
        model="fixture",
        source_version_id="v",
        prompt="Make both of my eyes red.",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert patch.getpixel((58, 54))[3] > 245
    assert patch.getpixel((102, 54))[3] > 245
    assert patch.getpixel((30, 20))[3] == 0
    assert patch.getpixel((129, 80))[3] == 0


def test_requested_black_corner_is_retained() -> None:
    original = Image.new("RGB", (100, 100), "#c69b82")
    candidate = original.copy()
    ImageDraw.Draw(candidate).rectangle((20, 20, 44, 44), fill="black")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.2, y=0.2, width=0.6, height=0.6),
        operation="amplify",
        model="fixture",
        source_version_id="v",
        prompt="Add a black rectangular corner detail.",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    assert patch.getpixel((32, 32))[3] > 245


def test_amplify_removal_isolates_reconstructed_object_from_repainted_context() -> None:
    original = Image.new("RGB", (100, 100), "#507050")
    ImageDraw.Draw(original).rectangle((43, 35, 57, 65), fill="#e32636")
    candidate = Image.new("RGB", original.size, "#507050")
    ImageDraw.Draw(candidate).rectangle((20, 20, 79, 79), fill="#5c795c")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.2, y=0.2, width=0.6, height=0.6),
        operation="amplify",
        model="fixture",
        source_version_id="v",
        prompt="Remove the red object.",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")
    alpha = np.asarray(patch.getchannel("A"))

    assert patch.getpixel((50, 50))[3] > 245
    assert patch.getpixel((25, 25))[3] == 0
    assert np.mean(alpha[20:80, 20:80] > 0) < 0.55


def test_feather_falls_outside_removed_object_to_prevent_source_halo() -> None:
    original = Image.new("RGB", (100, 100), "#3c7850")
    candidate = original.copy()
    ImageDraw.Draw(original).ellipse((35, 35, 64, 64), fill="#d62828")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.25, y=0.25, width=0.5, height=0.5),
        operation="amplify",
        model="fixture",
        source_version_id="v",
        prompt="Remove the red object.",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")
    composited = Image.alpha_composite(original.convert("RGBA"), patch).convert("RGB")

    # The former object edge is solid donor content; the soft transition starts
    # in the surrounding green where source and candidate already agree.
    assert patch.getpixel((35, 50))[3] > 245
    assert np.linalg.norm(np.asarray(composited.getpixel((35, 50))) - np.asarray(candidate.getpixel((35, 50)))) < 4


def test_expand_uses_a_solid_target_layer_instead_of_a_noisy_diff() -> None:
    original = Image.new("RGB", (100, 60), "black")
    candidate = original.copy()
    draw = ImageDraw.Draw(candidate)
    draw.rectangle((80, 0, 99, 59), fill="#111111")
    draw.rectangle((90, 20, 99, 39), fill="#445566")

    result = extract_localized_patch(
        _png(original),
        _png(candidate),
        Region(x=0.8, y=0, width=0.2, height=1),
        operation="expand",
        model="fixture",
        source_version_id="v",
    )
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")

    # Even the dark pixels belong to the generated expansion. A pixel diff
    # would drop or feather them because they barely differ from the black
    # placeholder; an expansion layer must contain the full clean strip.
    assert result.target.x < 0.8
    assert patch.getpixel((71, 30))[3] == 0
    assert 0 < patch.getpixel((72, 30))[3] < 255
    assert patch.getpixel((79, 30))[3] == 255
    assert patch.getpixel((80, 0))[3] == 255
    assert patch.getpixel((80, 30))[3] == 255
    assert patch.getpixel((99, 59))[3] == 255
