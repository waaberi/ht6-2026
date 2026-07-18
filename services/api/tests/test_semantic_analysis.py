from __future__ import annotations

import hashlib
import io

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from exposure_api.analysis import analyze_deterministic, merge_semantic
from exposure_api.models import (
    AnalysisResult,
    AnalysisSignal,
    Fix,
    Region,
    SemanticAnalysis,
)


def _analysis_with_signals() -> AnalysisResult:
    return AnalysisResult(
        version_id="version",
        checksum="checksum",
        metrics={"meanLuminance": 0.2, "estimatedTiltDegrees": 8.0},
        lighting={
            "exposure": -0.3,
            "contrast": 0.2,
            "clippedShadows": 0,
            "clippedHighlights": 0,
            "colorCast": {"red": 0, "green": 0, "blue": 0},
        },
        signals=[
            AnalysisSignal(
                id="signal-light",
                signal_key="luminance.below-threshold",
                category="lighting",
                evidence={"meanLuminance": 0.2, "threshold": 0.28},
                severity=0.5,
                confidence=0.94,
                location=Region(x=0, y=0, width=1, height=1),
                fix=Fix(kind="adjustment", adjustments={"exposure": 0.25}),
            ),
            AnalysisSignal(
                id="signal-tilt",
                signal_key="composition.dominant-line-offset",
                category="composition",
                evidence={"estimatedTiltDegrees": 8.0},
                severity=0.6,
                confidence=0.8,
                location=Region(x=0, y=0, width=1, height=1),
                fix=Fix(kind="transform", canvas_transform={"rotationDegrees": 8.0}),
            ),
            AnalysisSignal(
                id="signal-edge",
                signal_key="composition.border-saliency-outlier",
                category="distraction",
                evidence={"borderOutlierRatio": 1.8},
                severity=0.4,
                confidence=0.7,
                location=Region(x=0.8, y=0.2, width=0.2, height=0.2),
            ),
        ],
        issues=[],
        camera_recommendations=[],
        summary="AI interpretation unavailable. Measurements are still ready.",
    )


def test_deterministic_analysis_emits_signals_without_diagnosis_templates() -> None:
    image = Image.new("RGB", (161, 101), "#111111")
    ImageDraw.Draw(image).line((5, 90, 155, 40), fill="white", width=5)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    image_bytes = encoded.getvalue()
    checksum = hashlib.sha256(image_bytes).hexdigest()

    first = analyze_deterministic(image_bytes, version_id="one", checksum=checksum)
    second = analyze_deterministic(image_bytes, version_id="two", checksum=checksum)

    assert first.metrics
    assert first.signals
    assert first.issues == []
    assert first.camera_recommendations == []
    assert first.summary == "AI interpretation unavailable. Measurements are still ready."
    assert [signal.id for signal in first.signals] == [signal.id for signal in second.signals]
    assert all(signal.id.startswith("signal-") for signal in first.signals)
    assert all(signal.signal_key and signal.evidence for signal in first.signals)


def test_semantic_merge_supports_reinterprets_omits_and_adds() -> None:
    result = _analysis_with_signals()
    semantic = SemanticAnalysis.model_validate({
        "summary": "Window light and the diagonal create a deliberate, quiet portrait.",
        "assessments": [
            {
                "signalId": "signal-light",
                "disposition": "support",
                "confidence": 0.9,
                "basedOn": ["signals.signal-light", "metrics.meanLuminance"],
                "category": "lighting",
                "title": "Window Overpowers the Face",
                "explanation": "Mean luminance is 0.2, while the visible window leaves the face without separation.",
                "recommendedAction": "Lift the face slightly, preserving the window mood.",
            },
            {
                "signalId": "signal-tilt",
                "disposition": "reinterpret",
                "confidence": 0.88,
                "basedOn": ["signals.signal-tilt", "metrics.estimatedTiltDegrees"],
                "category": "intent",
                "title": "Diagonal Adds Momentum",
                "explanation": "The measured eight-degree diagonal follows the visible architecture and supports the subject's movement.",
                "recommendedAction": "Keep the diagonal; tighten the trailing edge.",
            },
        ],
        "issues": [{
            "category": "distraction",
            "title": "Window Edge Touches Hair",
            "explanation": "The bright window edge visibly intersects the hair, competing with the dim face at mean luminance 0.2.",
            "confidence": 0.86,
            "box2d": [120, 680, 820, 920],
            "recommendedAction": "Darken that narrow edge without flattening the window.",
            "basedOn": ["metrics.meanLuminance"],
        }],
    })

    merged = merge_semantic(result, semantic, "gemini-fixture")

    assert merged.semantic_model == "gemini-fixture"
    assert len(merged.issues) == 3
    assert {issue.id for issue in merged.issues if issue.id.startswith("signal-")} == {"signal-tilt", "signal-light"}
    assert any(issue.id.startswith("semantic-") for issue in merged.issues)
    supported = next(issue for issue in merged.issues if issue.id == "signal-light")
    reinterpreted = next(issue for issue in merged.issues if issue.id == "signal-tilt")
    assert supported.fix is not None
    assert supported.evidence["semanticDisposition"] == "support"
    assert reinterpreted.fix is None
    assert reinterpreted.category == "intent"
    assert all(issue.id != "signal-edge" for issue in merged.issues)


def test_semantic_merge_discards_unknown_grounding_references() -> None:
    result = _analysis_with_signals()
    semantic = SemanticAnalysis.model_validate({
        "summary": "The measured exposure needs image context before any edit.",
        "assessments": [
            {
                "signalId": "signal-light",
                "disposition": "support",
                "confidence": 0.9,
                "basedOn": ["signals.signal-light", "metrics.inventedScore"],
                "category": "lighting",
                "title": "Face Needs Separation",
                "explanation": "The visible face merges into the dark wall despite the low-key intent.",
                "recommendedAction": "Lift only the face by a small amount.",
            },
        ],
        "issues": [
            {
                "category": "composition",
                "title": "Generic Composition Claim",
                "explanation": "The frame supposedly needs a crop without any supplied evidence supporting that claim.",
                "confidence": 0.8,
                "box2d": [0, 0, 500, 500],
                "recommendedAction": "Crop the frame.",
                "basedOn": ["metrics.ruleOfThirdsScore"],
            },
        ],
    })

    merged = merge_semantic(result, semantic, "gemini-fixture")

    assert merged.issues == []


@pytest.mark.parametrize(
    "payload",
    [
        {
            "summary": "A concise summary.",
            "assessments": [{
                "signalId": "signal-light",
                "disposition": "support",
                "confidence": 0.9,
                "basedOn": ["signals.signal-light"],
            }],
        },
        {
            "summary": "A concise summary.",
            "assessments": [{
                "signalId": "signal-light",
                "disposition": "suppress",
                "confidence": 0.9,
                "basedOn": ["signals.signal-light"],
                "category": "lighting",
                "title": "Invalid Suppression",
                "explanation": "Suppressed signals should not consume output.",
                "recommendedAction": "Omit it.",
            }],
        },
        {
            "summary": "A concise summary.",
            "issues": [{
                "category": "composition",
                "title": "An Ungrounded Finding",
                "explanation": "A visible edge crosses the subject without any measured reference.",
                "confidence": 0.8,
                "box2d": [0, 0, 500, 500],
                "recommendedAction": "Crop the edge.",
                "basedOn": [],
            }],
        },
    ],
)
def test_semantic_contract_rejects_incomplete_assessments(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SemanticAnalysis.model_validate(payload)
