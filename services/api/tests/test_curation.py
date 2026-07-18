from __future__ import annotations

import io

from PIL import Image, ImageDraw

from exposure_api.curation import create_style_profile, review_portfolio


def _fixture(color: str, offset: int = 0) -> bytes:
    image = Image.new("RGB", (80, 60), color)
    ImageDraw.Draw(image).rectangle((15 + offset, 10, 48 + offset, 45), fill="white")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_portfolio_flags_near_duplicates_without_deleting_them() -> None:
    images = [_fixture("navy"), _fixture("navy"), _fixture("darkred", 8)]
    review = review_portfolio(images, ["one", "two", "three"])
    assert any({"one", "two"}.issubset(group) for group in map(set, review.duplicate_groups))
    assert set(review.ordered_photo_ids + review.excluded_photo_ids) == {"one", "two", "three"}
    excluded = review.excluded_photo_ids[0]
    assert "Near-duplicate" in review.explanations[excluded]
    assert "visual variety" in review.summary


def test_portfolio_does_not_merge_same_structure_with_different_color() -> None:
    review = review_portfolio([_fixture("#082060"), _fixture("#801010")], ["blue", "red"])
    assert review.duplicate_groups == []
    assert review.excluded_photo_ids == []


def test_style_profile_is_reusable_adjustment_data() -> None:
    style = create_style_profile([_fixture("#804020"), _fixture("#704020", 2), _fixture("#904525", 4)])
    assert 3 <= len(style.palette) <= 5
    assert {"exposure", "contrast", "highlights", "shadows", "saturation", "temperature", "tint"}.issubset(style.adjustments)
    assert all(-1 <= value <= 1 for value in style.adjustments.values())
    assert "grain" not in style.adjustments
    assert "vignette" not in style.adjustments
