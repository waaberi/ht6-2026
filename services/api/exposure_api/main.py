from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from collections import OrderedDict
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import ImageOps
from pydantic import ValidationError

from . import auth
from .analysis import analyze_deterministic, merge_semantic
from .auth import require_authenticated_user
from .curation import create_style_profile, review_portfolio
from .generative import ExcessiveDriftError, extract_localized_patch
from .models import (
    AnalysisResult,
    CanvasExpansion,
    CoachCaptureAdvice,
    CoachEvidence,
    CoachRequest,
    CoachResponse,
    GenerativePatchResult,
    LayerStack,
    MetadataAdviceRequest,
    MetadataAdviceResponse,
    PortfolioReview,
    Region,
    StyleProfile,
)
from .providers import (
    GeminiImageError,
    GeminiImageQuotaError,
    GeminiImageTimeoutError,
    GeminiProvider,
    SemanticProviderResult,
)
from .renderer import (
    canvas_content_size,
    encode_image,
    export_exif,
    render_generation_source,
    render_layer_stack,
    resolve_canvas_expansion,
)

MAX_UPLOAD_BYTES = int(os.getenv("EXPOSURE_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
SEMANTIC_TIMEOUT_SECONDS = max(5.0, min(40.0, float(os.getenv("EXPOSURE_SEMANTIC_TIMEOUT_SECONDS", "25"))))
COACH_TIMEOUT_SECONDS = max(5.0, min(60.0, float(os.getenv("EXPOSURE_COACH_TIMEOUT_SECONDS", "25"))))
IMAGE_TIMEOUT_SECONDS = max(10.0, min(180.0, float(os.getenv("EXPOSURE_IMAGE_TIMEOUT_SECONDS", "90"))))
ANALYSIS_CACHE_MAX_ENTRIES = max(1, int(os.getenv("EXPOSURE_ANALYSIS_CACHE_MAX_ENTRIES", "128")))
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"}
GPS_KEY = re.compile(r"gps|latitude|longitude|location", re.IGNORECASE)
SCHEMA_VERSION = "analysis-2"
logger = logging.getLogger(__name__)

app = FastAPI(title="Exposure API", version="0.1.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin for origin in os.getenv("EXPOSURE_ALLOWED_ORIGINS", "").split(",") if origin],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)
provider = GeminiProvider()
AnalysisCacheKey = tuple[str, str, str, str, str, str]
analysis_cache: OrderedDict[AnalysisCacheKey, AnalysisResult] = OrderedDict()


def _cached_analysis(key: AnalysisCacheKey) -> AnalysisResult | None:
    cached = analysis_cache.get(key)
    if cached is not None:
        analysis_cache.move_to_end(key)
    return cached


def _store_analysis(key: AnalysisCacheKey, result: AnalysisResult) -> None:
    analysis_cache[key] = result
    analysis_cache.move_to_end(key)
    while len(analysis_cache) > ANALYSIS_CACHE_MAX_ENTRIES:
        analysis_cache.popitem(last=False)


def _semantic_cache_identity() -> str:
    models = getattr(provider, "semantic_models", (provider.semantic_model,))
    return "|".join(models)


def _canonical_fingerprint(value: object) -> str:
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _analysis_cache_scope(authenticated_user: dict[str, object] | None) -> str:
    if not authenticated_user:
        return "anonymous"
    user_id = authenticated_user.get("id")
    if not isinstance(user_id, str) or not user_id:
        return "anonymous"
    return f"user:{hashlib.sha256(user_id.encode('utf-8')).hexdigest()}"


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
        "semanticFallbackModels": list(getattr(provider, "semantic_models", (provider.semantic_model,))[1:]),
        "semanticThinkingLevel": getattr(provider, "thinking_level", "low"),
        "imageModel": provider.image_model,
        "authRequired": auth.AUTH_REQUIRED,
        "authConfigured": auth.auth_configured(),
    }


@app.post("/v1/analyze", response_model=AnalysisResult)
async def analyze(
    image: Annotated[UploadFile, File()],
    version_id: Annotated[str, Form(min_length=1)],
    authenticated_user: Annotated[dict[str, object] | None, Depends(require_authenticated_user)],
    checksum: Annotated[str, Form()] = "",
    exif_json: Annotated[str, Form()] = "{}",
    coaching_json: Annotated[str, Form()] = "{}",
    layer_stack_json: Annotated[str, Form()] = '{"canvasTransform":{"rotationDegrees":0,"perspective":[1,0,0,0,1,0,0,0,1]},"layers":[]}',
    assets: Annotated[list[UploadFile], File()] = [],
    asset_ids_json: Annotated[str, Form()] = "[]",
) -> AnalysisResult:
    image_bytes = await _read_image(image)
    safe_exif = _safe_exif(exif_json)
    coaching = _safe_coaching(coaching_json)
    try:
        stack = LayerStack.model_validate_json(layer_stack_json)
    except ValidationError as error:
        raise HTTPException(422, "layer_stack_json must use the Exposure layer contract") from error
    asset_bytes = await _read_assets(assets, asset_ids_json)
    transform = stack.canvas_transform
    identity_perspective = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    needs_render = bool(stack.adjustments) or bool(stack.layers) or bool(transform.get("crop")) or bool(transform.get("expansion")) or bool(transform.get("rotationDegrees", 0)) or transform.get("perspective") != identity_perspective
    analysis_mime_type = image.content_type or "image/jpeg"
    if needs_render:
        rendered = await asyncio.to_thread(render_layer_stack, image_bytes, stack, asset_bytes)
        image_bytes, analysis_mime_type = await asyncio.to_thread(encode_image, rendered, "png")
        checksum = hashlib.sha256(image_bytes).hexdigest()
    else:
        checksum = checksum or hashlib.sha256(image_bytes).hexdigest()
    cache_key = (
        checksum,
        SCHEMA_VERSION,
        _semantic_cache_identity() if provider.configured else "local",
        _canonical_fingerprint(coaching),
        _canonical_fingerprint(safe_exif),
        _analysis_cache_scope(authenticated_user),
    )
    cached = _cached_analysis(cache_key)
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
    semantic_model = None
    if provider.configured:
        try:
            semantic_response = await asyncio.wait_for(
                provider.analyze_semantics(
                    image_bytes,
                    analysis_mime_type,
                    deterministic,
                    safe_exif,
                    coaching,
                    request_timeout_seconds=SEMANTIC_TIMEOUT_SECONDS,
                ),
                timeout=SEMANTIC_TIMEOUT_SECONDS,
            )
            if isinstance(semantic_response, SemanticProviderResult):
                semantic = semantic_response.analysis
                semantic_model = semantic_response.model
            else:
                # Preserve compatibility with alternate providers implementing the original contract.
                semantic = semantic_response
                semantic_model = provider.semantic_model if semantic else None
        except TimeoutError:
            logger.warning("Gemini semantic analysis exceeded %.1f seconds; returning deterministic results", SEMANTIC_TIMEOUT_SECONDS)
        except Exception:
            # Deterministic results remain useful and truthful during provider outages.
            logger.exception("Gemini semantic analysis failed")
            semantic = None
    result = merge_semantic(deterministic, semantic, semantic_model)
    # A provider timeout/outage must not poison this photo's semantic cache.
    # Return the useful deterministic result now, but let the next request retry Gemini.
    if not provider.configured or semantic is not None:
        _store_analysis(cache_key, result)
    return result


@app.post("/v1/render", dependencies=[Depends(require_authenticated_user)])
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


@app.post("/v1/layers/generative", response_model=GenerativePatchResult, dependencies=[Depends(require_authenticated_user)])
async def generative_layer(
    image: Annotated[UploadFile, File()],
    target_json: Annotated[str, Form()],
    prompt: Annotated[str, Form(min_length=1, max_length=800)],
    source_version_id: Annotated[str, Form(min_length=1)],
    operation: Annotated[str, Form(pattern="^(remove|add|expand)$")] = "remove",
    expansion_json: Annotated[str, Form()] = "{}",
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
    rendered = await asyncio.to_thread(render_generation_source, image_bytes, stack, asset_bytes)
    cumulative_expansion: CanvasExpansion | None = None
    if operation == "expand":
        try:
            expansion_request = json.loads(expansion_json)
            direction = expansion_request["direction"]
            fraction = float(expansion_request.get("fraction", 0.25))
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            raise HTTPException(422, "expansion_json requires a direction and fraction") from error
        if direction not in {"top", "right", "bottom", "left"} or not 0.1 <= fraction <= 0.5:
            raise HTTPException(422, "Expand one edge by 10% to 50%")
        axis_size = rendered.height if direction in {"top", "bottom"} else rendered.width
        delta = max(1, round(axis_size * fraction))
        border = {
            "left": (delta, 0, 0, 0),
            "top": (0, delta, 0, 0),
            "right": (0, 0, delta, 0),
            "bottom": (0, 0, 0, delta),
        }[direction]
        rendered = ImageOps.expand(rendered, border=border, fill="black")
        target = Region(
            x=0 if direction == "left" else (rendered.width - delta) / rendered.width if direction == "right" else 0,
            y=0 if direction == "top" else (rendered.height - delta) / rendered.height if direction == "bottom" else 0,
            width=delta / rendered.width if direction in {"left", "right"} else 1,
            height=delta / rendered.height if direction in {"top", "bottom"} else 1,
        )
        reference_size = await asyncio.to_thread(canvas_content_size, image_bytes, stack.canvas_transform)
        existing = resolve_canvas_expansion(stack.canvas_transform.get("expansion"), reference_size)
        cumulative_expansion = CanvasExpansion(
            **{
                side: existing[side] + (delta if side == direction else 0)
                for side in ("top", "right", "bottom", "left")
            },
            reference_width=reference_size[0],
            reference_height=reference_size[1],
        )
    rendered_bytes, _ = await asyncio.to_thread(encode_image, rendered, "png")
    try:
        candidate = await asyncio.wait_for(
            provider.generate_candidate(
                rendered_bytes,
                "image/png",
                prompt,
                target,
                operation,
                request_timeout_seconds=IMAGE_TIMEOUT_SECONDS,
            ),
            timeout=IMAGE_TIMEOUT_SECONDS,
        )
    except (TimeoutError, GeminiImageTimeoutError) as error:
        logger.warning("Gemini image generation exceeded %.1f seconds", IMAGE_TIMEOUT_SECONDS)
        raise HTTPException(504, "Gemini image generation timed out.") from error
    except GeminiImageQuotaError as error:
        logger.warning("Gemini image generation is blocked by project quota")
        raise HTTPException(503, str(error)) from error
    except GeminiImageError as error:
        logger.exception("Gemini image generation failed")
        raise HTTPException(502, str(error)) from error
    try:
        result = await asyncio.to_thread(
            extract_localized_patch,
            rendered_bytes,
            candidate,
            target,
            model=provider.image_model,
            source_version_id=source_version_id,
        )
        return result.model_copy(update={"expansion": cumulative_expansion})
    except ExcessiveDriftError as error:
        raise HTTPException(422, str(error)) from error


@app.post("/v1/portfolio-review", response_model=PortfolioReview, dependencies=[Depends(require_authenticated_user)])
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


@app.post("/v1/style-profile", response_model=StyleProfile, dependencies=[Depends(require_authenticated_user)])
async def style_profile(images: Annotated[list[UploadFile], File(min_length=3, max_length=8)]) -> StyleProfile:
    image_bytes = await asyncio.gather(*(_read_image(image) for image in images))
    return await asyncio.to_thread(create_style_profile, image_bytes)


@app.post("/v1/style-apply", dependencies=[Depends(require_authenticated_user)])
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


@app.post("/v1/coach", response_model=CoachResponse, dependencies=[Depends(require_authenticated_user)])
async def coach(request: CoachRequest) -> CoachResponse:
    if provider.configured:
        try:
            response = await asyncio.wait_for(
                provider.coach(request, request_timeout_seconds=COACH_TIMEOUT_SECONDS),
                timeout=COACH_TIMEOUT_SECONDS,
            )
            if response:
                return response
        except TimeoutError:
            logger.warning("Gemini Coach exceeded %.1f seconds; returning the local response", COACH_TIMEOUT_SECONDS)
        except Exception:
            logger.exception("Gemini Coach request failed")
    selected_issue = next(
        (issue for issue in request.analysis.issues if issue.id == request.selected_issue_id),
        None,
    )
    if request.analysis.issues:
        issue = selected_issue or request.analysis.issues[0]
        evidence = [
            CoachEvidence(
                path=f"issues.{issue.id}.evidence.{key}",
                value=value,
                meaning=" ".join(issue.explanation.split()[:18]),
            )
            for key, value in list(issue.evidence.items())[:1]
        ]
        headline = " ".join(issue.title.split()[:8])
        reason = " ".join(issue.recommended_action.split()[:24])
    else:
        evidence = []
        headline = "Coach unavailable"
        reason = "Measurements remain available. Try again shortly."
    capture_advice = [
        CoachCaptureAdvice(
            setting=item.setting,
            value=item.value,
            tradeoff=item.explanation,
            based_on=item.based_on,
        )
        for item in request.analysis.camera_recommendations[:3]
    ]
    return CoachResponse(
        headline=headline,
        reason=reason,
        evidence=evidence,
        capture_advice=capture_advice,
        actions=[],
        model="exposure-fallback-coach-1",
    )


@app.post(
    "/v1/metadata-advice",
    response_model=MetadataAdviceResponse,
    dependencies=[Depends(require_authenticated_user)],
)
async def metadata_advice(request: MetadataAdviceRequest) -> MetadataAdviceResponse:
    if provider.configured:
        try:
            response = await asyncio.wait_for(
                provider.metadata_advice(request, request_timeout_seconds=COACH_TIMEOUT_SECONDS),
                timeout=COACH_TIMEOUT_SECONDS,
            )
            if response:
                return response
        except TimeoutError:
            logger.warning("Gemini metadata advice exceeded %.1f seconds; returning the local response", COACH_TIMEOUT_SECONDS)
        except Exception:
            logger.exception("Gemini metadata advice request failed")

    mean_luminance = request.analysis.metrics.get("meanLuminance")
    luminance = float(mean_luminance) if isinstance(mean_luminance, (int, float)) else 0.5
    exposure_state = "underexposed" if luminance < 0.42 else "overexposed" if luminance > 0.62 else "evenly exposed"
    metadata = request.metadata
    setting_summary = (
        f"ISO {metadata.iso or 'not supplied'}, aperture {metadata.aperture or 'not supplied'}, "
        f"shutter {metadata.shutter_speed or 'not supplied'}, and focal length {metadata.focal_length or 'not supplied'} "
        f"produced a measured luminance of {luminance:.2f}, which is {exposure_state}."
    )
    if exposure_state == "underexposed":
        setting_summary += " Raise ISO or slow the shutter; choose between added noise and greater motion-blur risk."
    elif exposure_state == "overexposed":
        setting_summary += " Lower ISO or use a faster shutter; preserve highlights while checking motion remains controlled."
    else:
        setting_summary += " The exposure triangle is already balanced, so change a setting only for motion or depth-of-field intent."
    return MetadataAdviceResponse(
        camera_profile=(
            f"{metadata.camera or 'The camera model'} is recorded, but model-specific strengths cannot be verified while the AI hardware review is unavailable."
        ),
        lens_behavior=(
            f"{metadata.lens or 'The lens model'} is recorded. Its optical behavior cannot be identified reliably without the AI hardware review."
        ),
        settings_assessment=setting_summary,
        hardware_use=(
            "The measured exposure provides a reliable baseline, but a model-specific judgment about whether this capture uses the body and lens optimally is temporarily unavailable."
        ),
        strength="The supplied settings give the review a useful, concrete starting point.",
        model="exposure-fallback-metadata-1",
    )
