# Exposure

Exposure is an Android-first Expo photo coach. It keeps every source photograph immutable and represents editing as:

```text
immutable original + reversible canvas transform + ordered layer stack
```

The repository contains:

- `apps/mobile`: Expo SDK 54 / React Native application with camera and Android file import, local offline persistence, Skia previews, coaching, layers, history, portfolio curation, Looks, and cloud sync through the API.
- `services/api`: FastAPI service for MongoDB Atlas persistence, deterministic analysis, validated Gemini orchestration, authoritative rendering, portfolio/style computation, and localized Nano Banana patches.
- `supabase`: Private object Storage for originals, derived previews, and layer assets. Structured application data lives in MongoDB Atlas.

The cross-platform capture policy, implementation guarantees, and physical-device validation matrix are documented in [`apps/mobile/PHOTO_QUALITY.md`](apps/mobile/PHOTO_QUALITY.md).

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

For physical Android phones and iPhones, install Expo Go and Tailscale, join the same tailnet as the development machine, and run `pnpm phone`. The command starts the API and Metro on the development machine's Tailscale address without changing its Wi-Fi settings. Scan the terminal QR code with Expo Go. Expo Go signs in through browser-based Authorization Code + PKCE; installed Exposure development builds use the native Auth0 SDK.

The first development launch shows Expo's one-time developer-menu introduction. Press **Continue**, then close the menu to reveal Exposure. Fast Refresh is enabled by default.

Android Emulator reaches the host API at `http://10.0.2.2:8000`. A physical device uses the Tailscale URL injected by `pnpm phone`. Production builds take their API URL from `apps/mobile/.env.production`.

## Workspace commands

Run the API with reload:

```bash
pnpm api
```

Verify the local API, MongoDB Atlas, Supabase Storage, structured Gemini Coach response, and Gemini image-edit model with the configured development credentials:

```bash
pnpm network:smoke
```

`GEMINI_API_KEY` is optional for deterministic analysis, rendering, portfolio review, style extraction, and the local Coach. It is required for semantic interpretation and generative layers. Model identifiers remain environment-configurable.

Verify the managed Atlas database and, when retiring an existing Supabase database, run the idempotent data transfer:

```bash
pnpm db:test
pnpm db:migrate
```

Atlas credentials belong only in `services/api/.env.local` and `services/api/.env.production`; never expose them through an `EXPO_PUBLIC_` variable. `pnpm db:migrate` reads every existing Exposure row through the Supabase service role and upserts MongoDB documents, so it is safe to retry.

Supabase retains the private `originals`, `derived`, and `layer-assets` buckets. Object paths must begin with the authenticated user's Auth0 `sub`. The mobile app never connects to Atlas directly: it sends an Auth0 access token to FastAPI, and FastAPI derives every MongoDB owner scope from the verified token.

## Auth0

Exposure uses Auth0 Universal Login. Installed development and production builds lazy-load `react-native-auth0`; Expo Go uses `expo-auth-session` with Authorization Code + PKCE and stores its refreshable session in Secure Store. Both paths use domain `dev-40ogr4b5dnzkfkp3.us.auth0.com`, client ID `L5zovg4M47k5RajkppMMtIT4oBwcWYhq`, and API audience `https://api.exposure.app`. Google OAuth and the tenant's database connection appear together in Universal Login.

The Auth0 application needs these callback URLs in both its allowed callback and logout URL lists:

```text
exposure://dev-40ogr4b5dnzkfkp3.us.auth0.com/ios/com.ht62026.exposure/callback
exposure://dev-40ogr4b5dnzkfkp3.us.auth0.com/android/com.ht62026.exposure/callback
exp://100.117.203.24:8081/--/auth/callback
```

The `exp://` URL is the stable Tailscale address used by `pnpm phone`. If that development host or Metro port changes, add the URI printed by Expo Go to both Auth0 URL lists before signing in.

MongoDB Atlas is the structured database. Supabase is used only for private image-object Storage and accepts the Auth0 ID token through its third-party Auth configuration. FastAPI validates the separate Auth0 access token issued for the Exposure API audience; all `/v1/sync/*` routes require it even when public local analysis is enabled. Production API processes must set `EXPOSURE_REQUIRE_AUTH=true`.

Run every mobile, API, and database check:

```bash
pnpm test
```

`pnpm android` also produces the local development APK at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

## Local APK artifacts

- `artifacts/exposure-debug.apk` is the requested debug build and connects to Metro during development.
- `artifacts/exposure-standalone.apk` is debug-signed but has the production Hermes bundle embedded, so it installs and opens without Metro. Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env.production` or the EAS build environment before building; production builds do not expose a runtime endpoint field.

Both APKs use package `com.ht62026.exposure`, min SDK 24, target SDK 36, and omit microphone permission.
