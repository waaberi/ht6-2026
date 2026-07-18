# Exposure

Exposure is an Android-first Expo photo coach. It keeps every source photograph immutable and represents editing as:

```text
immutable original + reversible canvas transform + ordered layer stack
```

The repository contains:

- `apps/mobile`: Expo SDK 54 / React Native application with camera and Android file import, local offline persistence, Skia previews, coaching, layers, history, portfolio curation, Looks, and Supabase sync.
- `services/api`: FastAPI service for deterministic analysis, validated Gemini orchestration, authoritative rendering, portfolio/style computation, and localized Nano Banana patches.
- `supabase`: Postgres schema, owner-only RLS, immutable versions, private Storage buckets, Realtime jobs, and pgTAP security tests.

## Quick start

Run everything from the repository root:

```bash
pnpm bootstrap
pnpm android
pnpm dev
```

`pnpm bootstrap` is the one-time workspace setup. It installs JavaScript and Python dependencies and creates missing local environment files without overwriting existing ones.

`pnpm android` automatically starts the configured Android emulator when needed, finds Android Studio's SDK and bundled JDK 17/21, builds the development client, installs it, and exits. The first native build is slow.

Use `pnpm dev` every day. It starts the API with `.env.local`, waits for its health check, starts the emulator and Metro, opens Exposure, and applies JavaScript/TypeScript edits with Fast Refresh without rebuilding with Gradle. Run `pnpm android` again only after changing `app.json`, native dependencies, or files under `apps/mobile/plugins/`.

For physical Android phones and iPhones, install Expo Go and Tailscale, join the same tailnet as the development machine, and run `pnpm phone`. The command starts the API and Expo Go on the development machine's Tailscale address without changing its Wi-Fi settings. Scan the terminal QR code in Expo Go on Android or with the Camera app on iPhone.

The first development launch shows Expo's one-time developer-menu introduction. Press **Continue**, then close the menu to reveal Exposure. Fast Refresh is enabled by default.

Android Emulator reaches the host API at `http://10.0.2.2:8000`. A physical device uses the Tailscale URL injected by `pnpm phone`. Production builds take their API URL from `apps/mobile/.env.production`.

## Workspace commands

Run the API with reload:

```bash
pnpm api
```

Verify the local API, Supabase auth endpoint, structured Gemini Coach response, and Gemini image-edit model with the configured development credentials:

```bash
pnpm network:smoke
```

`GEMINI_API_KEY` is optional for deterministic analysis, rendering, portfolio review, style extraction, and the local Coach. It is required for semantic interpretation and generative layers. Model identifiers remain environment-configurable.

Manage the local database:

```bash
pnpm db:start
pnpm db:reset
pnpm db:test
pnpm db:stop
```

The migration creates private `originals`, `derived`, and `layer-assets` buckets. Object paths must begin with the authenticated user's UUID. Originals have no client update or delete policy.

Run every mobile, API, and database check:

```bash
pnpm test
```

`pnpm android` also produces the local development APK at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

## Local APK artifacts

- `artifacts/exposure-debug.apk` is the requested debug build and connects to Metro during development.
- `artifacts/exposure-standalone.apk` is debug-signed but has the production Hermes bundle embedded, so it installs and opens without Metro. Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env.production` or the EAS build environment before building; production builds do not expose a runtime endpoint field.

Both APKs use package `com.ht62026.exposure`, min SDK 24, target SDK 36, and omit microphone permission.
