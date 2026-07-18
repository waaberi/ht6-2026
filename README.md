# Exposure

Exposure is an Android-first Expo photo coach. It keeps every source photograph immutable and represents editing as:

```text
immutable original + reversible canvas transform + ordered layer stack
```

The repository contains:

- `apps/mobile`: Expo SDK 57 / React Native application with camera and Android file import, local offline persistence, Skia previews, coaching, layers, history, portfolio curation, Looks, and Supabase sync.
- `services/api`: FastAPI service for deterministic analysis, validated Gemini orchestration, authoritative rendering, portfolio/style computation, and localized Nano Banana patches.
- `supabase`: Postgres schema, owner-only RLS, immutable versions, private Storage buckets, Realtime jobs, and pgTAP security tests.

## Run locally

Mobile:

```bash
cd apps/mobile
cp .env.example .env.local
npm install
npm run android
```

Android Emulator reaches a host API at `http://10.0.2.2:8000`. A physical device needs the development machine's LAN address.
The API URL can also be changed at runtime under Settings → Compute service, including in the standalone APK.

API:

```bash
cd services/api
cp .env.example .env
uv sync
uv run uvicorn exposure_api.main:app --reload
```

`GEMINI_API_KEY` is optional for deterministic analysis, rendering, portfolio review, style extraction, and the local Coach. It is required for semantic interpretation and generative layers. Model identifiers remain environment-configurable.

Database:

```bash
supabase db reset
supabase test db
```

The migration creates private `originals`, `derived`, and `layer-assets` buckets. Object paths must begin with the authenticated user's UUID. Originals have no client update or delete policy.

## Verify

```bash
cd apps/mobile && npm run typecheck && npm test && npm run doctor
cd services/api && uv run pytest
supabase db reset && supabase test db
```

Create an Android debug APK with `eas build --platform android --profile debug`, or build locally with `npm run android:debug` when the Android toolchain is installed.

## Local APK artifacts

- `artifacts/exposure-debug.apk` is the requested debug build and connects to Metro during development.
- `artifacts/exposure-standalone.apk` is debug-signed but has the production Hermes bundle embedded, so it installs and opens without Metro. Configure the API URL in Settings before using analysis, authoritative export, or generative tools.

Both APKs use package `com.ht62026.exposure`, min SDK 24, target SDK 36, and omit microphone permission.
