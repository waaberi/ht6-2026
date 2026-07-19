from __future__ import annotations

import argparse
import asyncio
import base64
import io
import os
import sys

from PIL import Image, ImageDraw

from exposure_api.generative import extract_localized_patch
from exposure_api.models import AnalysisResult, CoachRequest, Region
from exposure_api.providers import GeminiProvider, SemanticProviderResult


def _timeout_seconds(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.getenv(name, str(default))))
    except ValueError:
        return default


def _failure_message(error: Exception) -> str:
    details: list[str] = []
    current: BaseException | None = error
    while current is not None and len(details) < 3:
        detail = next((line.strip() for line in str(current).splitlines() if line.strip()), type(current).__name__)
        details.append(f"{type(current).__name__}: {detail}")
        current = current.__cause__
    return " <- ".join(details)[:500]


async def run_checks(
    provider: GeminiProvider,
    analysis: AnalysisResult,
    image_bytes: bytes,
    *,
    include_image: bool,
    include_semantic: bool,
) -> dict[str, bool]:
    results: dict[str, bool] = {}

    if include_semantic:
        semantic_timeout = _timeout_seconds("EXPOSURE_SEMANTIC_TIMEOUT_SECONDS", 25)
        try:
            semantic_response = await asyncio.wait_for(
                provider.analyze_semantics(
                    image_bytes,
                    "image/png",
                    analysis,
                    {"ISO": 200, "Camera": "Exposure network smoke"},
                    {"detail": "concise", "skillLevel": "enthusiast", "desiredMood": "natural"},
                    request_timeout_seconds=semantic_timeout,
                ),
                timeout=semantic_timeout,
            )
            if semantic_response is None:
                raise RuntimeError("no validated response")
            if isinstance(semantic_response, SemanticProviderResult):
                semantic = semantic_response.analysis
                semantic_model = semantic_response.model
            else:
                semantic = semantic_response
                semantic_model = provider.semantic_model
            if not semantic.summary:
                raise RuntimeError("validated response has no summary")
            print(f"Gemini semantic analysis: ok ({semantic_model})")
            results["semantic"] = True
        except Exception as error:
            print(f"Gemini semantic analysis: failed ({_failure_message(error)})", file=sys.stderr)
            results["semantic"] = False

    coach_timeout = _timeout_seconds("EXPOSURE_COACH_TIMEOUT_SECONDS", 25)
    try:
        response = await asyncio.wait_for(
            provider.coach(
                CoachRequest(
                    analysis=analysis,
                    question="Give one evidence-grounded next step, or say no change is needed.",
                    available_tools=["adjust_global", "crop", "retake"],
                ),
                request_timeout_seconds=coach_timeout,
            ),
            timeout=coach_timeout,
        )
        if response is None or not response.headline or not response.model:
            raise RuntimeError("no validated response")
        print(f"Gemini Coach: ok ({response.model})")
        results["coach"] = True
    except Exception as error:
        print(f"Gemini Coach: failed ({_failure_message(error)})", file=sys.stderr)
        results["coach"] = False

    if include_image:
        image_timeout = _timeout_seconds("EXPOSURE_IMAGE_TIMEOUT_SECONDS", 90)
        try:
            target = Region(x=0.36, y=0.36, width=0.28, height=0.28)
            candidate = await asyncio.wait_for(
                provider.generate_candidate(
                    image_bytes,
                    "image/png",
                    "Remove the small center square and continue the flat background.",
                    target,
                    "remove",
                    request_timeout_seconds=image_timeout,
                ),
                timeout=image_timeout,
            )
            with Image.open(io.BytesIO(candidate)) as generated:
                generated.verify()
            patch = extract_localized_patch(
                image_bytes,
                candidate,
                target,
                operation="remove",
                model=provider.image_model,
                source_version_id="network-smoke",
                prompt="Remove the small center square and continue the flat background.",
            )
            with Image.open(io.BytesIO(base64.b64decode(patch.patch_base64))) as generated_patch:
                if generated_patch.convert("RGBA").getchannel("A").getbbox() is None:
                    raise RuntimeError("localized diff produced an empty patch")
            print(f"Gemini image edit and localized diff: ok ({provider.image_model})")
            results["image"] = True
        except Exception as error:
            print(f"Gemini image edit: failed ({_failure_message(error)})", file=sys.stderr)
            results["image"] = False

    return results


async def main(include_image: bool, include_semantic: bool) -> int:
    provider = GeminiProvider()
    if not provider.configured:
        print("Gemini is not configured.", file=sys.stderr)
        return 1
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
        summary="Network fixture measurements.",
    )
    image = Image.new("RGB", (64, 64), "#496b65")
    ImageDraw.Draw(image).rectangle((25, 25, 39, 39), fill="#eabda8")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    results = await run_checks(
        provider,
        analysis,
        encoded.getvalue(),
        include_image=include_image,
        include_semantic=include_semantic,
    )
    return 0 if results and all(results.values()) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-image", action="store_true")
    parser.add_argument("--skip-semantic", action="store_true")
    arguments = parser.parse_args()
    raise SystemExit(asyncio.run(main(arguments.include_image, not arguments.skip_semantic)))
