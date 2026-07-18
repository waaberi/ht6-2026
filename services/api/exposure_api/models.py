from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, serialize_by_alias=True)


class Region(ApiModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)
    polygon: list[dict[str, float]] | None = None
    polyline: list[dict[str, float]] | None = None
    mask_asset_id: str | None = None


class Fix(ApiModel):
    kind: Literal["adjustment", "masked-adjustment", "transform", "crop", "retouch", "generative", "retake"]
    adjustments: dict[str, float] | None = None
    canvas_transform: dict[str, Any] | None = None


class Issue(ApiModel):
    id: str
    category: Literal["composition", "focus", "color", "lighting", "distraction", "intent", "metadata"]
    title: str
    explanation: str
    evidence: dict[str, float | str | bool | None]
    severity: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    location: Region
    recommended_action: str
    fix: Fix | None = None


class LightingAnalysis(ApiModel):
    exposure: float
    contrast: float
    clipped_shadows: float = Field(ge=0, le=1)
    clipped_highlights: float = Field(ge=0, le=1)
    color_cast: dict[Literal["red", "green", "blue"], float]


class CameraRecommendation(ApiModel):
    setting: Literal["iso", "aperture", "shutter", "focal-length", "distance", "stability", "lighting"]
    value: str | None = None
    explanation: str
    based_on: list[str]


class AnalysisResult(ApiModel):
    version_id: str
    checksum: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    deterministic_model: str = "exposure-deterministic-1"
    semantic_model: str | None = None
    metrics: dict[str, float | str | bool | None]
    lighting: LightingAnalysis
    issues: list[Issue]
    camera_recommendations: list[CameraRecommendation]
    summary: str


class SemanticIssue(ApiModel):
    category: Literal["composition", "focus", "color", "lighting", "distraction", "intent"]
    title: str
    explanation: str
    severity: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    box_2d: list[int] = Field(min_length=4, max_length=4)
    recommended_action: str


class SemanticAnalysis(ApiModel):
    summary: str
    apparent_intent: str
    issues: list[SemanticIssue] = Field(default_factory=list, max_length=6)


class LayerStack(ApiModel):
    canvas_transform: dict[str, Any]
    layers: list[dict[str, Any]]


class CoachRequest(ApiModel):
    analysis: AnalysisResult
    question: str = Field(min_length=1, max_length=500)


class CoachResponse(ApiModel):
    answer: str
    model: str


class PortfolioReview(ApiModel):
    ordered_photo_ids: list[str]
    excluded_photo_ids: list[str]
    duplicate_groups: list[list[str]]
    explanations: dict[str, str]
    summary: str


class StyleProfile(ApiModel):
    id: str
    name: str
    adjustments: dict[str, float]
    palette: list[str]
    mood: str


class GenerativePatchResult(ApiModel):
    patch_base64: str
    mask_base64: str
    target: Region
    drift_score: float
    model: str
    source_version_id: str
