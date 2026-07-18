import asyncio
import base64
from importlib.metadata import version
from types import SimpleNamespace

from exposure_api.models import Region
from exposure_api.providers import GeminiProvider


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
