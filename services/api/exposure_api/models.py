from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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

    @model_validator(mode="after")
    def validate_containment(self) -> "Region":
        if self.x + self.width > 1 + 1e-9 or self.y + self.height > 1 + 1e-9:
            raise ValueError("Region must remain inside normalized image bounds")
        return self


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
    adjustments: dict[str, float] = Field(default_factory=dict)
    layers: list[dict[str, Any]]


CoachTool = Literal[
    "adjust_global",
    "adjust_masked",
    "crop",
    "straighten",
    "remove",
    "add",
    "expand",
    "retake",
]
DEFAULT_COACH_TOOLS: tuple[CoachTool, ...] = (
    "adjust_global",
    "adjust_masked",
    "crop",
    "straighten",
    "remove",
    "add",
    "expand",
    "retake",
)


class CoachPreferences(ApiModel):
    detail: Literal["concise", "detailed"] = "concise"
    skill_level: Literal["beginner", "enthusiast", "professional"] = "enthusiast"
    desired_mood: str = Field(default="", max_length=120)
    recommendation_feedback: dict[Literal["accepted", "rejected"], list[str]] = Field(
        default_factory=lambda: {"accepted": [], "rejected": []},
    )


class CoachRequest(ApiModel):
    analysis: AnalysisResult
    question: str = Field(min_length=1, max_length=500)
    preferences: CoachPreferences = Field(default_factory=CoachPreferences)
    layer_stack: LayerStack | None = None
    selected_issue_id: str | None = None
    available_tools: list[CoachTool] = Field(default_factory=lambda: list(DEFAULT_COACH_TOOLS), max_length=8)


class CoachEvidence(ApiModel):
    path: str = Field(min_length=1, max_length=120)
    value: str | float | int | bool | None = None
    meaning: str = Field(min_length=1, max_length=180)


class CoachCaptureAdvice(ApiModel):
    setting: Literal["iso", "aperture", "shutter", "focal-length", "distance", "stability", "lighting"]
    value: str | None = Field(default=None, max_length=120)
    tradeoff: str | None = Field(default=None, max_length=180)
    based_on: list[str] = Field(default_factory=list, max_length=6)


class CoachAction(ApiModel):
    id: str = Field(min_length=1, max_length=80)
    tool: CoachTool
    label: str = Field(min_length=1, max_length=48)
    reason: str = Field(min_length=1, max_length=180)
    requires_confirmation: bool = True
    adjustments: dict[str, float] | None = Field(
        default=None,
        description=(
            "For adjust_global, absolute target values for the named editor sliders; omitted sliders remain unchanged. "
            "For adjust_masked, adjustment strengths applied inside the target."
        ),
    )
    target: Region | None = None
    prompt: str | None = Field(default=None, max_length=500)
    canvas_transform: dict[str, Any] | None = None
    expansion_fraction: float | None = Field(
        default=None,
        ge=0.1,
        le=0.5,
        description="For expand, the fraction of the current canvas dimension to add on the selected edge.",
    )

    @model_validator(mode="after")
    def validate_tool_contract(self) -> "CoachAction":
        adjustment_keys = {
            "exposure", "contrast", "highlights", "shadows", "temperature", "tint",
            "saturation", "vibrance", "sharpening", "denoise", "grain", "vignette",
        }
        if self.adjustments:
            if set(self.adjustments) - adjustment_keys:
                raise ValueError("Coach action contains an unsupported adjustment")
            if any(not math.isfinite(value) or value < -1 or value > 1 for value in self.adjustments.values()):
                raise ValueError("Coach adjustment values must be finite and stay within -1..1")
        if self.tool in {"adjust_global", "adjust_masked"} and not self.adjustments:
            raise ValueError("Adjustment tools require adjustments")
        if self.tool not in {"adjust_global", "adjust_masked"} and self.adjustments is not None:
            raise ValueError("adjustments are only valid for adjustment tools")
        if self.tool in {"adjust_masked", "remove", "add"} and self.target is None:
            raise ValueError(f"{self.tool} requires an explicit target")
        if self.tool not in {"adjust_masked", "remove", "add"} and self.target is not None:
            raise ValueError("target is only valid for masked, remove, or add tools")
        if self.tool == "add" and not self.prompt:
            raise ValueError("add requires a prompt describing the element")
        if self.tool not in {"remove", "add", "expand"} and self.prompt is not None:
            raise ValueError("prompt is only valid for remove, add, or expand")
        if self.tool == "crop":
            transform = self.canvas_transform or {}
            if set(transform) != {"crop"} or not isinstance(transform.get("crop"), dict):
                raise ValueError("crop requires only a contained normalized canvasTransform.crop")
            Region.model_validate(transform["crop"])
        elif self.tool == "straighten":
            transform = self.canvas_transform or {}
            degrees = transform.get("rotationDegrees")
            if set(transform) != {"rotationDegrees"} or not isinstance(degrees, (int, float)):
                raise ValueError("straighten requires only canvasTransform.rotationDegrees")
            if not math.isfinite(float(degrees)) or abs(float(degrees)) > 45:
                raise ValueError("straighten rotationDegrees must be finite and within -45..45")
        elif self.tool != "expand" and self.canvas_transform is not None:
            raise ValueError("canvasTransform is only valid for crop, straighten, or expand")
        if self.tool == "expand":
            transform = self.canvas_transform or {}
            expansion = transform.get("expansion")
            sides = ("top", "right", "bottom", "left")
            if (
                set(transform) != {"expansion"}
                or not isinstance(expansion, dict)
                or set(expansion) != set(sides)
                or any(not isinstance(expansion.get(side), (int, float)) for side in sides)
                or any(not math.isfinite(float(expansion[side])) or float(expansion[side]) < 0 for side in sides)
                or sum(float(expansion[side]) > 0 for side in sides) != 1
            ):
                raise ValueError("expand requires one positive canvas expansion side")
            if self.expansion_fraction is None:
                raise ValueError("expand requires expansionFraction between 0.1 and 0.5")
        elif self.expansion_fraction is not None:
            raise ValueError("expansionFraction is only valid for expand")
        if not self.requires_confirmation:
            raise ValueError("Coach actions must require confirmation")
        return self


class CoachResponse(ApiModel):
    headline: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=240)
    evidence: list[CoachEvidence] = Field(default_factory=list, max_length=4)
    capture_advice: list[CoachCaptureAdvice] = Field(default_factory=list, max_length=3)
    actions: list[CoachAction] = Field(default_factory=list, max_length=2)
    model: str = ""


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
    expansion: dict[Literal["top", "right", "bottom", "left"], int] | None = None
