import asyncio
import base64
import json
from importlib.metadata import version
from types import SimpleNamespace

import pytest

from exposure_api.models import AnalysisResult, AnalysisSignal, CoachRequest, CoachResponse, Region, SemanticAnalysis
from exposure_api.providers import (
    GeminiImageQuotaError,
    GeminiImageTimeoutError,
    GeminiProvider,
    SemanticProviderResult,
    _gemini_json_schema,
    _ground_coach_response,
)


def test_google_genai_uses_current_interactions_schema() -> None:
    major = int(version("google-genai").split(".", 1)[0])
    assert major >= 2


def test_semantic_prompt_exposes_grounded_signals_and_concise_contract() -> None:
    captured: dict[str, object] = {}

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            captured.update(kwargs)
            return SimpleNamespace(output_text=json.dumps({
                "summary": "Side light leaves the face visibly subdued.",
                "assessments": [{
                    "signalId": "signal-light",
                    "disposition": "support",
                    "confidence": 0.9,
                    "basedOn": ["signals.signal-light", "metrics.meanLuminance"],
                    "category": "lighting",
                    "title": "Window Subdues the Face",
                    "explanation": "Mean luminance is 0.2, and the visible window dominates the face.",
                    "recommendedAction": "Lift the face slightly; preserve the window mood.",
                }],
                "issues": [],
            }))

    analysis = AnalysisResult(
        version_id="version",
        checksum="checksum",
        metrics={"meanLuminance": 0.2},
        lighting={
            "exposure": -0.3,
            "contrast": 0.2,
            "clippedShadows": 0,
            "clippedHighlights": 0,
            "colorCast": {"red": 0, "green": 0, "blue": 0},
        },
        signals=[AnalysisSignal(
            id="signal-light",
            signal_key="luminance.below-threshold",
            category="lighting",
            evidence={"meanLuminance": 0.2, "threshold": 0.28},
            severity=0.5,
            confidence=0.94,
            location=Region(x=0, y=0, width=1, height=1),
        )],
        issues=[],
        camera_recommendations=[],
        summary="Measurements ready. AI unavailable.",
    )
    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]

    result = asyncio.run(provider.analyze_semantics(b"image", "image/png", analysis, {}, {}))

    assert isinstance(result, SemanticProviderResult)
    assert result.analysis.assessments[0].signal_id == "signal-light"
    assert result.model == provider.semantic_model
    prompt = captured["input"][0]["text"]  # type: ignore[index]
    assert '"id":"signal-light"' in prompt
    assert "signals.signal-light" in prompt
    assert "zero to three" in prompt
    assert "Summary: at most 12 words" in prompt
    assert "Title: at most 4 words" in prompt
    assert "Explanation: one sentence, at most 16 words" in prompt
    assert "Do not restate the summary" in prompt
    assert "Unknown references are discarded" in prompt
    assert captured["generation_config"] == {"thinking_level": "low"}

    asyncio.run(provider.analyze_semantics(b"image", "image/png", analysis, {}, {"detail": "detailed"}))
    detailed_prompt = captured["input"][0]["text"]  # type: ignore[index]
    assert "Summary: at most 18 words" in detailed_prompt
    assert "Title: at most 6 words" in detailed_prompt
    assert "Explanation: one sentence, at most 22 words" in detailed_prompt


def test_gemini_schemas_use_only_the_supported_structured_output_shape() -> None:
    for model in (SemanticAnalysis, CoachResponse):
        schema_text = json.dumps(_gemini_json_schema(model))
        assert '"$ref"' not in schema_text
        assert '"$defs"' not in schema_text
        assert '"anyOf"' not in schema_text
        assert '"default"' not in schema_text
        assert '"minLength"' not in schema_text
        assert '"maxLength"' not in schema_text
        assert '"exclusiveMinimum"' not in schema_text
    semantic_schema = _gemini_json_schema(SemanticAnalysis)
    assert "apparentIntent" not in semantic_schema["properties"]
    assert "reason" not in semantic_schema["properties"]["assessments"]["items"]["properties"]
    assert "severity" not in semantic_schema["properties"]["issues"]["items"]["properties"]


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


def test_image_timeout_error_is_normalized() -> None:
    class ApiTimeoutError(RuntimeError):
        pass

    class Interactions:
        def create(self, **_kwargs: object) -> SimpleNamespace:
            raise ApiTimeoutError("request timed out")

    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]
    with pytest.raises(GeminiImageTimeoutError):
        asyncio.run(provider.generate_candidate(
            b"source",
            "image/png",
            "remove the cable",
            Region(x=0.1, y=0.1, width=0.2, height=0.2),
            "remove",
            request_timeout_seconds=3,
        ))


@pytest.mark.parametrize(
    ("status", "message"),
    [
        (429, "quota exceeded"),
        (404, "model not found for api version"),
        (400, "model is not supported for this endpoint"),
    ],
)
def test_semantic_model_chain_falls_back_only_for_model_availability_errors(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    message: str,
) -> None:
    calls: list[dict[str, object]] = []

    class ProviderError(RuntimeError):
        def __init__(self) -> None:
            super().__init__(message)
            self.status_code = status

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            calls.append(kwargs)
            if kwargs["model"] == "primary-model":
                raise ProviderError()
            return SimpleNamespace(output_text=json.dumps({
                "summary": "Fallback response.",
                "assessments": [],
                "issues": [],
            }))

    monkeypatch.setenv("GEMINI_MODEL", "primary-model")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "primary-model, fallback-model, fallback-model")
    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]
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

    result = asyncio.run(provider.analyze_semantics(
        b"image",
        "image/png",
        analysis,
        {},
        {},
        request_timeout_seconds=7,
    ))

    assert isinstance(result, SemanticProviderResult)
    assert result.model == "fallback-model"
    assert provider.semantic_models == ("primary-model", "fallback-model")
    assert [call["model"] for call in calls] == ["primary-model", "fallback-model"]
    assert [call["timeout"] for call in calls] == [7, 7]


def test_semantic_model_chain_does_not_mask_non_model_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            calls.append(str(kwargs["model"]))
            error = RuntimeError("structured request is invalid")
            error.status_code = 400  # type: ignore[attr-defined]
            raise error

    monkeypatch.setenv("GEMINI_MODEL", "primary-model")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "fallback-model")
    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]
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

    with pytest.raises(RuntimeError, match="structured request is invalid"):
        asyncio.run(provider.analyze_semantics(b"image", "image/png", analysis, {}, {}))
    assert calls == ["primary-model"]


def test_invalid_thinking_level_falls_back_to_low(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "unbounded")
    assert GeminiProvider().thinking_level == "low"


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
    assert "normally contains zero or one reversible proposal" in prompt
    assert "Never output a generic photography checklist" in prompt
    assert "Every action must include one to four valid basedOn paths" in prompt
    assert "USE ONLY WHEN RELEVANT" in prompt
    assert "captureAdvice must be empty unless capture choices directly answer the question" in prompt
    assert captured["generation_config"] == {"thinking_level": "low"}
    assert "headline states the priority in at most 6 words" in prompt
    assert "this image in at most 16 words" in prompt
    assert "reasons at most 14" in prompt
    schema = captured["response_format"]["schema"]  # type: ignore[index]
    assert {"headline", "reason"}.issubset(schema["required"])


def test_coach_reports_the_fallback_model_that_succeeded(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class QuotaError(RuntimeError):
        status_code = 429

    class Interactions:
        def create(self, **kwargs: object) -> SimpleNamespace:
            model = str(kwargs["model"])
            calls.append(model)
            if model == "primary-model":
                raise QuotaError("quota exceeded")
            return SimpleNamespace(output_text=json.dumps({
                "headline": "No change needed",
                "reason": "The supplied measurements do not support a correction.",
                "evidence": [],
                "captureAdvice": [],
                "actions": [],
            }))

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
    monkeypatch.setenv("GEMINI_MODEL", "primary-model")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "fallback-model")
    provider = GeminiProvider()
    provider._client = SimpleNamespace(interactions=Interactions())  # type: ignore[assignment]

    result = asyncio.run(provider.coach(CoachRequest(analysis=analysis, question="What should change?")))

    assert result is not None
    assert result.model == "fallback-model"
    assert calls == ["primary-model", "fallback-model"]


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
            "basedOn": ["metrics.meanLuminance"],
        }],
        model="fixture",
    )

    assert _ground_coach_response(request, response).actions == []
