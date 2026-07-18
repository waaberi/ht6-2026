# Exposure

Exposure is an Android-first Expo photo coach. It keeps every source photograph immutable and represents editing as:

```text
immutable original + reversible canvas transform + ordered layer stack
```

The repository contains:

- `apps/mobile`: Expo SDK 57 / React Native application with camera and Android file import, local offline persistence, Skia previews, coaching, layers, history, portfolio curation, Looks, and Supabase sync.
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

Start an Android emulator from Android Studio's Device Manager before `pnpm android`. That command automatically finds Android Studio's SDK and bundled JDK 17/21, builds the development client, installs it, and exits. The first native build is slow.

Use `pnpm dev` every day. It starts Metro, opens Exposure, and applies JavaScript/TypeScript edits with Fast Refresh without rebuilding with Gradle. Run `pnpm android` again only after changing `app.json`, native dependencies, or files under `apps/mobile/plugins/`.

The first development launch shows Expo's one-time developer-menu introduction. Press **Continue**, then close the menu to reveal Exposure. Fast Refresh is enabled by default.

Android Emulator reaches a host API at `http://10.0.2.2:8000`. A physical device needs the development machine's LAN address. The API URL can also be changed under Settings → Compute service, including in the standalone APK.

## Workspace commands

Run the API with reload:

```bash
pnpm api
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
- `artifacts/exposure-standalone.apk` is debug-signed but has the production Hermes bundle embedded, so it installs and opens without Metro. Configure the API URL in Settings before using analysis, authoritative export, or generative tools.

Both APKs use package `com.ht62026.exposure`, min SDK 24, target SDK 36, and omit microphone permission.
