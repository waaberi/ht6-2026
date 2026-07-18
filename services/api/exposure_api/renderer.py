from __future__ import annotations

import io
from typing import Any

import numpy as np
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps

from .models import LayerStack


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


def _composite_asset(base: Image.Image, layer: dict[str, Any], assets: dict[str, bytes]) -> Image.Image:
    asset_id = layer.get("assetId") or layer.get("patchAssetId")
    if not asset_id or asset_id not in assets:
        return base
    overlay = Image.open(io.BytesIO(assets[asset_id])).convert("RGBA")
    transform = layer.get("transform")
    if transform:
        overlay = _apply_canvas_transform(overlay, transform).convert("RGBA")
    overlay = overlay.resize(base.size, Image.Resampling.LANCZOS)
    opacity = max(0, min(1, float(layer.get("opacity", 1))))
    alpha = overlay.getchannel("A").point(lambda value: round(value * opacity))
    mask_id = layer.get("maskAssetId")
    if mask_id and mask_id in assets:
        supplied = Image.open(io.BytesIO(assets[mask_id])).convert("L").resize(base.size, Image.Resampling.LANCZOS)
        alpha = Image.fromarray((np.asarray(alpha, dtype=np.float32) * np.asarray(supplied, dtype=np.float32) / 255).astype(np.uint8), "L")
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
    rotation = float(transform.get("rotationDegrees", 0))
    if rotation:
        result = result.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=False)
    crop = transform.get("crop")
    if crop:
        left = max(0, min(result.width - 1, round(float(crop.get("x", 0)) * result.width)))
        top = max(0, min(result.height - 1, round(float(crop.get("y", 0)) * result.height)))
        right = max(left + 1, min(result.width, round((float(crop.get("x", 0)) + float(crop.get("width", 1))) * result.width)))
        bottom = max(top + 1, min(result.height, round((float(crop.get("y", 0)) + float(crop.get("height", 1))) * result.height)))
        result = result.crop((left, top, right, bottom))
    expansion = transform.get("expansion")
    if expansion:
        result = ImageOps.expand(result, border=(int(expansion.get("left", 0)), int(expansion.get("top", 0)), int(expansion.get("right", 0)), int(expansion.get("bottom", 0))), fill="black")
    return result


def render_layer_stack(image_bytes: bytes, stack: LayerStack, assets: dict[str, bytes] | None = None) -> Image.Image:
    assets = assets or {}
    with Image.open(io.BytesIO(image_bytes)) as source:
        rendered = ImageOps.exif_transpose(source).convert("RGB")
    for layer in stack.layers:
        if not layer.get("enabled", True):
            continue
        layer_type = layer.get("type")
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
    return _apply_canvas_transform(rendered, stack.canvas_transform)


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
