from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import Field

from .models import AnalysisResult, ApiModel


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CloudPhotoVersion(ApiModel):
    id: str = Field(min_length=1)
    parent_version_id: str | None = None
    restored_from_version_id: str | None = None
    label: str = Field(min_length=1)
    stack: dict[str, Any]
    analysis_proxy_path: str | None = None
    thumbnail_path: str | None = None
    created_at: str


class CloudLayerAsset(ApiModel):
    id: str = Field(min_length=1)
    kind: Literal["mask", "donor_patch", "imported_image", "generated_patch"]
    storage_path: str = Field(min_length=1)
    checksum: str = Field(min_length=1)
    mime_type: str = Field(min_length=1)


class CloudPhoto(ApiModel):
    id: str = Field(min_length=1)
    original_path: str = Field(min_length=1)
    original_name: str = Field(min_length=1)
    original_mime_type: str = Field(pattern=r"^image/")
    original_byte_size: int = Field(gt=0)
    original_checksum: str = Field(min_length=1)
    capture_source: Literal["camera", "library", "document", "usb"]
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    exif: dict[str, Any] = Field(default_factory=dict)
    current_version_id: str = Field(min_length=1)
    created_at: str
    versions: list[CloudPhotoVersion] = Field(min_length=1)
    layer_assets: list[CloudLayerAsset] = Field(default_factory=list)


class DeletedCloudPhoto(ApiModel):
    deleted: bool
    original_path: str | None = None
    layer_asset_paths: list[str] = Field(default_factory=list)


class AnalysisWrite(ApiModel):
    photo_id: str = Field(min_length=1)
    analysis: AnalysisResult


class CloudStyleProfile(ApiModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    reference_photo_ids: list[str] = Field(default_factory=list, max_length=8)
    palette: list[str] = Field(default_factory=list)
    adjustments: dict[str, float] = Field(default_factory=dict)
    mood: str
    model_versions: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=_now)
    updated_at: str = Field(default_factory=_now)


class CloudPreferences(ApiModel):
    skill_level: Literal["beginner", "enthusiast", "professional"] = "enthusiast"
    feedback_detail: Literal["concise", "detailed"] = "detailed"
    desired_mood: str = ""
    export_metadata: bool = True
    export_gps: bool = False
    recommendation_feedback: dict[str, list[str]] = Field(
        default_factory=lambda: {"accepted": [], "rejected": []},
    )
    camera_preferences: dict[str, Any] = Field(default_factory=dict)


class CloudPortfolioReview(ApiModel):
    selected_photo_ids: list[str] = Field(min_length=2, max_length=20)
    ordered_photo_ids: list[str]
    excluded_photo_ids: list[str] = Field(default_factory=list)
    duplicate_groups: list[list[str]] = Field(default_factory=list)
    explanations: dict[str, str] = Field(default_factory=dict)
    summary: str
    created_at: str = Field(default_factory=_now)
