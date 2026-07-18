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
    clipped_shadows = float(np.mean(gray <= 0.02))
    clipped_highlights = float(np.mean(gray >= 0.98))
    tonal_range = float(np.percentile(gray, 95) - np.percentile(gray, 5))
    mean_rgb = np.mean(rgb, axis=(0, 1))
    hash_image = image.convert("L").resize((16, 16), Image.Resampling.LANCZOS)
    values = np.asarray(hash_image)
    perceptual_hash = values > np.mean(values)
    detail_score = min(1, sharpness * 24)
    headroom_score = max(0, 1 - min(1, (clipped_shadows + clipped_highlights) * 4))
    tonal_score = min(1, tonal_range / 0.72)
    # Quality ranking deliberately avoids treating a centered exposure or high saturation as universally better.
    score = detail_score * 0.5 + headroom_score * 0.3 + tonal_score * 0.2
    return {
        "sharpness": sharpness,
        "contrast": contrast,
        "exposure": exposure,
        "clipped_shadows": clipped_shadows,
        "clipped_highlights": clipped_highlights,
        "tonal_range": tonal_range,
        "mean_rgb": mean_rgb,
        "hash": perceptual_hash,
        "score": score,
    }


def _visual_distance(left: dict[str, float | np.ndarray], right: dict[str, float | np.ndarray]) -> float:
    structural = float(np.mean(left["hash"] != right["hash"]))
    color = float(np.linalg.norm(left["mean_rgb"] - right["mean_rgb"]) / np.sqrt(3))
    luminance = abs(float(left["exposure"]) - float(right["exposure"]))
    return min(1, structural * 0.55 + color * 0.3 + luminance * 0.15)


def _quality_explanation(metric: dict[str, float | np.ndarray], duplicate_of: str | None = None) -> str:
    detail = float(metric["sharpness"])
    clipping = float(metric["clipped_shadows"]) + float(metric["clipped_highlights"])
    tonal_range = float(metric["tonal_range"])
    if detail >= 0.018:
        strength = "Strong edge detail"
    elif detail >= 0.007:
        strength = "Usable edge detail"
    else:
        strength = "Soft edge detail"
    if clipping > 0.12:
        tone = "with substantial clipped tones"
    elif tonal_range >= 0.62:
        tone = "with broad tonal separation"
    else:
        tone = "with controlled highlight and shadow headroom"
    duplicate = f" Near-duplicate of {duplicate_of}; that frame retains the stronger technical signal." if duplicate_of else ""
    return f"{strength} {tone}.{duplicate}"


def review_portfolio(images: list[bytes], photo_ids: list[str]) -> PortfolioReview:
    metrics = [_photo_metrics(data) for data in images]
    groups: list[set[int]] = []
    for left in range(len(images)):
        for right in range(left + 1, len(images)):
            distance = float(np.mean(metrics[left]["hash"] != metrics[right]["hash"]))
            color_distance = float(np.linalg.norm(metrics[left]["mean_rgb"] - metrics[right]["mean_rgb"]) / np.sqrt(3))
            if distance > 0.08 or color_distance > 0.22:
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
    duplicate_of: dict[int, str] = {}
    duplicate_groups: list[list[str]] = []
    for group in groups:
        ranked = sorted(group, key=lambda index: float(metrics[index]["score"]), reverse=True)
        excluded_indexes.update(ranked[1:])
        duplicate_of.update({index: photo_ids[ranked[0]] for index in ranked[1:]})
        duplicate_groups.append([photo_ids[index] for index in ranked])
    remaining = [index for index in range(len(images)) if index not in excluded_indexes]
    included: list[int] = []
    while remaining:
        if not included:
            selected = max(remaining, key=lambda index: float(metrics[index]["score"]))
        else:
            selected = max(
                remaining,
                key=lambda index: (
                    float(metrics[index]["score"]) * 0.72
                    + min(_visual_distance(metrics[index], metrics[prior]) for prior in included) * 0.28
                ),
            )
        included.append(selected)
        remaining.remove(selected)
    explanations = {
        photo_ids[index]: _quality_explanation(metrics[index], duplicate_of.get(index))
        for index in range(len(images))
    }
    return PortfolioReview(
        ordered_photo_ids=[photo_ids[index] for index in included],
        excluded_photo_ids=[photo_ids[index] for index in sorted(excluded_indexes)],
        duplicate_groups=duplicate_groups,
        explanations=explanations,
        summary=(
            f"Recommended {len(included)} of {len(images)} frames. Near-duplicates were reduced to their strongest "
            "technical representative, then the sequence was balanced for visual variety. Every original remains in Library."
        ),
    )


def create_style_profile(images: list[bytes]) -> StyleProfile:
    luminance_values: list[float] = []
    contrast_values: list[float] = []
    saturation_values: list[float] = []
    warmth_values: list[float] = []
    tint_values: list[float] = []
    shadow_values: list[float] = []
    highlight_values: list[float] = []
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
        tint_values.append(float(np.mean((rgb[..., 0] + rgb[..., 2]) / 2 - rgb[..., 1])))
        shadow_values.append(float(np.percentile(luminance, 10)))
        highlight_values.append(float(np.percentile(luminance, 90)))
        palette_source.paste(image.resize((64, 64), Image.Resampling.LANCZOS), (index * 64, 0))
    quantized = palette_source.quantize(colors=5, method=Image.Quantize.MEDIANCUT).convert("RGB")
    palette_array = np.asarray(quantized).reshape(-1, 3)
    colors, counts = np.unique(palette_array, axis=0, return_counts=True)
    palette = [f"#{red:02X}{green:02X}{blue:02X}" for red, green, blue in colors[np.argsort(counts)[::-1]][:5]]
    brightness = float(np.median(luminance_values))
    contrast = float(np.median(contrast_values))
    saturation = float(np.median(saturation_values))
    warmth = float(np.median(warmth_values))
    tint = float(np.median(tint_values))
    shadows = float(np.median(shadow_values))
    highlights = float(np.median(highlight_values))
    if saturation < 0.18:
        mood = "restrained and quiet"
    elif warmth > 0.06:
        mood = "warm and expressive"
    elif warmth < -0.05:
        mood = "cool and atmospheric"
    elif brightness < 0.38:
        mood = "dark and cinematic"
    elif brightness > 0.65:
        mood = "light and airy"
    else:
        mood = "clear and vivid"

    def bounded(value: float) -> float:
        return round(max(-1, min(1, value)), 3)

    return StyleProfile(
        id=str(uuid.uuid4()),
        name=f"{mood.title()} Look",
        adjustments={
            "exposure": bounded((brightness - 0.5) * 1.2),
            "contrast": bounded((contrast - 0.18) * 2),
            "highlights": bounded((highlights - 0.82) * 1.4),
            "shadows": bounded((shadows - 0.12) * 1.4),
            "saturation": bounded((saturation - 0.25) * 1.1),
            "temperature": bounded(warmth * 1.4),
            "tint": bounded(tint * 1.2),
        },
        palette=palette,
        mood=mood,
    )
