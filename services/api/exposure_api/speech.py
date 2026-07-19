from __future__ import annotations

from dataclasses import dataclass
import os
from urllib.parse import quote

import httpx


ELEVENLABS_API_ROOT = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
DEFAULT_MODEL_ID = "eleven_flash_v2_5"
DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"


class SpeechProviderError(RuntimeError):
    pass


class SpeechProviderNotConfiguredError(SpeechProviderError):
    pass


class SpeechProviderQuotaError(SpeechProviderError):
    pass


class SpeechProviderTimeoutError(SpeechProviderError):
    pass


@dataclass(frozen=True)
class SpeechAudio:
    data: bytes
    media_type: str
    request_id: str | None = None
    character_cost: str | None = None


class ElevenLabsSpeechProvider:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        voice_id: str | None = None,
        model_id: str | None = None,
        output_format: str | None = None,
        timeout_seconds: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.api_key = (api_key if api_key is not None else os.getenv("ELEVENLABS_API_KEY", "")).strip()
        self.voice_id = (voice_id or os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID)).strip()
        self.model_id = (model_id or os.getenv("ELEVENLABS_MODEL", DEFAULT_MODEL_ID)).strip()
        self.output_format = (
            output_format or os.getenv("ELEVENLABS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)
        ).strip()
        configured_timeout = timeout_seconds if timeout_seconds is not None else float(
            os.getenv("ELEVENLABS_TIMEOUT_SECONDS", "30")
        )
        self.timeout_seconds = max(5.0, min(60.0, configured_timeout))
        self.transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.voice_id and self.model_id)

    async def synthesize(self, text: str) -> SpeechAudio:
        if not self.configured:
            raise SpeechProviderNotConfiguredError("ElevenLabs speech is not configured.")

        endpoint = f"{ELEVENLABS_API_ROOT}/text-to-speech/{quote(self.voice_id, safe='')}"
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    endpoint,
                    params={"output_format": self.output_format},
                    headers={
                        "Accept": "audio/mpeg",
                        "Content-Type": "application/json",
                        "xi-api-key": self.api_key,
                    },
                    json={
                        "text": text,
                        "model_id": self.model_id,
                    },
                )
        except httpx.TimeoutException as error:
            raise SpeechProviderTimeoutError("ElevenLabs speech generation timed out.") from error
        except httpx.HTTPError as error:
            raise SpeechProviderError("ElevenLabs speech could not be reached.") from error

        if response.status_code == 429:
            raise SpeechProviderQuotaError("The ElevenLabs voice allowance has been used up.")
        if response.status_code >= 400:
            raise SpeechProviderError("ElevenLabs could not generate this narration.")
        if not response.content:
            raise SpeechProviderError("ElevenLabs returned empty narration audio.")

        media_type = response.headers.get("content-type", "audio/mpeg").split(";", 1)[0]
        if not media_type.startswith("audio/"):
            raise SpeechProviderError("ElevenLabs returned an invalid narration response.")
        return SpeechAudio(
            data=response.content,
            media_type=media_type,
            request_id=response.headers.get("request-id"),
            character_cost=response.headers.get("character-cost"),
        )
