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

Mobile installation (once, and again only after changing native dependencies or app configuration):

```bash
cd apps/mobile
cp -n .env.example .env.local
npm install
npm run android
```

Start an Android emulator from Android Studio's Device Manager before running the command. `npm run android` automatically finds Android Studio's SDK and bundled JDK 17/21, builds the debug development client, installs it on the running emulator, and exits without leaving Metro running. The first native build is slow; normal development does not repeat it.

Normal development with Fast Refresh (no Gradle rebuild):

```bash
cd apps/mobile
npm run dev:android
```

Keep that command running while editing TypeScript. It starts Metro, launches the installed Exposure development client, and applies JavaScript/TypeScript changes with Fast Refresh. Run `npm run android` again only after changing `app.json`, `package.json` native dependencies, or files under `plugins/`.

The first development launch shows Expo's one-time developer-menu introduction. Press **Continue**, then close the menu to reveal Exposure. Fast Refresh is enabled by default.

Android Emulator reaches a host API at `http://10.0.2.2:8000`. A physical device needs the development machine's LAN address.
The API URL can also be changed at runtime under Settings → Compute service, including in the standalone APK.

API:

```bash
cd services/api
cp -n .env.example .env
uv sync
uv run uvicorn exposure_api.main:app --reload
```

`GEMINI_API_KEY` is optional for deterministic analysis, rendering, portfolio review, style extraction, and the local Coach. It is required for semantic interpretation and generative layers. Model identifiers remain environment-configurable.

Database:

```bash
npx --yes supabase@2.109.1 start
npx --yes supabase@2.109.1 db reset
npx --yes supabase@2.109.1 test db
npx --yes supabase@2.109.1 stop
```

The migration creates private `originals`, `derived`, and `layer-assets` buckets. Object paths must begin with the authenticated user's UUID. Originals have no client update or delete policy.

## Verify

```bash
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile test
npm --prefix apps/mobile run doctor
uv --directory services/api run pytest
npx --yes supabase@2.109.1 start
npx --yes supabase@2.109.1 db reset && npx --yes supabase@2.109.1 test db
npx --yes supabase@2.109.1 stop
```

`npm run android` also produces the local development APK at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

## Local APK artifacts

- `artifacts/exposure-debug.apk` is the requested debug build and connects to Metro during development.
- `artifacts/exposure-standalone.apk` is debug-signed but has the production Hermes bundle embedded, so it installs and opens without Metro. Configure the API URL in Settings before using analysis, authoritative export, or generative tools.

Both APKs use package `com.ht62026.exposure`, min SDK 24, target SDK 36, and omit microphone permission.
