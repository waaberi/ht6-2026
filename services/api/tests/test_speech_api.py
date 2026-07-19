from __future__ import annotations

import asyncio

import httpx
import pytest

from exposure_api.main import speech_provider
from exposure_api.speech import (
    ElevenLabsSpeechProvider,
    SpeechAudio,
    SpeechProviderQuotaError,
)


def test_elevenlabs_provider_sends_low_latency_request() -> None:
    captured: dict[str, object] = {}

    async def handle(request: httpx.Request) -> httpx.Response:
        captured.update({
            "url": str(request.url),
            "api_key": request.headers.get("xi-api-key"),
            "body": request.content.decode(),
        })
        return httpx.Response(
            200,
            content=b"mp3-fixture",
            headers={
                "content-type": "audio/mpeg",
                "request-id": "request-fixture",
                "character-cost": "42",
            },
        )

    provider = ElevenLabsSpeechProvider(
        api_key="secret-fixture",
        voice_id="voice-fixture",
        model_id="eleven_flash_v2_5",
        transport=httpx.MockTransport(handle),
    )

    audio = asyncio.run(provider.synthesize("Exposure is ready."))

    assert audio == SpeechAudio(
        data=b"mp3-fixture",
        media_type="audio/mpeg",
        request_id="request-fixture",
        character_cost="42",
    )
    assert captured["api_key"] == "secret-fixture"
    assert "/text-to-speech/voice-fixture" in captured["url"]
    assert "output_format=mp3_44100_128" in captured["url"]
    assert "enable_logging" not in captured["url"]
    assert '"model_id":"eleven_flash_v2_5"' in captured["body"]


def test_elevenlabs_provider_normalizes_quota_failure() -> None:
    async def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"detail": "quota exceeded"})

    provider = ElevenLabsSpeechProvider(
        api_key="secret-fixture",
        transport=httpx.MockTransport(handle),
    )

    with pytest.raises(SpeechProviderQuotaError):
        asyncio.run(provider.synthesize("Exposure is ready."))


def test_voice_endpoint_returns_private_audio(client, monkeypatch: pytest.MonkeyPatch) -> None:
    async def synthesize(text: str) -> SpeechAudio:
        assert text == "Exposure Coach is ready."
        return SpeechAudio(
            data=b"audio-fixture",
            media_type="audio/mpeg",
            request_id="request-fixture",
            character_cost="28",
        )

    monkeypatch.setattr(speech_provider, "synthesize", synthesize)

    response = client.post(
        "/v1/voice/synthesize",
        json={"text": "  Exposure   Coach is ready.  "},
    )

    assert response.status_code == 200, response.text
    assert response.content == b"audio-fixture"
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-elevenlabs-request-id"] == "request-fixture"
    assert response.headers["x-elevenlabs-character-cost"] == "28"


def test_voice_endpoint_rejects_oversized_narration(client) -> None:
    response = client.post("/v1/voice/synthesize", json={"text": "a" * 1601})

    assert response.status_code == 422
