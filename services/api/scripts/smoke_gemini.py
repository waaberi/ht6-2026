from __future__ import annotations

import argparse
import asyncio
import io

from PIL import Image, ImageDraw

from exposure_api.models import AnalysisResult, CoachRequest, Region
from exposure_api.providers import GeminiImageQuotaError, GeminiProvider


async def main(include_image: bool, include_semantic: bool) -> None:
    provider = GeminiProvider()
    if not provider.configured:
        raise SystemExit("Gemini is not configured.")
    analysis = AnalysisResult(
        version_id="network-smoke",
        checksum="network-smoke",
        metrics={"meanLuminance": 0.48, "laplacianVariance": 0.02},
        lighting={
            "exposure": 0,
            "contrast": 0.2,
            "clippedShadows": 0,
            "clippedHighlights": 0,
            "colorCast": {"red": 0, "green": 0, "blue": 0},
        },
        issues=[],
        camera_recommendations=[],
        summary="The fixture has balanced exposure and clear edges.",
    )
    image = Image.new("RGB", (64, 64), "#496b65")
    ImageDraw.Draw(image).rectangle((25, 25, 39, 39), fill="#eabda8")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    if include_semantic:
        semantic = await asyncio.wait_for(
            provider.analyze_semantics(
                encoded.getvalue(),
                "image/png",
                analysis,
                {"ISO": 200, "Camera": "Exposure network smoke"},
                {"detail": "concise", "skillLevel": "enthusiast", "desiredMood": "natural"},
            ),
            timeout=45,
        )
        if semantic is None or not semantic.summary:
            raise SystemExit("Gemini semantic analysis returned no validated response.")
        print(f"Gemini semantic analysis: ok ({provider.semantic_model})")

    response = await provider.coach(CoachRequest(
        analysis=analysis,
        question="Give one evidence-grounded next step, or say no change is needed.",
        available_tools=["adjust_global", "crop", "retake"],
    ))
    if response is None or not response.headline or not response.model:
        raise SystemExit("Gemini Coach returned no validated response.")
    print(f"Gemini Coach: ok ({response.model})")

    if include_image:
        try:
            candidate = await provider.generate_candidate(
                encoded.getvalue(),
                "image/png",
                "Remove the small center square and continue the flat background.",
                Region(x=0.36, y=0.36, width=0.28, height=0.28),
                "remove",
            )
        except GeminiImageQuotaError as error:
            raise SystemExit(f"Gemini image edit: blocked ({error})") from error
        with Image.open(io.BytesIO(candidate)) as generated:
            generated.verify()
        print(f"Gemini image edit: ok ({provider.image_model})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-image", action="store_true")
    parser.add_argument("--skip-semantic", action="store_true")
    arguments = parser.parse_args()
    asyncio.run(main(arguments.include_image, not arguments.skip_semantic))
