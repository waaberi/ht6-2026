import asyncio
import base64
import json
from importlib.metadata import version
from types import SimpleNamespace

from exposure_api.models import AnalysisResult, CoachRequest, CoachResponse, Region
from exposure_api.providers import GeminiImageQuotaError, GeminiProvider, _ground_coach_response


def test_google_genai_uses_current_interactions_schema() -> None:
    major = int(version("google-genai").split(".", 1)[0])
    assert major >= 2


def test_generative_prompt_includes_operation_and_target() -> None:
    captured: dict[str, object] = {}

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            captured.update(kwargs)
            return SimpleNamespace(output_image=SimpleNamespace(data=base64.b64encode(b"candidate").decode()))

    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]
    result = asyncio.run(provider.generate_candidate(
        b"source",
        "image/png",
        "remove the cable",
        Region(x=0.12, y=0.23, width=0.34, height=0.45),
        "remove",
    ))
    assert result == b"candidate"
    prompt = captured["input"][0]["text"]  # type: ignore[index]
    assert "operation: remove" in prompt
    assert "x=0.1200" in prompt
    assert "y=0.2300" in prompt
    assert captured["response_format"] == {"type": "image", "mime_type": "image/jpeg"}


def test_expand_prompt_requests_scene_continuation() -> None:
    captured: dict[str, object] = {}

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            captured.update(kwargs)
            return SimpleNamespace(output_image=SimpleNamespace(data=base64.b64encode(b"candidate").decode()))

    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]
    asyncio.run(provider.generate_candidate(
        b"source",
        "image/png",
        "continue the coastline",
        Region(x=0.8, y=0, width=0.2, height=1),
        "expand",
    ))
    prompt = captured["input"][0]["text"]  # type: ignore[index]
    assert "operation: expand" in prompt
    assert "Fill the black target band" in prompt


def test_image_quota_error_is_normalized() -> None:
    class Interactions:
        def create(self, **_kwargs: object) -> SimpleNamespace:
            raise RuntimeError("quota exceeded for image requests")

    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]
    try:
        asyncio.run(provider.generate_candidate(
            b"source",
            "image/png",
            "remove the cable",
            Region(x=0.1, y=0.1, width=0.2, height=0.2),
            "remove",
        ))
    except GeminiImageQuotaError as error:
        assert "quota" in str(error)
    else:
        raise AssertionError("quota errors must use the stable provider contract")


def test_coach_prompt_exposes_only_enabled_tools_and_photography_contract() -> None:
    captured: dict[str, object] = {}

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            captured.update(kwargs)
            return SimpleNamespace(output_text=json.dumps({
                "headline": "Protect the subject",
                "reason": "The crop should preserve the subject hierarchy.",
                "evidence": [
                    {"path": "metrics.meanLuminance", "value": 0.48, "meaning": "Measured luminance."},
                    {"path": "invented.focusScore", "value": 1, "meaning": "Not supplied."},
                ],
                "captureAdvice": [
                    {"setting": "stability", "value": "Brace the phone", "basedOn": ["metrics.meanLuminance"]},
                    {"setting": "iso", "value": "ISO 100", "tradeoff": "Less noise", "basedOn": ["EXIF.ISO"]},
                ],
                "actions": [],
            }))

    analysis = AnalysisResult(
        version_id="version",
        checksum="checksum",
        metrics={"meanLuminance": 0.48},
        lighting={
            "exposure": 0,
            "contrast": 0.2,
            "clippedShadows": 0,
            "clippedHighlights": 0,
            "colorCast": {"red": 0, "green": 0, "blue": 0},
        },
        issues=[],
        camera_recommendations=[],
        summary="Balanced exposure.",
    )
    request = CoachRequest(
        analysis=analysis,
        question="Can I tighten the frame?",
        available_tools=["crop"],
    )
    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]

    result = asyncio.run(provider.coach(request))

    assert result is not None
    assert [item.path for item in result.evidence] == ["metrics.meanLuminance"]
    assert [item.setting for item in result.capture_advice] == ["stability"]
    prompt = captured["input"]
    assert "- crop:" in prompt
    assert "- remove:" not in prompt
    assert "shutter speed, aperture, and ISO as linked exposure tradeoffs" in prompt
    assert "Return the supplied JSON schema only" in prompt
    assert "absolute editor slider targets, not deltas" in prompt
    assert "expansionFraction from 0.1 to 0.5" in prompt
    schema = captured["response_format"]["schema"]  # type: ignore[index]
    assert {"headline", "reason"}.issubset(schema["required"])


def test_coach_request_defaults_to_full_tool_contract_but_respects_explicit_empty_list() -> None:
    analysis = AnalysisResult(
        version_id="version",
        checksum="checksum",
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
    assert len(CoachRequest(analysis=analysis, question="Help").available_tools) == 8
    assert CoachRequest(analysis=analysis, question="Help", available_tools=[]).available_tools == []


def test_grounding_drops_retake_without_grounded_capture_advice() -> None:
    analysis = AnalysisResult(
        version_id="version",
        checksum="checksum",
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
    request = CoachRequest(analysis=analysis, question="Should I retake?", available_tools=["retake"])
    response = CoachResponse(
        headline="Retake",
        reason="The detail cannot be recovered.",
        evidence=[],
        capture_advice=[],
        actions=[{
            "id": "retake",
            "tool": "retake",
            "label": "Retake",
            "reason": "The detail cannot be recovered.",
        }],
        model="fixture",
    )

    assert _ground_coach_response(request, response).actions == []
