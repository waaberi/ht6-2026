from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any

from google import genai

from .models import AnalysisResult, CoachRequest, CoachResponse, Region, SemanticAnalysis


COACH_TOOL_GUIDANCE = {
    "adjust_global": (
        "a reversible whole-photo adjustment using absolute target slider values, never deltas, for only exposure, "
        "contrast, highlights, shadows, temperature, tint, saturation, vibrance, sharpening, denoise, grain, or "
        "vignette in the -1..1 range; omit sliders that should remain unchanged"
    ),
    "adjust_masked": "the same reversible adjustments, restricted to an explicit supplied target",
    "crop": "a normalized x, y, width, and height in canvasTransform.crop; preserve the apparent intent",
    "straighten": "canvasTransform.rotationDegrees grounded in a measured horizon or dominant structural line",
    "remove": "a localized removal of an accidental distraction inside an explicit target",
    "add": "an intentional creative addition inside an explicit target, with a precise generation prompt",
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


def _coach_prompt(request: CoachRequest, available_tools: list[str]) -> str:
    selected_issue = next(
        (issue for issue in request.analysis.issues if issue.id == request.selected_issue_id),
        None,
    )
    tool_contract = "\n".join(
        f"- {tool}: {COACH_TOOL_GUIDANCE[tool]}."
        for tool in available_tools
    )
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
        "states the priority in at most 8 words. reason explains why it matters for this image in at most 24 words. "
        "Normally include one decisive evidence item; include more only when the answer depends on them. captureAdvice "
        "must be empty unless capture choices directly answer the question; otherwise include at most three concrete "
        "choices, each with basedOn evidence paths and an explicit tradeoff for ISO, aperture, or shutter. "
        "actions normally contains zero or one reversible proposal; return two only when the user explicitly requests "
        "distinct alternatives. Action labels use at most 6 words and reasons at most 20. Every action must include one "
        "to four valid basedOn paths, and requiresConfirmation must be true. Never output a generic photography checklist, "
        "repeat the question, or restate evidence without a decision. Use "
        "remove only for a demonstrated accidental distraction; use add only for an explicit creative request. "
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
        self.image_model = os.getenv("NANO_BANANA_MODEL", "gemini-3.1-flash-image")
        self._client = genai.Client(api_key=self.api_key) if self.api_key else None

    @property
    def configured(self) -> bool:
        return self._client is not None

    async def analyze_semantics(
        self,
        image_bytes: bytes,
        mime_type: str,
        deterministic: AnalysisResult,
        exif: dict[str, Any],
        coaching: dict[str, str],
    ) -> SemanticAnalysis | None:
        if not self._client:
            return None
        signals = [signal.model_dump(mode="json", by_alias=True) for signal in deterministic.signals]
        evidence_references = [
            *(f"metrics.{key}" for key in deterministic.metrics),
            *(f"signals.{signal.id}" for signal in deterministic.signals),
        ]
        prompt = (
            "You are Exposure, a rigorous photography editor. Convert measured signals into concise, image-specific "
            "judgments; the deterministic layer intentionally supplies no diagnosis copy. Assess a signal only by its "
            "exact signalId. Use support when the visible photograph confirms its contextual significance and reinterpret "
            "when the measurement is real but its photographic meaning differs. Omit irrelevant or intentional signals "
            "without explaining the omission. Every assessment must include the matching signals.<id> in basedOn. New "
            "issues must cite only supplied basedOn references; image-only observations still "
            "need one related measured reference. Unknown references are discarded. Do not contradict measurements, "
            "invent EXIF, infer GPS, apply generic rules, or duplicate a signal. Present only warranted findings, from "
            "zero to three, ordered by impact. Summary: at most 24 words. Title: at most 7 words. Explanation: one "
            "sentence, at most 24 words. "
            "Action: at most 14 words. Every statement must name evidence or visible context specific to this image. "
            "Bounding boxes use [ymin,xmin,ymax,xmax] on a 0..1000 scale. Return JSON matching the schema only.\n\n"
            f"Measurements: {json.dumps(deterministic.metrics, separators=(',', ':'))}\n"
            f"Measured signals: {json.dumps(signals, separators=(',', ':'))}\n"
            f"Valid basedOn references: {json.dumps(evidence_references, separators=(',', ':'))}\n"
            f"Local EXIF without GPS: {json.dumps(exif, separators=(',', ':'), default=str)}\n"
            f"User coaching preferences: {json.dumps(coaching, separators=(',', ':'))}"
        )

        def request() -> SemanticAnalysis:
            assert self._client is not None
            interaction = self._client.interactions.create(
                model=self.semantic_model,
                input=[
                    {"type": "text", "text": prompt},
                    {"type": "image", "data": base64.b64encode(image_bytes).decode(), "mime_type": mime_type},
                ],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(SemanticAnalysis),
                },
            )
            return SemanticAnalysis.model_validate_json(interaction.output_text)

        return await asyncio.to_thread(request)

    async def coach(self, request: CoachRequest) -> CoachResponse | None:
        if not self._client:
            return None
        available_tools = list(request.available_tools)
        prompt = _coach_prompt(request, available_tools)

        def make_request() -> CoachResponse:
            assert self._client is not None
            interaction = self._client.interactions.create(
                model=self.semantic_model,
                input=prompt,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": _gemini_json_schema(CoachResponse),
                },
            )
            result = CoachResponse.model_validate_json(interaction.output_text)
            return _ground_coach_response(request, result).model_copy(update={"model": self.semantic_model})

        return await asyncio.to_thread(make_request)

    async def generate_candidate(
        self,
        image_bytes: bytes,
        mime_type: str,
        prompt: str,
        target: Region,
        operation: str,
    ) -> bytes:
        if not self._client:
            raise RuntimeError("GEMINI_API_KEY is required for generative layers")
        target_description = (
            f"normalized rectangle x={target.x:.4f}, y={target.y:.4f}, "
            f"width={target.width:.4f}, height={target.height:.4f}"
        )
        operation_instruction = {
            "remove": "Remove the content inside the target and reconstruct only the surrounding background.",
            "add": "Add the requested element inside the target, matching the scene's perspective, light, focus, and grain.",
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
            interaction = self._client.interactions.create(
                model=self.image_model,
                input=[
                    {"type": "text", "text": preservation_prompt},
                    {"type": "image", "data": base64.b64encode(image_bytes).decode(), "mime_type": mime_type},
                ],
                response_format={"type": "image", "mime_type": "image/jpeg"},
            )
            data = interaction.output_image.data
            return base64.b64decode(data) if isinstance(data, str) else bytes(data)

        try:
            return await asyncio.to_thread(request)
        except Exception as error:
            message = str(error).lower()
            status = getattr(error, "status_code", None) or getattr(error, "code", None)
            if status == 429 or "quota exceeded" in message or "rate limit" in message:
                raise GeminiImageQuotaError(
                    "The configured Gemini project has no available image-generation quota."
                ) from error
            raise GeminiImageError("Gemini image generation failed.") from error
