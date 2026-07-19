from __future__ import annotations

import asyncio
import io

from PIL import Image, ImageDraw

from exposure_api.models import AnalysisResult, CoachResponse
from scripts.smoke_gemini import run_checks


def test_smoke_checks_continue_after_semantic_failure() -> None:
    calls: list[str] = []

    class PartiallyFailingProvider:
        semantic_model = "semantic-fixture"
        image_model = "image-fixture"

        async def analyze_semantics(self, *_args, **_kwargs):
            calls.append("semantic")
            raise RuntimeError("semantic unavailable")

        async def coach(self, *_args, **_kwargs):
            calls.append("coach")
            return CoachResponse(
                headline="No change needed",
                reason="The supplied fixture has no evidence-backed issue.",
                model="coach-fixture",
            )

        async def generate_candidate(self, *_args, **_kwargs):
            calls.append("image")
            image = Image.new("RGB", (64, 64), "#496b65")
            output = io.BytesIO()
            image.save(output, format="PNG")
            return output.getvalue()

    analysis = AnalysisResult(
        version_id="smoke-fixture",
        checksum="smoke-fixture",
        metrics={},
        lighting={
            "exposure": 0,
            "contrast": 0,
            "clippedShadows": 0,
            "clippedHighlights": 0,
            "colorCast": {"red": 0, "green": 0, "blue": 0},
        },
        issues=[],
        camera_recommendations=[],
        summary="Fixture",
    )

    source = Image.new("RGB", (64, 64), "#496b65")
    ImageDraw.Draw(source).rectangle((25, 25, 39, 39), fill="#eabda8")
    encoded = io.BytesIO()
    source.save(encoded, format="PNG")

    results = asyncio.run(run_checks(
        PartiallyFailingProvider(),  # type: ignore[arg-type]
        analysis,
        encoded.getvalue(),
        include_image=True,
        include_semantic=True,
    ))

    assert results == {"semantic": False, "coach": True, "image": True}
    assert calls == ["semantic", "coach", "image"]
