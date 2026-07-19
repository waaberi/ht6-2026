from __future__ import annotations

import io
import math
from typing import Any

import numpy as np
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps

from .models import LayerStack

_EXPANSION_SIDES = ("top", "right", "bottom", "left")


def resolve_canvas_expansion(
    expansion: dict[str, Any] | None,
    content_size: tuple[int, int],
) -> dict[str, int]:
    """Scale referenced insets to this render; preserve raw legacy pixels."""
    source = expansion or {}
    try:
        reference_width = float(source.get("referenceWidth", 0))
        reference_height = float(source.get("referenceHeight", 0))
    except (TypeError, ValueError):
        reference_width = reference_height = 0
    has_reference = (
        math.isfinite(reference_width)
        and math.isfinite(reference_height)
        and reference_width > 0
        and reference_height > 0
    )
    horizontal_scale = content_size[0] / reference_width if has_reference else 1
    vertical_scale = content_size[1] / reference_height if has_reference else 1
    resolved: dict[str, int] = {}
    for side in _EXPANSION_SIDES:
        try:
            value = max(0, float(source.get(side, 0)))
        except (TypeError, ValueError):
            value = 0
        if has_reference:
            value *= vertical_scale if side in {"top", "bottom"} else horizontal_scale
            resolved[side] = max(0, round(value))
        else:
            resolved[side] = max(0, int(value))
    return resolved


def canvas_content_size(image_bytes: bytes, transform: dict[str, Any]) -> tuple[int, int]:
    """Post-perspective/rotation/crop size before generative expansion."""
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    without_expansion = {key: value for key, value in transform.items() if key != "expansion"}
    return _apply_canvas_transform(image, without_expansion).size


def _adjust(image: Image.Image, values: dict[str, Any]) -> Image.Image:
    result = image.convert("RGB")
    exposure = float(values.get("exposure", 0))
    contrast = float(values.get("contrast", 0))
    saturation = float(values.get("saturation", 0))
    if exposure:
        result = ImageEnhance.Brightness(result).enhance(2**exposure)
    if contrast:
        result = ImageEnhance.Contrast(result).enhance(max(0, 1 + contrast))
    if saturation:
        result = ImageEnhance.Color(result).enhance(max(0, 1 + saturation))
    array = np.asarray(result, dtype=np.float32)
    vibrance = float(values.get("vibrance", 0))
    if vibrance:
        maximum = np.max(array, axis=2, keepdims=True)
        minimum = np.min(array, axis=2, keepdims=True)
        chroma = (maximum - minimum) / 255
        gray = np.sum(array * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), axis=2, keepdims=True)
        array = gray + (array - gray) * np.clip(1 + vibrance * (1 - chroma), 0, 2.5)
    shadows = float(values.get("shadows", 0))
    highlights = float(values.get("highlights", 0))
    if shadows:
        shadow_weight = np.clip(1 - array / 128, 0, 1)[..., None] if array.ndim == 2 else np.clip(1 - array / 128, 0, 1)
        array += 70 * shadows * shadow_weight
    if highlights:
        highlight_weight = np.clip((array - 128) / 127, 0, 1)
        array += 70 * highlights * highlight_weight
    temperature = float(values.get("temperature", 0))
    tint = float(values.get("tint", 0))
    if temperature or tint:
        array[..., 0] += temperature * 28
        array[..., 2] -= temperature * 28
        array[..., 1] += tint * 22
    vignette = float(values.get("vignette", 0))
    if vignette:
        height, width = array.shape[:2]
        yy, xx = np.indices((height, width), dtype=np.float32)
        radius = np.sqrt(((xx - (width - 1) / 2) / max(1, width / 2)) ** 2 + ((yy - (height - 1) / 2) / max(1, height / 2)) ** 2)
        falloff = np.clip((radius - 0.28) / 0.72, 0, 1)[..., None]
        array *= np.clip(1 - vignette * 0.72 * falloff**1.6, 0.2, 1.8)
    grain = float(values.get("grain", 0))
    if grain:
        height, width = array.shape[:2]
        yy, xx = np.indices((height, width), dtype=np.float32)
        deterministic_noise = np.mod(np.sin(xx * 12.9898 + yy * 78.233) * 43758.5453, 1) - 0.5
        array += deterministic_noise[..., None] * grain * 42
    result = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8), "RGB")
    sharpening = float(values.get("sharpening", 0))
    if sharpening > 0:
        result = ImageEnhance.Sharpness(result).enhance(1 + sharpening * 3)
    denoise = float(values.get("denoise", 0))
    if denoise > 0:
        result = result.filter(ImageFilter.GaussianBlur(min(2, denoise * 1.5)))
    return result


def _mask_for(layer: dict[str, Any], size: tuple[int, int], assets: dict[str, bytes]) -> Image.Image:
    mask_data = layer.get("mask", {})
    asset_id = mask_data.get("assetId") or layer.get("maskAssetId")
    if asset_id and asset_id in assets:
        return Image.open(io.BytesIO(assets[asset_id])).convert("L").resize(size, Image.Resampling.LANCZOS)
    region = mask_data.get("region") or layer.get("target")
    mask = Image.new("L", size, 0)
    if region:
        x = round(float(region.get("x", 0)) * size[0])
        y = round(float(region.get("y", 0)) * size[1])
        width = round(float(region.get("width", 1)) * size[0])
        height = round(float(region.get("height", 1)) * size[1])
        from PIL import ImageDraw
        ImageDraw.Draw(mask).rectangle((x, y, x + width, y + height), fill=255)
        return mask.filter(ImageFilter.GaussianBlur(max(2, min(size) * 0.01)))
    return Image.new("L", size, 255)


def _overlay_alpha(
    overlay: Image.Image,
    layer: dict[str, Any],
    assets: dict[str, bytes],
    size: tuple[int, int],
) -> Image.Image:
    alpha = overlay.getchannel("A").resize(size, Image.Resampling.LANCZOS)
    mask_id = layer.get("maskAssetId")
    if mask_id and mask_id in assets:
        supplied = Image.open(io.BytesIO(assets[mask_id])).convert("L").resize(size, Image.Resampling.LANCZOS)
        if layer.get("type") == "generative-patch":
            # Generative extraction embeds this same mask in patch alpha for
            # immediate local preview and stores it separately for authoritative
            # rendering. The stored mask replaces, rather than multiplies, the
            # embedded copy so feathered edges are applied exactly once.
            alpha = supplied
        else:
            alpha = Image.fromarray(
                (np.asarray(alpha, dtype=np.float32) * np.asarray(supplied, dtype=np.float32) / 255).astype(np.uint8),
                "L",
            )
    opacity = max(0, min(1, float(layer.get("opacity", 1))))
    return alpha.point(lambda value: round(value * opacity))


def _composite_asset(base: Image.Image, layer: dict[str, Any], assets: dict[str, bytes]) -> Image.Image:
    asset_id = layer.get("assetId") or layer.get("patchAssetId")
    if not asset_id or asset_id not in assets:
        return base
    overlay = Image.open(io.BytesIO(assets[asset_id])).convert("RGBA")
    transform = layer.get("transform")
    if transform:
        overlay = _apply_canvas_transform(overlay, transform).convert("RGBA")
    overlay = overlay.resize(base.size, Image.Resampling.LANCZOS)
    alpha = _overlay_alpha(overlay, layer, assets, base.size)
    overlay.putalpha(alpha)
    base_rgb = base.convert("RGB")
    overlay_rgb = overlay.convert("RGB")
    blend_mode = layer.get("blendMode", "normal")
    if blend_mode == "multiply":
        blended = ImageChops.multiply(base_rgb, overlay_rgb)
    elif blend_mode == "screen":
        blended = ImageChops.screen(base_rgb, overlay_rgb)
    elif blend_mode == "overlay":
        blended = ImageChops.overlay(base_rgb, overlay_rgb)
    else:
        blended = overlay_rgb
    return Image.composite(blended, base_rgb, alpha)


def _composite_canvas_asset(
    base: Image.Image,
    layer: dict[str, Any],
    assets: dict[str, bytes],
    current_expansion: dict[str, Any],
    content_size: tuple[int, int],
) -> Image.Image:
    asset_id = layer.get("patchAssetId")
    if not asset_id or asset_id not in assets:
        return base
    overlay = Image.open(io.BytesIO(assets[asset_id])).convert("RGBA")
    current_pixels = resolve_canvas_expansion(current_expansion, content_size)
    snapshot = layer.get("canvasExpansion") or current_expansion
    snapshot_pixels = resolve_canvas_expansion(snapshot, content_size)
    snapshot_size = (
        content_size[0] + snapshot_pixels["left"] + snapshot_pixels["right"],
        content_size[1] + snapshot_pixels["top"] + snapshot_pixels["bottom"],
    )
    overlay = overlay.resize(snapshot_size, Image.Resampling.LANCZOS)
    alpha = _overlay_alpha(overlay, layer, assets, snapshot_size)
    overlay.putalpha(alpha)
    x = current_pixels["left"] - snapshot_pixels["left"]
    y = current_pixels["top"] - snapshot_pixels["top"]
    canvas = Image.new("RGBA", base.size, (0, 0, 0, 0))
    canvas.alpha_composite(overlay, (x, y))
    return Image.alpha_composite(base.convert("RGBA"), canvas).convert("RGB")


def _quarter_turns_for_rotation(rotation: float) -> int:
    turns = rotation / 90
    nearest = math.floor(turns + 0.5)
    if abs(abs(turns - nearest) - 0.5) < 1e-9:
        return math.trunc(turns)
    return nearest


def _apply_rotation(image: Image.Image, rotation: float) -> Image.Image:
    result = image
    if rotation:
        quarter_turns = _quarter_turns_for_rotation(rotation)
        quarter_degrees = quarter_turns * 90
        straighten = rotation - quarter_degrees
        if quarter_turns % 4:
            result = result.rotate(-quarter_degrees, resample=Image.Resampling.BICUBIC, expand=True)
        if abs(straighten) > 0.001:
            width, height = result.size
            radians = np.deg2rad(abs(straighten))
            cosine, sine = abs(np.cos(radians)), abs(np.sin(radians))
            scale = max(
                (width * cosine + height * sine) / max(1, width),
                (width * sine + height * cosine) / max(1, height),
            )
            scaled_size = (max(width, round(width * scale)), max(height, round(height * scale)))
            enlarged = result.resize(scaled_size, Image.Resampling.LANCZOS)
            rotated = enlarged.rotate(-straighten, resample=Image.Resampling.BICUBIC, expand=False)
            left = max(0, (rotated.width - width) // 2)
            top = max(0, (rotated.height - height) // 2)
            result = rotated.crop((left, top, left + width, top + height))
    return result


def _apply_canvas_transform(image: Image.Image, transform: dict[str, Any]) -> Image.Image:
    result = image
    perspective = transform.get("perspective")
    if isinstance(perspective, list) and len(perspective) == 9 and perspective != [1, 0, 0, 0, 1, 0, 0, 0, 1]:
        matrix = np.asarray(perspective, dtype=np.float64).reshape(3, 3)
        try:
            inverse = np.linalg.inv(matrix)
            inverse /= inverse[2, 2]
            coefficients = tuple(inverse.reshape(-1)[:8])
            result = result.transform(result.size, Image.Transform.PERSPECTIVE, coefficients, resample=Image.Resampling.BICUBIC)
        except np.linalg.LinAlgError:
            pass
    result = _apply_rotation(result, float(transform.get("rotationDegrees", 0)))
    # Crop coordinates are normalized to the visible canvas after rotation and
    # before expansion. Keep this order in parity with the mobile preview.
    crop = transform.get("crop")
    if crop:
        left = max(0, min(result.width - 1, round(float(crop.get("x", 0)) * result.width)))
        top = max(0, min(result.height - 1, round(float(crop.get("y", 0)) * result.height)))
        right = max(left + 1, min(result.width, round((float(crop.get("x", 0)) + float(crop.get("width", 1))) * result.width)))
        bottom = max(top + 1, min(result.height, round((float(crop.get("y", 0)) + float(crop.get("height", 1))) * result.height)))
        result = result.crop((left, top, right, bottom))
    expansion = transform.get("expansion")
    if expansion:
        pixels = resolve_canvas_expansion(expansion, result.size)
        result = ImageOps.expand(
            result,
            border=(pixels["left"], pixels["top"], pixels["right"], pixels["bottom"]),
            fill="black",
        )
    return result


def render_layer_stack(image_bytes: bytes, stack: LayerStack, assets: dict[str, bytes] | None = None) -> Image.Image:
    assets = assets or {}
    with Image.open(io.BytesIO(image_bytes)) as source:
        rendered = ImageOps.exif_transpose(source).convert("RGB")
    canvas_applied = False
    current_expansion = stack.canvas_transform.get("expansion") or {}
    content_size = _apply_canvas_transform(
        rendered,
        {key: value for key, value in stack.canvas_transform.items() if key != "expansion"},
    ).size
    for layer in stack.layers:
        if not layer.get("enabled", True):
            continue
        layer_type = layer.get("type")
        if layer_type == "generative-patch" and layer.get("canvasSpace"):
            if not canvas_applied:
                rendered = _apply_canvas_transform(rendered, stack.canvas_transform)
                canvas_applied = True
            rendered = _composite_canvas_asset(rendered, layer, assets, current_expansion, content_size)
            continue
        opacity = max(0, min(1, float(layer.get("opacity", 1))))
        if layer_type in {"adjustment", "style"}:
            values = dict(layer.get("adjustments", {}))
            if layer_type == "style":
                strength = max(0, min(1, float(layer.get("strength", 1))))
                values = {key: float(value) * strength for key, value in values.items()}
            adjusted = _adjust(rendered, values)
            rendered = Image.blend(rendered, adjusted, opacity)
        elif layer_type == "masked-adjustment":
            adjusted = _adjust(rendered, layer.get("adjustments", {}))
            mask = _mask_for(layer, rendered.size, assets).point(lambda value: round(value * opacity))
            rendered = Image.composite(adjusted, rendered, mask)
        elif layer_type in {"image", "retouch", "generative-patch"}:
            rendered = _composite_asset(rendered, layer, assets)
    if not canvas_applied:
        rendered = _apply_canvas_transform(rendered, stack.canvas_transform)
    # Collective sliders are a photo-wide final composition stage, not an
    # ordered layer. Running them after transforms and every layer guarantees
    # that manual and Coach global targets also affect generated canvas pixels.
    if stack.adjustments:
        rendered = _adjust(rendered, stack.adjustments)
    return rendered


def render_generation_source(
    image_bytes: bytes,
    stack: LayerStack,
    assets: dict[str, bytes] | None = None,
) -> Image.Image:
    """Render the state that an appended generative patch will be composited into.

    Collective adjustments are a final composition stage. Excluding them from
    the generation source lets the accepted stack apply them once to both the
    original content and the newly generated pixels.
    """
    generation_stack = stack.model_copy(update={"adjustments": {}})
    return render_layer_stack(image_bytes, generation_stack, assets)


def export_exif(image_bytes: bytes, include_gps: bool = False) -> bytes | None:
    with Image.open(io.BytesIO(image_bytes)) as source:
        exif = source.getexif()
    if not exif:
        return None
    if not include_gps and 34853 in exif:
        del exif[34853]
    if 274 in exif:
        exif[274] = 1
    return exif.tobytes()


def encode_image(image: Image.Image, output_format: str = "jpeg", quality: int = 92, exif: bytes | None = None) -> tuple[bytes, str]:
    output = io.BytesIO()
    if output_format.lower() == "png":
        image.save(output, format="PNG", optimize=True)
        return output.getvalue(), "image/png"
    options: dict[str, Any] = {"quality": max(1, min(100, quality)), "optimize": True}
    if exif:
        options["exif"] = exif
    image.convert("RGB").save(output, format="JPEG", **options)
    return output.getvalue(), "image/jpeg"
