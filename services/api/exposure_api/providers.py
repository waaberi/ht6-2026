from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any

from google import genai

from .models import AnalysisResult, CoachRequest, CoachResponse, Region, SemanticAnalysis


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
        prompt = (
            "You are Exposure, a rigorous photography coach. Interpret intent and composition using the image and "
            "measured evidence below. Do not contradict hard measurements, invent EXIF, or penalize an intentional "
            "choice merely for breaking a convention. Return at most 4 high-confidence semantic findings. Bounding "
            "boxes use [ymin,xmin,ymax,xmax] on a 0..1000 scale. Never request or infer GPS.\n\n"
            f"Measurements: {json.dumps(deterministic.metrics, separators=(',', ':'))}\n"
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
                    "schema": SemanticAnalysis.model_json_schema(by_alias=True),
                },
            )
            return SemanticAnalysis.model_validate_json(interaction.output_text)

        return await asyncio.to_thread(request)

    async def coach(self, request: CoachRequest) -> CoachResponse | None:
        if not self._client:
            return None
        available_tools = request.available_tools or [
            "adjust_global", "adjust_masked", "crop", "straighten", "remove", "add", "expand", "retake"
        ]
        selected_issue = next(
            (issue for issue in request.analysis.issues if issue.id == request.selected_issue_id),
            None,
        )
        prompt = (
            "ROLE\n"
            "You are Exposure Coach, a rigorous and concise photography assistant. Help the photographer make the "
            "smallest high-impact change that supports their apparent intent.\n\n"
            "EVIDENCE HIERARCHY\n"
            "1. Supplied EXIF and deterministic measurements are facts. 2. Localized issues are evidence-backed "
            "diagnoses. 3. Semantic intent is an interpretation and must be described as such. Never invent EXIF, "
            "camera controls, subject distance, or recoverable detail. Never infer or request GPS.\n\n"
            "PHOTOGRAPHY CHECKLIST\n"
            "Reason about shutter speed, aperture, and ISO as linked exposure tradeoffs; distinguish motion blur from "
            "focus error; account for depth of field, focal length, subject distance, perspective, stabilization, light "
            "direction and hardness, clipping and dynamic range, mixed white balance, subject hierarchy, edge tension, "
            "balance, negative space, leading lines, color harmony, and subject/background separation. Composition "
            "conventions are not rules. If blur or clipping is irrecoverable, recommend a retake instead of fake recovery.\n\n"
            "AVAILABLE TOOLS\n"
            "adjust_global: reversible global adjustment; parameters are exposure, contrast, highlights, shadows, "
            "temperature, tint, saturation, vibrance, sharpening, denoise, grain, vignette in -1..1. "
            "adjust_masked: the same adjustments but requires an explicit supplied target. "
            "crop: requires canvasTransform.crop with normalized x,y,width,height. "
            "straighten: requires canvasTransform.rotationDegrees and may use supplied measured tilt. "
            "remove: requires an explicit target and only covers an accidental distraction. "
            "add: requires an explicit target and prompt; use only for an intentional creative request, never technical repair. "
            "expand: outpaints exactly one canvas edge and requires canvasTransform.expansion with one positive side. "
            "retake: capture advice only and never claims to change the file.\n"
            f"Tools enabled by this client: {json.dumps(available_tools)}. Do not return any other tool.\n\n"
            "ACTION RULES\n"
            "Return zero to two actions. Every action requiresConfirmation must be true. Use only evidence-backed "
            "parameters, target the selected issue when one is supplied, and do not use remove/add without a target. "
            "Keep headline and reason concise. Evidence paths must reference supplied analysis fields. Capture advice "
            "must include basedOn paths and a tradeoff when recommending ISO, aperture, or shutter.\n\n"
            f"Preferences: {request.preferences.model_dump_json(by_alias=True)}\n"
            f"Analysis: {request.analysis.model_dump_json(by_alias=True)}\n"
            f"Selected issue: {selected_issue.model_dump_json(by_alias=True) if selected_issue else 'none'}\n"
            f"Current layer stack: {request.layer_stack.model_dump_json(by_alias=True) if request.layer_stack else 'not supplied'}\n"
            f"Question: {json.dumps(request.question)}"
        )

        def make_request() -> CoachResponse:
            assert self._client is not None
            interaction = self._client.interactions.create(
                model=self.semantic_model,
                input=prompt,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": CoachResponse.model_json_schema(by_alias=True),
                },
            )
            result = CoachResponse.model_validate_json(interaction.output_text)
            allowed = set(available_tools)
            return result.model_copy(update={
                "model": self.semantic_model,
                "actions": [action for action in result.actions if action.tool in allowed][:2],
            })

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
                response_format={"type": "image", "mime_type": "image/png"},
            )
            data = interaction.output_image.data
            return base64.b64decode(data) if isinstance(data, str) else bytes(data)

        return await asyncio.to_thread(request)
