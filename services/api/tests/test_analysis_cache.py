from __future__ import annotations

import asyncio
import hashlib

import pytest

from exposure_api import main
from exposure_api.models import AnalysisResult, CoachRequest


def _result(version_id: str) -> AnalysisResult:
    return AnalysisResult(
        version_id=version_id,
        checksum=version_id,
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


def test_analysis_cache_is_bounded_and_refreshes_recent_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "ANALYSIS_CACHE_MAX_ENTRIES", 2)
    main.analysis_cache.clear()
    first = ("first", "schema", "model", "coaching", "exif", "user")
    second = ("second", "schema", "model", "coaching", "exif", "user")
    third = ("third", "schema", "model", "coaching", "exif", "user")

    main._store_analysis(first, _result("first"))
    main._store_analysis(second, _result("second"))
    cached = main._cached_analysis(first)
    assert cached is not None and cached.version_id == "first"
    main._store_analysis(third, _result("third"))

    assert list(main.analysis_cache) == [first, third]
    main.analysis_cache.clear()


def test_analysis_cache_scope_hashes_authenticated_identity() -> None:
    first = main._analysis_cache_scope({"id": "user-one"})
    second = main._analysis_cache_scope({"id": "user-two"})

    assert first == f"user:{hashlib.sha256(b'user-one').hexdigest()}"
    assert first != second
    assert main._analysis_cache_scope(None) == "anonymous"


def test_deterministic_coach_honors_the_selected_issue(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main.provider, "_client", None)
    analysis_payload = _result("coach").model_dump(by_alias=True)
    analysis_payload["issues"] = [
        {
            "id": "first",
            "category": "lighting",
            "title": "First issue",
            "explanation": "First explanation",
            "evidence": {"value": 1},
            "severity": 0.6,
            "confidence": 0.9,
            "location": {"x": 0, "y": 0, "width": 1, "height": 1},
            "recommendedAction": "First action",
        },
        {
            "id": "second",
            "category": "composition",
            "title": "Selected issue",
            "explanation": "Selected explanation",
            "evidence": {"value": 2},
            "severity": 0.7,
            "confidence": 0.9,
            "location": {"x": 0, "y": 0, "width": 1, "height": 1},
            "recommendedAction": "Selected action",
        },
    ]
    analysis = AnalysisResult.model_validate(analysis_payload)

    response = asyncio.run(main.coach(CoachRequest(
        analysis=analysis,
        question="What should I address?",
        selected_issue_id="second",
    )))

    assert response.headline == "Selected issue"
    assert response.reason == "Selected action"
