from __future__ import annotations

import pytest
from pydantic import ValidationError

from exposure_api.models import CanvasExpansion, CoachAction, CoachResponse, Region


def test_region_must_remain_inside_normalized_bounds() -> None:
    assert Region(x=0.8, y=0.75, width=0.2, height=0.25).width == 0.2

    with pytest.raises(ValidationError, match="inside normalized image bounds"):
        Region(x=0.8, y=0.1, width=0.21, height=0.2)
    with pytest.raises(ValidationError, match="inside normalized image bounds"):
        Region(x=0.1, y=0.8, width=0.2, height=0.21)


def test_canvas_expansion_reference_dimensions_are_paired_and_serialize_camel_case() -> None:
    expansion = CanvasExpansion(
        top=0,
        right=1000,
        bottom=0,
        left=0,
        reference_width=4000,
        reference_height=3000,
    )
    assert expansion.model_dump(by_alias=True) == {
        "top": 0,
        "right": 1000,
        "bottom": 0,
        "left": 0,
        "referenceWidth": 4000,
        "referenceHeight": 3000,
    }
    with pytest.raises(ValidationError, match="supplied together"):
        CanvasExpansion(top=0, right=100, bottom=0, left=0, reference_width=4000)


def test_expand_requires_a_bounded_expansion_fraction_and_serializes_camel_case() -> None:
    common = {
        "id": "expand-right",
        "tool": "expand",
        "label": "Expand right",
        "reason": "The subject needs more breathing room.",
        "based_on": ["metrics.negativeSpaceRatio"],
        "canvas_transform": {"expansion": {"top": 0, "right": 1, "bottom": 0, "left": 0}},
    }

    with pytest.raises(ValidationError, match="requires expansionFraction"):
        CoachAction(**common)
    with pytest.raises(ValidationError):
        CoachAction(**common, expansion_fraction=0.09)
    with pytest.raises(ValidationError):
        CoachAction(**common, expansion_fraction=0.51)

    action = CoachAction(**common, expansion_fraction=0.25)
    payload = action.model_dump(by_alias=True)
    assert payload["expansionFraction"] == 0.25
    assert "expansion_fraction" not in payload


def test_expansion_fraction_is_rejected_for_other_tools() -> None:
    with pytest.raises(ValidationError, match="only valid for expand"):
        CoachAction(
            id="exposure",
            tool="adjust_global",
            label="Set exposure",
            reason="The measured midtones are dark.",
            based_on=["metrics.meanLuminance"],
            adjustments={"exposure": 0.25},
            expansion_fraction=0.25,
        )


def test_amplify_unifies_localized_add_remove_and_restyle_requests() -> None:
    common = {
        "id": "amplify-face",
        "tool": "amplify",
        "label": "Amplify face",
        "reason": "The user requested a localized creative edit.",
        "based_on": ["issues.face.location"],
    }
    with pytest.raises(ValidationError, match="requires an explicit target"):
        CoachAction(**common, prompt="Make the eyes blue.")
    with pytest.raises(ValidationError, match="requires a prompt"):
        CoachAction(**common, target={"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8})

    action = CoachAction(
        **common,
        target={"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
        prompt="Remove the glasses, make the eyes blue, and add a green beard.",
    )
    assert action.tool == "amplify"


def test_coach_schema_documents_absolute_global_adjustment_targets() -> None:
    schema = CoachAction.model_json_schema(by_alias=True)
    description = schema["properties"]["adjustments"]["description"]
    assert "absolute target values" in description
    expansion = schema["properties"]["expansionFraction"]
    number_schema = next(option for option in expansion["anyOf"] if option.get("type") == "number")
    assert number_schema["minimum"] == 0.1
    assert number_schema["maximum"] == 0.5


def test_crop_and_straighten_reject_ambiguous_or_invalid_transforms() -> None:
    common = {"id": "transform", "label": "Transform", "reason": "Measured geometry supports it.", "based_on": ["metrics.estimatedTiltDegrees"]}
    crop = CoachAction(
        **common,
        tool="crop",
        canvas_transform={"crop": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}},
    )
    assert crop.canvas_transform == {"crop": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}}

    with pytest.raises(ValidationError, match="normalized"):
        CoachAction(**common, tool="crop", canvas_transform={"crop": {"x": 0.8, "y": 0, "width": 0.4, "height": 1}})
    with pytest.raises(ValidationError, match="requires only"):
        CoachAction(**common, tool="crop", canvas_transform={"rotationDegrees": 4})
    with pytest.raises(ValidationError, match="within -45..45"):
        CoachAction(**common, tool="straighten", canvas_transform={"rotationDegrees": 60})


def test_adjustments_must_be_finite_and_unrelated_tools_reject_transforms() -> None:
    common = {"id": "adjust", "tool": "adjust_global", "label": "Adjust", "reason": "Measured exposure supports it.", "based_on": ["metrics.meanLuminance"]}
    with pytest.raises(ValidationError, match="finite"):
        CoachAction(**common, adjustments={"exposure": float("nan")})
    with pytest.raises(ValidationError, match="only valid"):
        CoachAction(**common, adjustments={"exposure": 0.1}, canvas_transform={"rotationDegrees": 2})
    with pytest.raises(ValidationError, match="only valid for adjustment"):
        CoachAction(
            id="retake",
            tool="retake",
            label="Retake",
            reason="The highlights are not recoverable.",
            based_on=["lighting.clippedHighlights"],
            adjustments={"exposure": -0.2},
        )


def test_coach_contract_rejects_verbose_or_ungrounded_copy() -> None:
    with pytest.raises(ValidationError, match="at most 6 words"):
        CoachAction(
            id="retake",
            tool="retake",
            label="This action label contains far too many words",
            reason="Measured clipping affects the subject.",
            based_on=["lighting.clippedHighlights"],
        )
    with pytest.raises(ValidationError, match="at most 8 words"):
        CoachResponse(
            headline="This headline contains far too many words for one recommendation",
            reason="Measured clipping affects the subject.",
            evidence=[],
            capture_advice=[],
            actions=[],
            model="fixture",
        )
    with pytest.raises(ValidationError):
        CoachAction(
            id="retake",
            tool="retake",
            label="Retake",
            reason="Measured clipping affects the subject.",
            based_on=[],
        )
