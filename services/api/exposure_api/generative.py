from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from .models import GenerativePatchResult, Region


class ExcessiveDriftError(ValueError):
    pass


def _box_mean(values: np.ndarray, radius: int = 3) -> np.ndarray:
    size = radius * 2 + 1
    padded = np.pad(values, radius, mode="reflect")
    integral = np.pad(padded, ((1, 0), (1, 0)), mode="constant").cumsum(axis=0).cumsum(axis=1)
    return (
        integral[size:, size:]
        - integral[:-size, size:]
        - integral[size:, :-size]
        + integral[:-size, :-size]
    ) / (size * size)


def _structural_similarity(reference: np.ndarray, candidate: np.ndarray) -> np.ndarray:
    reference = reference.astype(np.float32) / 255
    candidate = candidate.astype(np.float32) / 255
    mean_reference = _box_mean(reference)
    mean_candidate = _box_mean(candidate)
    variance_reference = np.maximum(0, _box_mean(reference**2) - mean_reference**2)
    variance_candidate = np.maximum(0, _box_mean(candidate**2) - mean_candidate**2)
    covariance = _box_mean(reference * candidate) - mean_reference * mean_candidate
    c1 = 0.01**2
    c2 = 0.03**2
    numerator = (2 * mean_reference * mean_candidate + c1) * (2 * covariance + c2)
    denominator = (mean_reference**2 + mean_candidate**2 + c1) * (variance_reference + variance_candidate + c2)
    return np.clip(numerator / np.maximum(denominator, 1e-8), -1, 1)


def extract_localized_patch(
    original_bytes: bytes,
    candidate_bytes: bytes,
    target: Region,
    *,
    model: str,
    source_version_id: str,
    maximum_outside_drift: float = 0.025,
) -> GenerativePatchResult:
    with Image.open(io.BytesIO(original_bytes)) as source:
        original = ImageOps.exif_transpose(source).convert("RGB")
    with Image.open(io.BytesIO(candidate_bytes)) as generated:
        candidate = ImageOps.exif_transpose(generated).convert("RGB").resize(original.size, Image.Resampling.LANCZOS)

    original_lab = np.asarray(original.convert("LAB"), dtype=np.float32)
    candidate_lab = np.asarray(candidate.convert("LAB"), dtype=np.float32)
    delta = np.linalg.norm(candidate_lab - original_lab, axis=2)
    ssim = _structural_similarity(original_lab[..., 0], candidate_lab[..., 0])
    changed = delta > 14
    height, width = changed.shape
    margin = 0.04
    x0 = max(0, round((target.x - margin) * width))
    y0 = max(0, round((target.y - margin) * height))
    x1 = min(width, round((target.x + target.width + margin) * width))
    y1 = min(height, round((target.y + target.height + margin) * height))
    allowed = np.zeros_like(changed)
    allowed[y0:y1, x0:x1] = True
    outside_drift = float(np.mean(changed & ~allowed))
    outside_ssim = float(np.mean(ssim[~allowed])) if np.any(~allowed) else 1.0
    # Ignore sub-perceptual numerical noise from local-window boundaries.
    structural_drift = max(0, 1 - outside_ssim - 0.001)
    if outside_drift > maximum_outside_drift or structural_drift > 0.08:
        raise ExcessiveDriftError(
            f"Generated candidate changed {outside_drift:.3%} of pixels outside the target "
            f"(outside SSIM {outside_ssim:.3f})"
        )

    localized = np.where(allowed, changed, False).astype(np.uint8) * 255
    mask = Image.fromarray(localized, "L").filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(3))
    rgba = candidate.convert("RGBA")
    rgba.putalpha(mask)
    patch_output = io.BytesIO()
    mask_output = io.BytesIO()
    rgba.save(patch_output, format="PNG", optimize=True)
    mask.save(mask_output, format="PNG", optimize=True)
    return GenerativePatchResult(
        patch_base64=base64.b64encode(patch_output.getvalue()).decode(),
        mask_base64=base64.b64encode(mask_output.getvalue()).decode(),
        target=target,
        drift_score=max(outside_drift, structural_drift),
        model=model,
        source_version_id=source_version_id,
    )
