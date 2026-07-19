from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from google import genai
from pydantic import ValidationError

from .models import (
    AnalysisResult,
    CoachRequest,
    CoachResponse,
    GenerativeLayerPlan,
    LibraryChatRequest,
    LibraryChatResponse,
    MetadataAdviceRequest,
    MetadataAdviceResponse,
    Region,
    SemanticAnalysis,
    SemanticIssue,
)


logger = logging.getLogger(__name__)


COACH_TOOL_GUIDANCE = {
    "adjust_global": (
        "a reversible whole-photo adjustment using absolute target slider values, never deltas, for only exposure, "
        "contrast, highlights, shadows, temperature, tint, saturation, vibrance, sharpening, denoise, grain, or "
        "vignette in the -1..1 range; omit sliders that should remain unchanged"
    ),
    "adjust_masked": "the same reversible adjustments, restricted to an explicit supplied target",
    "crop": "a normalized x, y, width, and height in canvasTransform.crop; preserve the apparent intent",
    "straighten": "canvasTransform.rotationDegrees grounded in a measured horizon or dominant structural line",
    "amplify": (
        "a localized generative edit inside an explicit target, with a precise prompt that may add, remove, replace, "
        "or restyle visible content"
    ),
    "expand": (
        "an outpaint of exactly one canvas edge selected by one positive side in canvasTransform.expansion, plus an "
        "expansionFraction from 0.1 to 0.5 describing how much of the current canvas dimension to add"
    ),
    "retake": "a new-capture recommendation paired with specific captureAdvice; it never claims to change this file",
}


class GeminiImageError(RuntimeError):
    pass


class GeminiImageQuotaError(GeminiImageError):
    pass


class GeminiImageTimeoutError(GeminiImageError):
    pass


@dataclass(frozen=True)
class SemanticProviderResult:
    analysis: SemanticAnalysis
    model: str


T = TypeVar("T")


def _configured_model_chain(primary: str, fallbacks: str) -> tuple[str, ...]:
    models: list[str] = []
    for candidate in (primary, *fallbacks.split(",")):
        model = candidate.strip()
        if model and model not in models:
            models.append(model)
    return tuple(models)


def _error_status(error: Exception) -> int | None:
    candidates = [
        getattr(error, "status_code", None),
        getattr(error, "code", None),
        getattr(getattr(error, "response", None), "status_code", None),
    ]
    for candidate in candidates:
        if isinstance(candidate, int):
            return candidate
        text = str(candidate or "").upper()
        match = re.search(r"\b(400|404|408|429|504)\b", text)
        if match:
            return int(match.group(1))
        if "INVALID_ARGUMENT" in text:
            return 400
        if "NOT_FOUND" in text:
            return 404
        if "RESOURCE_EXHAUSTED" in text:
            return 429
    return None


def _can_try_fallback_model(error: Exception) -> bool:
    status = _error_status(error)
    if status in {404, 429}:
        return True
    message = str(error).lower()
    quota_markers = (
        "quota exceeded",
        "rate limit",
        "too many requests",
        "resource exhausted",
        "resource_exhausted",
    )
    model_markers = (
        "model not found",
        "model is not found",
        "not found for api version",
        "model is not available",
        "model not available",
        "model is unavailable",
        "model is not supported",
        "not supported for",
        "unsupported model",
    )
    return any(marker in message for marker in (*quota_markers, *model_markers))


def _is_timeout_error(error: Exception) -> bool:
    if _error_status(error) in {408, 504}:
        return True
    name = type(error).__name__.lower()
    message = str(error).lower()
    return "timeout" in name or "timed out" in message


_UNSUPPORTED_GEMINI_SCHEMA_KEYS = {
    "default",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxLength",
    "minLength",
}


def _gemini_json_schema(model: type[Any]) -> dict[str, Any]:
    """Reduce Pydantic JSON Schema to Gemini's documented supported subset."""
    schema = model.model_json_schema(by_alias=True)
    definitions = schema.get("$defs", {})

    def normalize(value: Any) -> Any:
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if not isinstance(value, dict):
            return value

        if "$ref" in value:
            reference = value["$ref"]
            prefix = "#/$defs/"
            if not isinstance(reference, str) or not reference.startswith(prefix):
                raise ValueError(f"Unsupported Gemini schema reference: {reference}")
            resolved = normalize(definitions[reference.removeprefix(prefix)])
            siblings = {key: item for key, item in value.items() if key != "$ref"}
            return {**resolved, **normalize(siblings)}

        if "anyOf" in value:
            branches = [normalize(branch) for branch in value["anyOf"]]
            parent = {
                key: normalize(item)
                for key, item in value.items()
                if key not in {"anyOf", *_UNSUPPORTED_GEMINI_SCHEMA_KEYS}
            }
            null_branch = {"type": "null"}
            non_null = [branch for branch in branches if branch != null_branch]
            if len(branches) == 2 and len(non_null) == 1 and isinstance(non_null[0].get("type"), str):
                return {**non_null[0], **parent, "type": [non_null[0]["type"], "null"]}
            if all(set(branch) == {"type"} and isinstance(branch["type"], str) for branch in branches):
                return {**parent, "type": [branch["type"] for branch in branches]}
            raise ValueError("Gemini schema contains an unsupported union")

        return {
            key: normalize(item)
            for key, item in value.items()
            if key not in {"$defs", *_UNSUPPORTED_GEMINI_SCHEMA_KEYS}
        }

    normalized = normalize(schema)
    if not isinstance(normalized, dict):
        raise ValueError("Gemini response schema must be an object")
    return normalized


def _parse_semantic_analysis(output_text: str) -> SemanticAnalysis:
    """Keep a malformed optional Gemini issue from discarding the full analysis."""
    payload = json.loads(output_text)
    if not isinstance(payload, dict) or not isinstance(payload.get("issues"), list):
        return SemanticAnalysis.model_validate(payload)

    valid_issues: list[SemanticIssue] = []
    for issue in payload["issues"]:
        try:
            valid_issues.append(SemanticIssue.model_validate(issue))
        except ValidationError:
            logger.warning("Discarding a malformed Gemini semantic issue", exc_info=True)
    return SemanticAnalysis.model_validate({**payload, "issues": valid_issues})


def _coach_prompt(request: CoachRequest, available_tools: list[str]) -> str:
    selected_issue = next(
        (issue for issue in request.analysis.issues if issue.id == request.selected_issue_id),
        None,
    )
    tool_contract = "\n".join(
        f"- {tool}: {COACH_TOOL_GUIDANCE[tool]}."
        for tool in available_tools
    )
    concise = request.preferences.detail != "detailed"
    headline_limit = 6 if concise else 8
    reason_limit = 16 if concise else 24
    action_reason_limit = 14 if concise else 20
    return (
        "ROLE\n"
        "You are Exposure Coach, a rigorous and concise photography assistant. Help the photographer make the "
        "smallest high-impact change that supports their apparent intent.\n\n"
        "EVIDENCE HIERARCHY\n"
        "1. Supplied deterministic measurements and camera recommendation evidence are facts. 2. Localized issues "
        "are evidence-backed diagnoses. 3. Semantic intent is an interpretation and must be described as such. "
        "Never invent EXIF, camera controls, subject distance, recoverable detail, or GPS. Do not repeat a correction "
        "that is already represented in the current layer stack.\n\n"
        "PHOTOGRAPHY REFERENCE — USE ONLY WHEN RELEVANT\n"
        "Consider only factors needed to answer the question and supported by supplied evidence. Reason about shutter "
        "speed, aperture, and ISO as linked exposure tradeoffs. Distinguish subject motion, "
        "camera shake, shallow depth of field, and missed focus instead of calling every soft area blur. Account for "
        "focal length, subject distance, perspective, stabilization, light direction and hardness, clipping and dynamic "
        "range, mixed white balance, subject hierarchy, edge tension, balance, negative space, leading lines, color "
        "harmony, and subject/background separation. Composition conventions are not rules. If detail is clipped or "
        "blurred beyond recovery, recommend a retake instead of fake recovery. If the evidence does not establish "
        "manual ISO, aperture, or shutter control, prefer truthful stability, lighting, or distance advice.\n\n"
        "TOOLS ENABLED BY THIS CLIENT\n"
        f"{tool_contract or '- None. Give advice only and return no actions.'}\n"
        "Do not return a tool that is not listed above.\n\n"
        "OUTPUT CONTRACT\n"
        "Answer the exact question with only image-specific guidance. Return the supplied JSON schema only. headline "
        f"states the priority in at most {headline_limit} words. reason explains why it matters for this image in at most {reason_limit} words. "
        "Normally include one decisive evidence item; include more only when the answer depends on them. captureAdvice "
        "must be empty unless capture choices directly answer the question; otherwise include at most three concrete "
        "choices, each with basedOn evidence paths and an explicit tradeoff for ISO, aperture, or shutter. "
        "actions normally contains zero or one reversible proposal; return two only when the user explicitly requests "
        f"distinct alternatives. Action labels use at most 6 words and reasons at most {action_reason_limit}. Every action must include one "
        "to four valid basedOn paths, and requiresConfirmation must be true. Never output a generic photography checklist, "
        "repeat the question, or restate evidence without a decision. Use amplify for any localized generative edit "
        "and include a self-contained prompt describing the intended visible result. "
        "adjust_global adjustments are absolute editor slider targets, not deltas; omitted sliders stay unchanged. "
        "expand must include expansionFraction from 0.1 to 0.5 as well as exactly one selected expansion edge. "
        "Target the selected issue when one is supplied. It is valid to return no action when the current image already "
        "supports the user's intent.\n\n"
        "FEEDBACK MEMORY\n"
        "recommendationFeedback IDs refer to issue IDs. Do not repeat a rejected issue unless the user explicitly "
        "asks about it or materially stronger supplied evidence now supports it. Treat accepted issue IDs as prior "
        "preferences, not as proof that the same correction is needed again.\n\n"
        f"Preferences: {request.preferences.model_dump_json(by_alias=True)}\n"
        f"Analysis: {request.analysis.model_dump_json(by_alias=True)}\n"
        f"Selected issue: {selected_issue.model_dump_json(by_alias=True) if selected_issue else 'none'}\n"
        f"Current layer stack: {request.layer_stack.model_dump_json(by_alias=True) if request.layer_stack else 'not supplied'}\n"
        f"Question: {json.dumps(request.question)}"
    )


def _known_evidence_paths(request: CoachRequest) -> set[str]:
    paths = {f"metrics.{key}" for key in request.analysis.metrics}
    paths.update({
        "lighting.exposure",
        "lighting.contrast",
        "lighting.clippedShadows",
        "lighting.clippedHighlights",
        "lighting.colorCast.red",
        "lighting.colorCast.green",
        "lighting.colorCast.blue",
    })
    for signal in request.analysis.signals:
        paths.add(f"signals.{signal.id}")
        paths.update(f"signals.{signal.id}.evidence.{key}" for key in signal.evidence)
    for index, issue in enumerate(request.analysis.issues):
        prefixes = (f"issues.{issue.id}", f"issues.{index}", f"issues[{index}]")
        for prefix in prefixes:
            paths.update({
                f"{prefix}.severity",
                f"{prefix}.confidence",
                f"{prefix}.location",
            })
            paths.update(f"{prefix}.evidence.{key}" for key in issue.evidence)
    for index, recommendation in enumerate(request.analysis.camera_recommendations):
        paths.update(recommendation.based_on)
        paths.update({
            f"cameraRecommendations.{index}.setting",
            f"cameraRecommendations.{index}.value",
            f"cameraRecommendations.{index}.basedOn",
        })
    return paths


def _metadata_advice_prompt(request: MetadataAdviceRequest) -> str:
    return (
        "You are Exposure's camera and lens specialist. Review how this photograph uses the supplied hardware. "
        "The metadata fields are user-confirmed but may be incomplete; the measured image analysis is factual. "
        "Use established product knowledge only. Never invent a feature, sensor, stabilization system, macro mode, "
        "minimum focus distance, weather sealing, weight, or optical trait. When a model name is ambiguous or a "
        "trait is uncertain, say so plainly instead of guessing. Do not produce marketing copy.\n\n"
        "Return JSON matching the schema with these sections:\n"
        "- cameraProfile: 25-50 words on the named camera's relevant strengths or specialization, such as portability, "
        "color rendering, low-light ability, autofocus, or macro support, only when genuinely associated with it.\n"
        "- lensBehavior: 25-50 words on how the named lens and supplied focal length/aperture behave, including useful "
        "optical strengths or tradeoffs relevant to this image.\n"
        "- settingsAssessment: 35-65 words explicitly assessing ISO, f-stop, shutter speed, and focal length. Tie them "
        "to measured brightness, clipping, noise, and detail. Name missing settings without inventing them.\n"
        "- hardwareUse: 25-50 words deciding whether this shot uses the body and lens well, followed by the single most "
        "useful capture change. Explain the exposure triangle tradeoff when recommending a setting change.\n"
        "- strength: zero or one restrained, specific compliment of at most 20 words. Leave it empty unless supported "
        "by the image measurements or the selected settings. Never flatter the photographer.\n\n"
        "Keep each section complete but concise. Do not suggest editor sliders, presets, or generated edits. "
        f"User-confirmed metadata: {request.metadata.model_dump_json(by_alias=True)}\n"
        f"Measured analysis: {request.analysis.model_dump_json(by_alias=True)}"
    )


def _library_chat_prompt(request: LibraryChatRequest) -> str:
    attachment_labels = [
        {"id": photo.id, "name": photo.name}
        for photo in request.library
        if photo.id in request.attached_photo_ids
    ]
    return (
        "You are Exposure Chat, a knowledgeable photography and camera-equipment assistant. Answer the user's exact "
        "question in one or two concise prose paragraphs, normally 70-180 words and never more than 220 words. Do not "
        "use headings, bullets, tables, or filler. The supplied conversation history exists only for this app session.\n\n"
        "LIBRARY GROUNDING\n"
        "Treat the GPS-free library metadata and saved analysis summaries as evidence. You may identify repeated cameras, "
        "lenses, focal lengths, settings, subjects, or visual tendencies when the supplied records support them. Only claim "
        "to see a photo when its id is listed under attached photos and an image input follows this prompt. Never invent "
        "missing EXIF, locations, image contents, ownership, or prior messages.\n\n"
        "EQUIPMENT GUIDANCE\n"
        "For lens recommendations, first establish the exact camera body and lens mount from supplied metadata. Recommend "
        "a specific lens only when compatibility is reliable; state the mount and connect focal length, aperture, size, or "
        "specialization to the user's demonstrated style. If the body name is absent or ambiguous, ask for the exact model "
        "instead of guessing. Do not invent specifications, prices, current stock, or newly released products. Distinguish "
        "native lenses from adapted lenses and mention an adapter only when relevant.\n\n"
        f"Conversation history: {json.dumps([item.model_dump(mode='json', by_alias=True) for item in request.history], separators=(',', ':'))}\n"
        f"Library records: {json.dumps([item.model_dump(mode='json', by_alias=True) for item in request.library], separators=(',', ':'), default=str)}\n"
        f"Attached photos: {json.dumps(attachment_labels, separators=(',', ':'))}\n"
        f"Current question: {json.dumps(request.question)}"
    )


def _normalize_library_chat_answer(answer: str) -> str:
    paragraphs = [" ".join(part.split()) for part in re.split(r"\n\s*\n", answer) if part.strip()]
    normalized = paragraphs[:2] or ["I couldn't produce a useful response. Please try asking again."]
    remaining = 220
    bounded: list[str] = []
    for paragraph in normalized:
        words = paragraph.split()
        if remaining <= 0:
            break
        if len(words) > remaining:
            paragraph = " ".join(words[:remaining]).rstrip(".,;:") + "..."
            words = paragraph.split()
        bounded.append(paragraph)
        remaining -= len(words)
    return "\n\n".join(bounded)


def _ground_coach_response(request: CoachRequest, response: CoachResponse) -> CoachResponse:
    allowed_tools = set(request.available_tools)
    known_paths = _known_evidence_paths(request)
    evidence = [item for item in response.evidence if item.path in known_paths]
    capture_advice = []
    for item in response.capture_advice:
        based_on = [path for path in item.based_on if path in known_paths]
        needs_tradeoff = item.setting in {"iso", "aperture", "shutter"}
        if based_on and (not needs_tradeoff or item.tradeoff):
            capture_advice.append(item.model_copy(update={"based_on": based_on}))
    actions = []
    for action in response.actions:
        based_on = [path for path in action.based_on if path in known_paths]
        if action.tool in allowed_tools and based_on:
            actions.append(action.model_copy(update={"based_on": based_on}))
    if not capture_advice:
        actions = [action for action in actions if action.tool != "retake"]
    return response.model_copy(update={
        "evidence": evidence[:4],
        "capture_advice": capture_advice[:3],
        "actions": actions[:2],
    })


class GeminiProvider:
    def __init__(self) -> None:
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.semantic_model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
        self.semantic_models = _configured_model_chain(
            self.semantic_model,
            os.getenv("GEMINI_FALLBACK_MODELS", ""),
        )
        configured_thinking = os.getenv("GEMINI_THINKING_LEVEL", "low").strip().lower()
        self.thinking_level = configured_thinking if configured_thinking in {"minimal", "low", "medium", "high"} else "low"
        self.image_model = os.getenv("NANO_BANANA_MODEL", "gemini-3.1-flash-image")
        self._client = genai.Client(api_key=self.api_key) if self.api_key else None

    @property
    def configured(self) -> bool:
        return self._client is not None

    def _request_with_text_model_fallback(self, request: Callable[[str], T]) -> tuple[T, str]:
        for index, model in enumerate(self.semantic_models):
            try:
                return request(model), model
            except Exception as error:
                is_last_model = index == len(self.semantic_models) - 1
                if is_last_model or not _can_try_fallback_model(error):
                    raise
        raise RuntimeError("Gemini text model chain is empty")

    async def analyze_semantics(
        self,
        image_bytes: bytes,
        mime_type: str,
        deterministic: AnalysisResult,
        exif: dict[str, Any],
        coaching: dict[str, str],
        request_timeout_seconds: float | None = None,
    ) -> SemanticProviderResult | None:
        if not self._client:
            return None
        signals = [signal.model_dump(mode="json", by_alias=True) for signal in deterministic.signals]
        evidence_references = [
            *(f"metrics.{key}" for key in deterministic.metrics),
            *(f"signals.{signal.id}" for signal in deterministic.signals),
        ]
        concise = coaching.get("detail") != "detailed"
        summary_limit = 12 if concise else 18
        title_limit = 4 if concise else 6
        explanation_limit = 16 if concise else 22
        action_limit = 8 if concise else 12
        prompt = (
            "You are Exposure, a rigorous photography editor. Convert measured signals into concise, image-specific "
            "judgments; the deterministic layer intentionally supplies no diagnosis copy. Assess a signal only by its "
            "exact signalId. Use support when the visible photograph confirms its contextual significance and reinterpret "
            "when the measurement is real but its photographic meaning differs. Omit irrelevant or intentional signals "
            "without explaining the omission. Every assessment must include the matching signals.<id> in basedOn. New "
            "issues must cite only supplied basedOn references; image-only observations still "
            "need one related measured reference. Unknown references are discarded. Do not contradict measurements, "
            "invent EXIF, infer GPS, apply generic rules, or duplicate a signal. Present only warranted findings, from "
            f"zero to three, ordered by impact. Summary: at most {summary_limit} words. Title: at most {title_limit} words. "
            f"Explanation: one sentence, at most {explanation_limit} words. Action: at most {action_limit} words. "
            "Do not restate the summary in a finding. Every statement must name evidence or visible context specific to this image. "
            "Bounding boxes use [ymin,xmin,ymax,xmax] on a 0..1000 scale. Return JSON matching the schema only.\n\n"
            f"Measurements: {json.dumps(deterministic.metrics, separators=(',', ':'))}\n"
            f"Measured signals: {json.dumps(signals, separators=(',', ':'))}\n"
            f"Valid basedOn references: {json.dumps(evidence_references, separators=(',', ':'))}\n"
            f"Local EXIF without GPS: {json.dumps(exif, separators=(',', ':'), default=str)}\n"
            f"User coaching preferences: {json.dumps(coaching, separators=(',', ':'))}"
        )

        def request_model(model: str) -> SemanticAnalysis:
            assert self._client is not None
            options = {"timeout": request_timeout_seconds} if request_timeout_seconds is not None else {}
            interaction = self._client.interactions.create(
                model=model,
                input=[
                    {"type": "text", "text": prompt},
                    {"type": "image", "data": base64.b64encode(image_bytes).decode(), "mime_type": mime_type},
                ],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(SemanticAnalysis),
                },
                generation_config={"thinking_level": self.thinking_level},
                **options,
            )
            return _parse_semantic_analysis(interaction.output_text)

        analysis, model = await asyncio.to_thread(self._request_with_text_model_fallback, request_model)
        return SemanticProviderResult(analysis=analysis, model=model)

    async def coach(
        self,
        request: CoachRequest,
        request_timeout_seconds: float | None = None,
    ) -> CoachResponse | None:
        if not self._client:
            return None
        available_tools = list(request.available_tools)
        prompt = _coach_prompt(request, available_tools)

        def request_model(model: str) -> CoachResponse:
            assert self._client is not None
            options = {"timeout": request_timeout_seconds} if request_timeout_seconds is not None else {}
            interaction = self._client.interactions.create(
                model=model,
                input=prompt,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(CoachResponse),
                },
                generation_config={"thinking_level": self.thinking_level},
                **options,
            )
            return CoachResponse.model_validate_json(interaction.output_text)

        result, model = await asyncio.to_thread(self._request_with_text_model_fallback, request_model)
        return _ground_coach_response(request, result).model_copy(update={"model": model})

    async def metadata_advice(
        self,
        request: MetadataAdviceRequest,
        request_timeout_seconds: float | None = None,
    ) -> MetadataAdviceResponse | None:
        if not self._client:
            return None
        prompt = _metadata_advice_prompt(request)

        def request_model(model: str) -> MetadataAdviceResponse:
            assert self._client is not None
            options = {"timeout": request_timeout_seconds} if request_timeout_seconds is not None else {}
            interaction = self._client.interactions.create(
                model=model,
                input=prompt,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(MetadataAdviceResponse),
                },
                generation_config={"thinking_level": self.thinking_level},
                **options,
            )
            return MetadataAdviceResponse.model_validate_json(interaction.output_text)

        result, model = await asyncio.to_thread(self._request_with_text_model_fallback, request_model)
        return result.model_copy(update={"model": model})

    async def library_chat(
        self,
        request: LibraryChatRequest,
        attached_images: list[tuple[str, str, bytes, str]],
        request_timeout_seconds: float | None = None,
    ) -> LibraryChatResponse | None:
        if not self._client:
            return None
        prompt = _library_chat_prompt(request)

        def request_model(model: str) -> LibraryChatResponse:
            assert self._client is not None
            options = {"timeout": request_timeout_seconds} if request_timeout_seconds is not None else {}
            input_content: list[dict[str, str]] = [{"type": "text", "text": prompt}]
            for photo_id, name, image_bytes, mime_type in attached_images:
                input_content.extend([
                    {"type": "text", "text": f"Attached library photo {photo_id}: {name}"},
                    {
                        "type": "image",
                        "data": base64.b64encode(image_bytes).decode(),
                        "mime_type": mime_type,
                    },
                ])
            interaction = self._client.interactions.create(
                model=model,
                input=input_content,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(LibraryChatResponse),
                },
                generation_config={"thinking_level": self.thinking_level},
                **options,
            )
            response = LibraryChatResponse.model_validate_json(interaction.output_text)
            return response.model_copy(update={"answer": _normalize_library_chat_answer(response.answer)})

        result, model = await asyncio.to_thread(self._request_with_text_model_fallback, request_model)
        return result.model_copy(update={"model": model})

    async def plan_generation(
        self,
        prompt: str,
        request_timeout_seconds: float | None = None,
    ) -> GenerativeLayerPlan:
        if not self._client:
            raise RuntimeError("GEMINI_API_KEY is required for generative layers")
        planning_prompt = (
            "Split this photo-edit request into the minimum number of independently controllable visual layers. "
            "Create separate layers when the user requests distinct subjects, regions, attributes, or objects, but "
            "keep changes together when they visually depend on each other. Each layer prompt must be a complete, "
            "imperative image-edit instruction that preserves all unrelated pixels. Do not add details the user did "
            "not request. Layer names must be concise and describe the visible result. For example, green beard, blue "
            "eyes, and red hair are three layers. Return one layer for one coherent edit and no more than six layers. "
            f"User request: {json.dumps(prompt)}"
        )

        def request_model(model: str) -> GenerativeLayerPlan:
            assert self._client is not None
            options = {"timeout": request_timeout_seconds} if request_timeout_seconds is not None else {}
            interaction = self._client.interactions.create(
                model=model,
                input=planning_prompt,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(GenerativeLayerPlan),
                },
                generation_config={"thinking_level": self.thinking_level},
                **options,
            )
            return GenerativeLayerPlan.model_validate_json(interaction.output_text)

        try:
            result, _model = await asyncio.to_thread(self._request_with_text_model_fallback, request_model)
            return result
        except Exception as error:
            if _is_timeout_error(error):
                raise GeminiImageTimeoutError("Gemini prompt planning timed out.") from error
            raise GeminiImageError("Gemini could not split the edit into layers.") from error

    async def generate_candidate(
        self,
        image_bytes: bytes,
        mime_type: str,
        prompt: str,
        target: Region,
        operation: str,
        request_timeout_seconds: float | None = None,
    ) -> bytes:
        if not self._client:
            raise RuntimeError("GEMINI_API_KEY is required for generative layers")
        target_description = (
            f"normalized rectangle x={target.x:.4f}, y={target.y:.4f}, "
            f"width={target.width:.4f}, height={target.height:.4f}"
        )
        operation_instruction = {
            "amplify": (
                "Apply only the requested visible change inside the target, whether it adds, removes, replaces, or "
                "restyles content. Match the scene's perspective, light, focus, and grain."
            ),
            "expand": "Fill the black target band by continuing the existing scene naturally across the new canvas edge.",
        }[operation]
        preservation_prompt = (
            f"Localized photo edit operation: {operation}. Target: {target_description}. {operation_instruction} "
            f"User request: {json.dumps(prompt)}. Preserve every pixel outside the target as closely as possible. "
            "Do not crop, resize, reframe, recolor, relight, sharpen, or replace the full image. Keep camera geometry, "
            "existing people, lighting, grain, focus, and color unchanged outside the edit."
        )

        def request() -> bytes:
            assert self._client is not None
            options = {"timeout": request_timeout_seconds} if request_timeout_seconds is not None else {}
            interaction = self._client.interactions.create(
                model=self.image_model,
                input=[
                    {"type": "text", "text": preservation_prompt},
                    {"type": "image", "data": base64.b64encode(image_bytes).decode(), "mime_type": mime_type},
                ],
                response_format={"type": "image", "mime_type": "image/jpeg"},
                **options,
            )
            data = interaction.output_image.data
            return base64.b64decode(data) if isinstance(data, str) else bytes(data)

        try:
            return await asyncio.to_thread(request)
        except Exception as error:
            message = str(error).lower()
            if _is_timeout_error(error):
                raise GeminiImageTimeoutError("Gemini image generation timed out.") from error
            if _error_status(error) == 429 or "quota exceeded" in message or "rate limit" in message:
                raise GeminiImageQuotaError(
                    "The configured Gemini project has no available image-generation quota."
                ) from error
            raise GeminiImageError("Gemini image generation failed.") from error
