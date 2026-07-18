from __future__ import annotations

import io
import math
import uuid
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from .models import (
    AnalysisResult,
    CameraRecommendation,
    Fix,
    Issue,
    LightingAnalysis,
    Region,
    SemanticAnalysis,
)


FULL_FRAME = Region(x=0, y=0, width=1, height=1)


def _number(value: Any) -> float | None:
    try:
        if isinstance(value, (tuple, list)) and len(value) == 2:
            return float(value[0]) / float(value[1])
        if isinstance(value, str) and "/" in value:
            numerator, denominator = value.split("/", 1)
            return float(numerator) / float(denominator)
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _issue(
    category: str,
    title: str,
    explanation: str,
    evidence: dict[str, float | str | bool | None],
    severity: float,
    confidence: float,
    action: str,
    *,
    location: Region = FULL_FRAME,
    fix: Fix | None = None,
) -> Issue:
    return Issue(
        id=str(uuid.uuid4()),
        category=category,
        title=title,
        explanation=explanation,
        evidence=evidence,
        severity=max(0, min(1, severity)),
        confidence=max(0, min(1, confidence)),
        location=location,
        recommended_action=action,
        fix=fix,
    )


def _resize_for_analysis(image: Image.Image, max_dimension: int = 1000) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("RGB")
    if max(image.size) <= max_dimension:
        return image
    scale = max_dimension / max(image.size)
    return image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)


def _edge_metrics(gray: np.ndarray) -> tuple[float, float, np.ndarray, np.ndarray, np.ndarray]:
    center = gray[1:-1, 1:-1]
    laplacian = (
        gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:] - 4 * center
    )
    sharpness = float(np.var(laplacian))
    gx = np.diff(gray, axis=1, append=gray[:, -1:])
    gy = np.diff(gray, axis=0, append=gray[-1:, :])
    edges = np.hypot(gx, gy)
    smooth = edges < np.percentile(edges, 40)
    noise = float(np.std(laplacian[smooth[1:-1, 1:-1]])) if np.any(smooth[1:-1, 1:-1]) else 0.0
    return sharpness, noise, edges, gx, gy


def _dominant_line_angle(edges: np.ndarray, gx: np.ndarray, gy: np.ndarray) -> tuple[float, float]:
    threshold = np.percentile(edges, 88)
    selected = edges >= threshold
    if not np.any(selected):
        return 0.0, 0.0
    weights = edges[selected]
    ys, xs = np.nonzero(selected)
    total = max(float(weights.sum()), 1e-8)
    center_x = float(np.sum(xs * weights) / total)
    center_y = float(np.sum(ys * weights) / total)
    centered = np.column_stack((xs - center_x, ys - center_y))
    covariance = (centered * weights[:, None]).T @ centered / total
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    direction = eigenvectors[:, int(np.argmax(eigenvalues))]
    angle = float(np.degrees(np.arctan2(direction[1], direction[0])))
    angle = (angle + 90) % 180 - 90
    confidence = float((eigenvalues[-1] - eigenvalues[0]) / max(float(eigenvalues.sum()), 1e-8))
    return angle, confidence


def _region_around_pixel(x: int, y: int, width: int, height: int, extent: float = 0.2) -> Region:
    normalized_x = x / max(width, 1)
    normalized_y = y / max(height, 1)
    return Region(
        x=max(0, min(1 - extent, normalized_x - extent / 2)),
        y=max(0, min(1 - extent, normalized_y - extent / 2)),
        width=extent,
        height=extent,
    )


def _subject_region(edges: np.ndarray) -> Region:
    height, width = edges.shape
    threshold = np.percentile(edges, 82)
    weight = np.where(edges >= threshold, edges, 0)
    total = float(weight.sum())
    if total <= 1e-8:
        return Region(x=0.25, y=0.25, width=0.5, height=0.5)
    ys, xs = np.indices(edges.shape)
    center_x = float((xs * weight).sum() / total) / width
    center_y = float((ys * weight).sum() / total) / height
    return Region(
        x=max(0, min(0.7, center_x - 0.15)),
        y=max(0, min(0.7, center_y - 0.15)),
        width=0.3,
        height=0.3,
    )


def analyze_deterministic(
    image_bytes: bytes,
    *,
    version_id: str,
    checksum: str,
    supplied_exif: dict[str, Any] | None = None,
) -> AnalysisResult:
    with Image.open(io.BytesIO(image_bytes)) as opened:
        image = _resize_for_analysis(opened)
    rgb = np.asarray(image, dtype=np.float32) / 255.0
    luminance = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    mean_luminance = float(np.mean(luminance))
    contrast = float(np.std(luminance))
    p05, p50, p95 = (float(value) for value in np.percentile(luminance, [5, 50, 95]))
    clipped_shadows = float(np.mean(luminance <= 3 / 255))
    clipped_highlights = float(np.mean(luminance >= 252 / 255))
    channel_means = np.mean(rgb, axis=(0, 1))
    neutral = float(np.mean(channel_means))
    color_cast = channel_means - neutral
    sharpness, noise, edges, gx, gy = _edge_metrics(luminance)
    subject = _subject_region(edges)
    dominant_angle, line_confidence = _dominant_line_angle(edges, gx, gy)
    nearest_axis = 0 if abs(dominant_angle) <= 45 else (90 if dominant_angle > 0 else -90)
    line_tilt = dominant_angle - nearest_axis
    thirds_distance = min(
        math.hypot(subject.x + subject.width / 2 - tx, subject.y + subject.height / 2 - ty)
        for tx in (1 / 3, 2 / 3)
        for ty in (1 / 3, 2 / 3)
    )
    symmetry_half_width = max(1, image.width // 2)
    left_half = luminance[:, :symmetry_half_width]
    right_half = luminance[:, image.width - symmetry_half_width:]
    symmetry = float(np.mean(np.abs(left_half - np.fliplr(right_half))))
    edge_threshold = np.percentile(edges, 82)
    occupied_ratio = float(np.mean(edges >= edge_threshold))
    half_height = max(1, image.height // 2)
    half_width = max(1, image.width // 2)
    quadrant_means = np.array([
        np.mean(luminance[:half_height, :half_width]),
        np.mean(luminance[:half_height, half_width:]),
        np.mean(luminance[half_height:, :half_width]),
        np.mean(luminance[half_height:, half_width:]),
    ], dtype=np.float32)
    illumination_unevenness = float(np.max(quadrant_means) - np.min(quadrant_means))
    direction_names = ("upper left", "upper right", "lower left", "lower right")
    brightest_direction = direction_names[int(np.argmax(quadrant_means))]
    border = max(2, round(min(image.size) * 0.08))
    saliency = edges + np.abs(luminance - mean_luminance)
    border_mask = np.zeros_like(saliency, dtype=bool)
    border_mask[:border] = True
    border_mask[-border:] = True
    border_mask[:, :border] = True
    border_mask[:, -border:] = True
    border_peak = float(np.percentile(saliency[border_mask], 98))
    interior_peak = float(np.percentile(saliency[~border_mask], 98)) if np.any(~border_mask) else border_peak
    border_outlier_ratio = border_peak / max(interior_peak, 1e-6)

    metrics: dict[str, float | str | bool | None] = {
        "width": image.width,
        "height": image.height,
        "meanLuminance": round(mean_luminance, 5),
        "medianLuminance": round(p50, 5),
        "dynamicRangeP05P95": round(p95 - p05, 5),
        "contrastStd": round(contrast, 5),
        "sharpnessLaplacianVariance": round(sharpness, 7),
        "estimatedNoise": round(noise, 7),
        "thirdsDistance": round(thirds_distance, 5),
        "mirrorDifference": round(symmetry, 5),
        "dominantLineAngleDegrees": round(dominant_angle, 3),
        "lineOrientationConfidence": round(line_confidence, 5),
        "estimatedTiltDegrees": round(line_tilt, 3),
        "occupiedEdgeRatio": round(occupied_ratio, 5),
        "negativeSpaceRatio": round(1 - occupied_ratio, 5),
        "illuminationUnevenness": round(illumination_unevenness, 5),
        "brightestLightingDirection": brightest_direction,
        "borderOutlierRatio": round(border_outlier_ratio, 5),
    }
    issues: list[Issue] = []

    if mean_luminance < 0.28:
        severity = min(1, (0.34 - mean_luminance) / 0.28)
        issues.append(_issue("lighting", "Frame is underexposed", "Most tones sit below the useful midtone range.", {"meanLuminance": mean_luminance}, severity, 0.94, "Lift exposure while watching bright areas.", fix=Fix(kind="adjustment", adjustments={"exposure": min(0.8, 0.45 - mean_luminance)})))
    elif mean_luminance > 0.72:
        severity = min(1, (mean_luminance - 0.66) / 0.28)
        issues.append(_issue("lighting", "Frame is very bright", "The tonal center is high enough to reduce highlight detail.", {"meanLuminance": mean_luminance}, severity, 0.9, "Lower exposure before recovering highlights.", fix=Fix(kind="adjustment", adjustments={"exposure": max(-0.8, 0.55 - mean_luminance)})))

    if clipped_highlights > 0.012:
        issues.append(_issue("lighting", "Highlights are clipped", "Bright pixels have reached the file limit and may contain no recoverable detail.", {"clippedHighlights": clipped_highlights}, min(1, clipped_highlights * 8), 0.99, "Reduce exposure or highlights; reshoot if the clipped area is important.", fix=Fix(kind="adjustment", adjustments={"highlights": -min(0.75, clipped_highlights * 5)})))
    if clipped_shadows > 0.06:
        issues.append(_issue("lighting", "Shadows are blocked", "A meaningful part of the frame is at or near black.", {"clippedShadows": clipped_shadows}, min(1, clipped_shadows * 3), 0.98, "Open shadows selectively and check noise before committing.", fix=Fix(kind="adjustment", adjustments={"shadows": min(0.7, clipped_shadows * 3)})))
    if contrast < 0.12:
        issues.append(_issue("color", "Low tonal separation", "The luminance distribution is compressed, so adjacent forms may merge.", {"contrastStd": contrast}, min(1, (0.14 - contrast) * 5), 0.86, "Add a small contrast curve rather than crushing the endpoints.", fix=Fix(kind="adjustment", adjustments={"contrast": 0.12})))
    if sharpness < 0.0012:
        issues.append(_issue("focus", "Low edge sharpness", "High-frequency detail is weak across the analysis proxy; focus error or motion may be responsible.", {"laplacianVariance": sharpness}, min(1, (0.0015 - sharpness) * 500), 0.84, "Inspect the intended subject at 100%. If it is soft, stabilize and retake.", location=subject, fix=Fix(kind="retake")))
    if max(abs(float(value)) for value in color_cast) > 0.045:
        dominant = ("red", "green", "blue")[int(np.argmax(np.abs(color_cast)))]
        issues.append(_issue("color", "Visible color cast", f"The {dominant} channel departs from the channel average.", {"redCast": float(color_cast[0]), "greenCast": float(color_cast[1]), "blueCast": float(color_cast[2])}, min(1, max(abs(float(value)) for value in color_cast) * 5), 0.78, "Correct temperature and tint while protecting deliberate ambient color.", fix=Fix(kind="adjustment", adjustments={"temperature": float(-color_cast[0] + color_cast[2])})))
    if thirds_distance > 0.24 and symmetry > 0.09:
        issues.append(_issue("composition", "Subject lacks a clear anchor", "The strongest edge cluster is neither near a thirds intersection nor supported by strong symmetry.", {"thirdsDistance": thirds_distance, "mirrorDifference": symmetry}, min(1, thirds_distance), 0.63, "Try a reversible crop that gives the main subject a deliberate anchor.", location=subject, fix=Fix(kind="crop")))
    if abs(line_tilt) > 3.0 and line_confidence > 0.08:
        issues.append(_issue(
            "composition",
            "Strong lines appear tilted",
            "The dominant high-contrast line family is measurably offset from its nearest horizontal or vertical axis.",
            {"estimatedTiltDegrees": line_tilt, "lineOrientationConfidence": line_confidence},
            min(1, abs(line_tilt) / 15),
            min(0.9, 0.55 + line_confidence),
            "Straighten only if the tilt does not support the apparent intent.",
            fix=Fix(kind="transform", canvas_transform={"rotationDegrees": line_tilt}),
        ))
    if illumination_unevenness > 0.26:
        darkest_index = int(np.argmin(quadrant_means))
        dark_x = 0 if darkest_index % 2 == 0 else 0.5
        dark_y = 0 if darkest_index < 2 else 0.5
        issues.append(_issue(
            "lighting",
            "Illumination is uneven",
            "Large image quadrants differ enough in luminance to pull attention toward the brightest side.",
            {"illuminationUnevenness": illumination_unevenness, "brightestDirection": brightest_direction},
            min(1, illumination_unevenness),
            0.72,
            "Use fill or a masked exposure lift if the darker area contains the subject.",
            location=Region(x=dark_x, y=dark_y, width=0.5, height=0.5),
            fix=Fix(kind="masked-adjustment", adjustments={"exposure": min(0.35, illumination_unevenness * 0.7)}),
        ))
    if border_outlier_ratio > 1.65 and border_peak > 0.12:
        border_values = np.where(border_mask, saliency, -1)
        peak_y, peak_x = np.unravel_index(int(np.argmax(border_values)), border_values.shape)
        issues.append(_issue(
            "distraction",
            "Bright edge detail competes with the subject",
            "A saliency outlier touches the frame edge and may pull the eye out of the composition.",
            {"borderOutlierRatio": border_outlier_ratio},
            min(1, (border_outlier_ratio - 1) / 1.5),
            0.7,
            "Inspect the marked edge; crop it or use a localized retouch only if it is accidental.",
            location=_region_around_pixel(int(peak_x), int(peak_y), image.width, image.height),
            fix=Fix(kind="retouch"),
        ))

    exif = supplied_exif or {}
    recommendations: list[CameraRecommendation] = []
    iso = _number(exif.get("ISO") or exif.get("ISOSpeedRatings") or exif.get("PhotographicSensitivity"))
    aperture = _number(exif.get("FNumber"))
    shutter = _number(exif.get("ExposureTime"))
    focal_length = _number(exif.get("FocalLength") or exif.get("FocalLengthIn35mmFilm"))
    subject_distance = _number(exif.get("SubjectDistance"))
    for metric_name, value in (
        ("exifIso", iso),
        ("exifAperture", aperture),
        ("exifExposureTimeSeconds", shutter),
        ("exifFocalLengthMm", focal_length),
        ("exifSubjectDistanceMeters", subject_distance),
    ):
        if value is not None:
            metrics[metric_name] = round(value, 6)
    for metric_name, keys in (
        ("exifCamera", ("Model", "Camera", "Make")),
        ("exifLens", ("LensModel", "Lens")),
        ("exifCaptureTime", ("DateTimeOriginal", "DateTime")),
    ):
        value = next((exif.get(key) for key in keys if exif.get(key)), None)
        if value is not None:
            metrics[metric_name] = str(value)[:160]
    if sharpness < 0.0012:
        recommendations.append(CameraRecommendation(setting="stability", value="Brace or use a tripod", explanation="The proxy has weak edge definition. Stability is the first change that does not require an invented exposure value.", based_on=["sharpnessLaplacianVariance"]))
        if shutter is not None and focal_length is not None and focal_length > 0:
            denominator = max(30, round(focal_length * 2))
            if shutter > 1 / denominator:
                recommendations.append(CameraRecommendation(setting="shutter", value=f"1/{denominator} s or faster", explanation="The supplied shutter time is slow relative to the supplied focal length. Raising shutter speed may require more light, a wider aperture, or higher ISO.", based_on=["EXIF.ExposureTime", "EXIF.FocalLength", "sharpnessLaplacianVariance"]))
    if clipped_highlights > 0.012:
        recommendations.append(CameraRecommendation(setting="lighting", value="Reduce highlight intensity", explanation="Diffuse, move, or lower the brightest source before changing the scene's intent.", based_on=["clippedHighlights"]))
    if iso is not None and iso >= 1600 and noise > 0.012:
        recommendations.append(CameraRecommendation(setting="iso", value=f"Below ISO {int(iso)} if motion permits", explanation="The supplied EXIF reports high ISO and the image shows high-frequency noise. A slower shutter requires stabilization.", based_on=["EXIF.ISO", "estimatedNoise"]))

    if issues:
        ordered = sorted(issues, key=lambda item: item.severity * item.confidence, reverse=True)
        summary = f"The highest-impact finding is {ordered[0].title.lower()}. {len(issues)} evidence-backed item{'s' if len(issues) != 1 else ''} are localized below."
    else:
        summary = "No strong technical fault crossed the deterministic thresholds. Preserve the intent and use small, reversible changes."

    return AnalysisResult(
        version_id=version_id,
        checksum=checksum,
        metrics=metrics,
        lighting=LightingAnalysis(exposure=mean_luminance - 0.5, contrast=contrast, clipped_shadows=clipped_shadows, clipped_highlights=clipped_highlights, color_cast={"red": float(color_cast[0]), "green": float(color_cast[1]), "blue": float(color_cast[2])}),
        issues=sorted(issues, key=lambda item: item.severity * item.confidence, reverse=True),
        camera_recommendations=recommendations,
        summary=summary,
    )


def merge_semantic(result: AnalysisResult, semantic: SemanticAnalysis | None, model: str | None) -> AnalysisResult:
    if semantic is None:
        return result
    semantic_issues: list[Issue] = []
    for finding in semantic.issues:
        ymin, xmin, ymax, xmax = (max(0, min(1000, value)) for value in finding.box_2d)
        if ymax <= ymin or xmax <= xmin:
            continue
        semantic_issues.append(_issue(
            finding.category,
            finding.title,
            finding.explanation,
            {"source": "gemini", "apparentIntent": semantic.apparent_intent},
            finding.severity,
            finding.confidence,
            finding.recommended_action,
            location=Region(x=xmin / 1000, y=ymin / 1000, width=(xmax - xmin) / 1000, height=(ymax - ymin) / 1000),
        ))
    return result.model_copy(update={
        "semantic_model": model,
        "summary": semantic.summary,
        "issues": sorted([*result.issues, *semantic_issues], key=lambda item: item.severity * item.confidence, reverse=True),
    })
