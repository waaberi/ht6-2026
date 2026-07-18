from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any

from google import genai

from .models import AnalysisResult, SemanticAnalysis


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

    async def coach(self, analysis: AnalysisResult, question: str) -> tuple[str, str] | None:
        if not self._client:
            return None
        prompt = (
            "Answer as Exposure, a concise photography coach. Use only the supplied analysis as evidence. "
            "Never invent camera settings or claim a generative fix can recover real detail. Keep the answer under 120 words.\n\n"
            f"Analysis: {analysis.model_dump_json(by_alias=True)}\nQuestion: {question}"
        )

        def request() -> str:
            assert self._client is not None
            interaction = self._client.interactions.create(model=self.semantic_model, input=prompt)
            return interaction.output_text.strip()

        return await asyncio.to_thread(request), self.semantic_model

    async def generate_candidate(self, image_bytes: bytes, mime_type: str, prompt: str) -> bytes:
        if not self._client:
            raise RuntimeError("GEMINI_API_KEY is required for generative layers")
        preservation_prompt = (
            f"Edit only the region described by the user: {prompt}. Preserve every pixel outside that target as "
            "closely as possible. Keep camera geometry, lighting, grain, subjects, and color unchanged outside the edit."
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
