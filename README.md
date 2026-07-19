# Exposure

Exposure is an approachable, AI-native mobile photo editor for people who want better photographs without first learning a professional editing suite. It combines a capable non-destructive editor with Gemini-powered coaching: Exposure explains what could improve, shows where each suggestion applies, and lets the photographer accept the proposed adjustments while keeping the original image intact.

Built with Expo and React Native, Exposure supports Android and iOS and pairs a FastAPI backend with Auth0, MongoDB Atlas, Supabase Storage, and Gemini.

## What Exposure can do

- Capture or import full-quality photos and organize them in an edited-thumbnail library.
- Edit light, color, detail, and crop with reversible adjustments, layers, history, and reset controls.
- Start with built-in Looks such as Monotone and Vibrant, or save the current edits as a reusable preset. User presets can be renamed or deleted.
- Analyze a photo with the AI Coach and receive four focused suggestions—light, color, detail, and crop—with highlighted target regions and one-tap application of the complete adjustment plan.
- Read and correct camera metadata, including camera, lens, ISO, aperture, shutter speed, and focal length, then receive hardware-aware shooting advice.
- Generate isolated image assets as editable layers, preserving the fidelity of the original photograph.
- Chat directly with Gemini about photos, metadata, equipment, compatible lenses, and the photographer's style by attaching images from the library. Chats remain in memory for the current session only.
- Curate a selection into a recommended sequence, understand the ordering rationale, and preview it in a full-screen photography portfolio.
- Sync photographs, edits, preferences, layer assets, and portfolio reviews across devices through an authenticated account.
- Use camera aids such as a ground-relative level guide while remaining locked to portrait orientation.

Exposure's editing model is deliberately non-destructive:

```text
immutable original + reversible canvas transform + ordered layer stack
```

## Run it locally

### Prerequisites

- Node.js 22.13 or newer and pnpm 11.9 or newer
- Python and `uv`
- Android Studio with an emulator, or a physical phone with Expo Go
- Tailscale on both the development computer and physical phone for phone testing
- Local environment files for the API and mobile app

Install the workspace once:

```bash
pnpm bootstrap
```

Build and install the Android development client first:

```bash
pnpm android
```

Then start the API and Metro development server over Tailscale:

```bash
pnpm phone:tailscale
```

Join the phone and development computer to the same tailnet, then scan the QR code with Expo Go. `pnpm phone:tailscale` advertises the API and Metro server on the computer's Tailscale address, so the phone does not need to share its Wi-Fi network.

`pnpm android` locates the Android SDK and bundled JDK, starts an emulator when necessary, builds the native development client, installs it, and exits. Run it again after changing native dependencies, `app.json`, or files in `apps/mobile/plugins/`. For ordinary JavaScript and TypeScript changes, keep `pnpm phone:tailscale` running and use Fast Refresh.

For emulator-only development, run `pnpm dev` after `pnpm android`. The Android emulator reaches the API at `http://10.0.2.2:8000`.

## Architecture

- `apps/mobile` — Expo SDK 54 and React Native application, including camera/import, Skia previews, editing, Coach, Chat, curation, Looks, offline persistence, and sync.
- `services/api` — FastAPI service for authenticated sync, Gemini orchestration, deterministic photo analysis, metadata advice, rendering, generative layers, and portfolio review.
- `supabase` — private object storage for originals, rendered previews, and layer assets.
- MongoDB Atlas — structured data for photographs, edits, preferences, and reviews.
- Auth0 — Universal Login and API authorization for native builds and Expo Go.

The mobile app never connects to MongoDB directly. It sends an Auth0 access token to FastAPI, which verifies the token and derives the owner's scope. Supabase object paths are private and scoped to the authenticated user. See [`apps/mobile/PHOTO_QUALITY.md`](apps/mobile/PHOTO_QUALITY.md) for capture guarantees and the physical-device test matrix.

## Useful commands

```bash
pnpm api                 # FastAPI with reload
pnpm dev                 # API, emulator, Metro, and Exposure
pnpm phone:tailscale     # API and Metro for a physical phone over Tailscale
pnpm network:smoke       # Verify external services and Gemini flows
pnpm db:test             # Verify MongoDB Atlas
pnpm db:migrate          # Idempotently migrate legacy structured data
pnpm test                # Mobile, API, and database checks
```

`GEMINI_API_KEY` is optional for deterministic local analysis and rendering, but required for semantic coaching, library chat, metadata interpretation, and generative layers. Keep Atlas credentials in `services/api/.env.local` or `.env.production`; never expose them through an `EXPO_PUBLIC_` variable.

## Why we built it

Camera hardware has become extraordinarily accessible, but editing software still assumes technical knowledge that many new photographers do not have. Existing professional tools are powerful, yet their terminology and workflows can become a barrier to learning. Exposure turns AI into a practical editing coach: it helps users understand the photograph, make a deliberate improvement, and learn why that change works.

The project also explores a safer approach to generative editing. Generated content becomes its own layer instead of destructively replacing the source, so users can move, disable, or remove it and always return to the original.

## What we learned

Cross-platform mobile development still requires real device testing even when a framework abstracts most native behavior. Camera APIs, metadata, orientation, permissions, keyboard performance, and layout safe areas behave differently across Android and iOS. We also learned that useful AI integration depends as much on constrained outputs, fallbacks, and responsive interaction as it does on model quality.

## What's next

The next step for Exposure is public distribution through the Android and iOS app stores, followed by broader device testing and continued refinement of its coaching and generative editing workflows.
