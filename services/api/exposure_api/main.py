from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import ValidationError

from .analysis import analyze_deterministic, merge_semantic
from .curation import create_style_profile, review_portfolio
from .generative import ExcessiveDriftError, extract_localized_patch
from .models import (
    AnalysisResult,
    CoachRequest,
    CoachResponse,
    GenerativePatchResult,
    LayerStack,
    PortfolioReview,
    Region,
    StyleProfile,
)
from .providers import GeminiProvider
from .renderer import encode_image, export_exif, render_layer_stack

MAX_UPLOAD_BYTES = int(os.getenv("EXPOSURE_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"}
GPS_KEY = re.compile(r"gps|latitude|longitude|location", re.IGNORECASE)
SCHEMA_VERSION = "analysis-1"

app = FastAPI(title="Exposure API", version="0.1.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin for origin in os.getenv("EXPOSURE_ALLOWED_ORIGINS", "").split(",") if origin],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)
provider = GeminiProvider()
analysis_cache: dict[tuple[str, str, str, str], AnalysisResult] = {}


async def _read_image(upload: UploadFile) -> bytes:
    if upload.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(415, f"Unsupported image type: {upload.content_type}")
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise HTTPException(400, "Image is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image exceeds the upload limit")
    return data


async def _read_assets(assets: list[UploadFile], asset_ids_json: str) -> dict[str, bytes]:
    try:
        asset_ids = json.loads(asset_ids_json)
    except json.JSONDecodeError as error:
        raise HTTPException(422, "asset_ids_json must be valid JSON") from error
    if not isinstance(asset_ids, list) or len(asset_ids) != len(assets):
        raise HTTPException(422, "asset_ids_json must map one identifier to each asset")
    return {
        str(asset_id): await _read_image(upload)
        for asset_id, upload in zip(asset_ids, assets, strict=True)
    }


def _safe_exif(serialized: str) -> dict[str, object]:
    try:
        parsed = json.loads(serialized)
    except json.JSONDecodeError as error:
        raise HTTPException(422, "exif_json must be valid JSON") from error
    if not isinstance(parsed, dict):
        raise HTTPException(422, "exif_json must be an object")
    return {str(key): value for key, value in parsed.items() if not GPS_KEY.search(str(key))}


def _safe_coaching(serialized: str) -> dict[str, str]:
    try:
        parsed = json.loads(serialized)
    except json.JSONDecodeError as error:
        raise HTTPException(422, "coaching_json must be valid JSON") from error
    if not isinstance(parsed, dict):
        raise HTTPException(422, "coaching_json must be an object")
    allowed = {"detail", "skillLevel", "desiredMood"}
    return {str(key): str(value)[:120] for key, value in parsed.items() if key in allowed and value is not None}


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "Exposure",
        "geminiConfigured": provider.configured,
        "semanticModel": provider.semantic_model,
        "imageModel": provider.image_model,
    }


@app.post("/v1/analyze", response_model=AnalysisResult)
async def analyze(
    image: Annotated[UploadFile, File()],
    version_id: Annotated[str, Form(min_length=1)],
    checksum: Annotated[str, Form()] = "",
    exif_json: Annotated[str, Form()] = "{}",
    coaching_json: Annotated[str, Form()] = "{}",
) -> AnalysisResult:
    image_bytes = await _read_image(image)
    safe_exif = _safe_exif(exif_json)
    coaching = _safe_coaching(coaching_json)
    checksum = checksum or hashlib.sha256(image_bytes).hexdigest()
    coaching_fingerprint = hashlib.sha256(json.dumps(coaching, sort_keys=True).encode()).hexdigest()[:12]
    cache_key = (checksum, SCHEMA_VERSION, provider.semantic_model if provider.configured else "local", coaching_fingerprint)
    cached = analysis_cache.get(cache_key)
    if cached:
        return cached.model_copy(update={"version_id": version_id})
    deterministic = await asyncio.to_thread(
        analyze_deterministic,
        image_bytes,
        version_id=version_id,
        checksum=checksum,
        supplied_exif=safe_exif,
    )
    semantic = None
    if provider.configured:
        try:
            semantic = await provider.analyze_semantics(
                image_bytes,
                image.content_type or "image/jpeg",
                deterministic,
                safe_exif,
                coaching,
            )
        except Exception:
            # Deterministic results remain useful and truthful during provider outages.
            semantic = None
    result = merge_semantic(deterministic, semantic, provider.semantic_model if semantic else None)
    analysis_cache[cache_key] = result
    return result


@app.post("/v1/render")
async def render(
    image: Annotated[UploadFile, File()],
    layer_stack_json: Annotated[str, Form()],
    assets: Annotated[list[UploadFile], File()] = [],
    asset_ids_json: Annotated[str, Form()] = "[]",
    output_format: Annotated[str, Form(pattern="^(jpeg|png)$")] = "jpeg",
    include_metadata: Annotated[bool, Form()] = False,
    include_gps: Annotated[bool, Form()] = False,
) -> Response:
    image_bytes = await _read_image(image)
    try:
        stack = LayerStack.model_validate_json(layer_stack_json)
    except ValidationError as error:
        raise HTTPException(422, "Invalid layer stack or asset identifiers") from error
    asset_bytes = await _read_assets(assets, asset_ids_json)
    rendered = await asyncio.to_thread(render_layer_stack, image_bytes, stack, asset_bytes)
    exif = await asyncio.to_thread(export_exif, image_bytes, include_gps) if include_metadata and output_format == "jpeg" else None
    body, media_type = await asyncio.to_thread(encode_image, rendered, output_format, 92, exif)
    return Response(body, media_type=media_type, headers={"Cache-Control": "private, no-store"})


@app.post("/v1/layers/generative", response_model=GenerativePatchResult)
async def generative_layer(
    image: Annotated[UploadFile, File()],
    target_json: Annotated[str, Form()],
    prompt: Annotated[str, Form(min_length=1, max_length=800)],
    source_version_id: Annotated[str, Form(min_length=1)],
    layer_stack_json: Annotated[str, Form()] = '{"canvasTransform":{"rotationDegrees":0,"perspective":[1,0,0,0,1,0,0,0,1]},"layers":[]}',
    assets: Annotated[list[UploadFile], File()] = [],
    asset_ids_json: Annotated[str, Form()] = "[]",
) -> GenerativePatchResult:
    if not provider.configured:
        raise HTTPException(503, "GEMINI_API_KEY is required for Nano Banana generative layers")
    image_bytes = await _read_image(image)
    try:
        target = Region.model_validate_json(target_json)
        stack = LayerStack.model_validate_json(layer_stack_json)
    except ValidationError as error:
        raise HTTPException(422, "target_json and layer_stack_json must use Exposure contracts") from error
    asset_bytes = await _read_assets(assets, asset_ids_json)
    rendered = await asyncio.to_thread(render_layer_stack, image_bytes, stack, asset_bytes)
    rendered_bytes, _ = await asyncio.to_thread(encode_image, rendered, "png")
    candidate = await provider.generate_candidate(rendered_bytes, "image/png", prompt)
    try:
        return await asyncio.to_thread(
            extract_localized_patch,
            rendered_bytes,
            candidate,
            target,
            model=provider.image_model,
            source_version_id=source_version_id,
        )
    except ExcessiveDriftError as error:
        raise HTTPException(422, str(error)) from error


@app.post("/v1/portfolio-review", response_model=PortfolioReview)
async def portfolio_review(
    images: Annotated[list[UploadFile], File(min_length=2, max_length=20)],
    photo_ids_json: Annotated[str, Form()],
) -> PortfolioReview:
    try:
        photo_ids = json.loads(photo_ids_json)
    except json.JSONDecodeError as error:
        raise HTTPException(422, "photo_ids_json must be a JSON array") from error
    if not isinstance(photo_ids, list) or len(photo_ids) != len(images):
        raise HTTPException(422, "Supply one photo id per image")
    image_bytes = await asyncio.gather(*(_read_image(image) for image in images))
    return await asyncio.to_thread(review_portfolio, image_bytes, [str(value) for value in photo_ids])


@app.post("/v1/style-profile", response_model=StyleProfile)
async def style_profile(images: Annotated[list[UploadFile], File(min_length=3, max_length=8)]) -> StyleProfile:
    image_bytes = await asyncio.gather(*(_read_image(image) for image in images))
    return await asyncio.to_thread(create_style_profile, image_bytes)


@app.post("/v1/style-apply")
async def style_apply(
    image: Annotated[UploadFile, File()],
    style_json: Annotated[str, Form()],
    strength: Annotated[float, Form(ge=0, le=1)] = 1,
) -> Response:
    image_bytes = await _read_image(image)
    try:
        style = StyleProfile.model_validate_json(style_json)
    except ValidationError as error:
        raise HTTPException(422, "style_json must be an Exposure style profile") from error
    stack = LayerStack(
        canvas_transform={"rotationDegrees": 0, "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1]},
        layers=[{"type": "style", "enabled": True, "opacity": 1, "strength": strength, "adjustments": style.adjustments}],
    )
    rendered = await asyncio.to_thread(render_layer_stack, image_bytes, stack)
    body, media_type = await asyncio.to_thread(encode_image, rendered, "jpeg")
    return Response(body, media_type=media_type, headers={"Cache-Control": "private, no-store"})


@app.post("/v1/coach", response_model=CoachResponse)
async def coach(request: CoachRequest) -> CoachResponse:
    if provider.configured:
        try:
            response = await provider.coach(request.analysis, request.question)
            if response:
                return CoachResponse(answer=response[0], model=response[1])
        except Exception:
            pass
    if request.analysis.issues:
        issue = request.analysis.issues[0]
        answer = f"Start with {issue.title.lower()}. {issue.recommended_action} This is the highest-confidence change supported by the current measurements."
    else:
        answer = "No strong technical fault crossed the measured thresholds. Keep the original intent and make only small reversible changes."
    return CoachResponse(answer=answer, model="exposure-deterministic-coach-1")
