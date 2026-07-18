from __future__ import annotations

import io
import uuid

import numpy as np
from PIL import Image, ImageOps

from .models import PortfolioReview, StyleProfile


def _open(image_bytes: bytes, size: int = 512) -> Image.Image:
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    image.thumbnail((size, size), Image.Resampling.LANCZOS)
    return image


def _photo_metrics(image_bytes: bytes) -> dict[str, float | np.ndarray]:
    image = _open(image_bytes)
    rgb = np.asarray(image, dtype=np.float32) / 255
    gray = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    gx = np.diff(gray, axis=1)
    gy = np.diff(gray, axis=0)
    sharpness = float(np.var(gx) + np.var(gy))
    contrast = float(np.std(gray))
    exposure = float(np.mean(gray))
    hash_image = image.convert("L").resize((16, 16), Image.Resampling.LANCZOS)
    values = np.asarray(hash_image)
    perceptual_hash = values > np.mean(values)
    score = min(1, sharpness * 18) * 0.42 + min(1, contrast * 4) * 0.33 + max(0, 1 - abs(exposure - 0.5) * 2) * 0.25
    return {"sharpness": sharpness, "contrast": contrast, "exposure": exposure, "hash": perceptual_hash, "score": score}


def review_portfolio(images: list[bytes], photo_ids: list[str]) -> PortfolioReview:
    metrics = [_photo_metrics(data) for data in images]
    groups: list[set[int]] = []
    for left in range(len(images)):
        for right in range(left + 1, len(images)):
            distance = float(np.mean(metrics[left]["hash"] != metrics[right]["hash"]))
            if distance > 0.08:
                continue
            matches = [group for group in groups if left in group or right in group]
            if not matches:
                groups.append({left, right})
            else:
                merged = {left, right}
                for group in matches:
                    merged.update(group)
                    groups.remove(group)
                groups.append(merged)

    excluded_indexes: set[int] = set()
    duplicate_groups: list[list[str]] = []
    for group in groups:
        ranked = sorted(group, key=lambda index: float(metrics[index]["score"]), reverse=True)
        excluded_indexes.update(ranked[1:])
        duplicate_groups.append([photo_ids[index] for index in ranked])
    included = [index for index in range(len(images)) if index not in excluded_indexes]
    included.sort(key=lambda index: float(metrics[index]["score"]), reverse=True)
    explanations = {
        photo_ids[index]: (
            f"Sharpness {float(metrics[index]['sharpness']):.3f}, tonal separation "
            f"{float(metrics[index]['contrast']):.3f}, and luminance {float(metrics[index]['exposure']):.2f}."
        )
        for index in range(len(images))
    }
    return PortfolioReview(
        ordered_photo_ids=[photo_ids[index] for index in included],
        excluded_photo_ids=[photo_ids[index] for index in sorted(excluded_indexes)],
        duplicate_groups=duplicate_groups,
        explanations=explanations,
        summary=f"Recommended {len(included)} of {len(images)} frames. Near-duplicates were reduced to their strongest technical representative; every original remains in Library.",
    )


def create_style_profile(images: list[bytes]) -> StyleProfile:
    luminance_values: list[float] = []
    contrast_values: list[float] = []
    saturation_values: list[float] = []
    warmth_values: list[float] = []
    palette_source = Image.new("RGB", (64 * len(images), 64))
    for index, data in enumerate(images):
        image = _open(data, 384)
        rgb = np.asarray(image, dtype=np.float32) / 255
        maximum = rgb.max(axis=2)
        minimum = rgb.min(axis=2)
        luminance = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
        luminance_values.append(float(np.mean(luminance)))
        contrast_values.append(float(np.std(luminance)))
        saturation_values.append(float(np.mean((maximum - minimum) / np.maximum(maximum, 1e-5))))
        warmth_values.append(float(np.mean(rgb[..., 0] - rgb[..., 2])))
        palette_source.paste(image.resize((64, 64), Image.Resampling.LANCZOS), (index * 64, 0))
    quantized = palette_source.quantize(colors=5, method=Image.Quantize.MEDIANCUT).convert("RGB")
    palette_array = np.asarray(quantized).reshape(-1, 3)
    colors, counts = np.unique(palette_array, axis=0, return_counts=True)
    palette = [f"#{red:02X}{green:02X}{blue:02X}" for red, green, blue in colors[np.argsort(counts)[::-1]][:5]]
    brightness = float(np.mean(luminance_values))
    contrast = float(np.mean(contrast_values))
    saturation = float(np.mean(saturation_values))
    warmth = float(np.mean(warmth_values))
    if saturation < 0.18:
        mood = "restrained and quiet"
    elif warmth > 0.06:
        mood = "warm and expressive"
    elif brightness < 0.38:
        mood = "dark and cinematic"
    else:
        mood = "clear and vivid"
    return StyleProfile(
        id=str(uuid.uuid4()),
        name=f"{mood.title()} Look",
        adjustments={
            "exposure": round((brightness - 0.5) * 0.8, 3),
            "contrast": round((contrast - 0.18) * 1.8, 3),
            "saturation": round((saturation - 0.25) * 0.7, 3),
            "temperature": round(warmth * 0.8, 3),
            "grain": 0.04 if contrast < 0.16 else 0,
            "vignette": 0.06 if brightness < 0.45 else 0,
        },
        palette=palette,
        mood=mood,
    )
