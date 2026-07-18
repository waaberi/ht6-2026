# Exposure — AI Photo Coach Mobile App

## Summary

Build `Exposure`, an Android-first Expo photo app that opens directly into a camera and becomes an AI-assisted studio after capture or import. It analyzes photographic quality, localizes issues, recommends camera settings, applies reversible corrections, curates portfolios, and reproduces editing styles from reference photos.

Brand and identifiers:

- Display name: `Exposure`
- Expo slug: `exposure`
- Android package: `com.ht62026.exposure`
- Internal product copy should consistently call the app `Exposure`

Hard requirements:

- Prefer deterministic processing or specialized models when reliable.
- Use Gemini for semantic interpretation and Nano Banana for genuine generative work.
- Prioritize performance through proxies, concurrent analysis, caching, and local previews.
- Never overwrite or bake changes into the original photograph.
- Store filters, adjustments, masks, imported images, and generative patches as layers superposed over an immutable original.

## Architecture and Non-Destructive Editing

Use:

- Expo SDK 57/React Native for the Android application.
- Supabase for accounts, Postgres, private Storage, Realtime status, preferences, and history.
- One FastAPI service for deterministic analysis, Gemini orchestration, authoritative rendering, and generative diff extraction.

The source of truth for every photo is:

```text
Immutable original + reversible canvas transform + ordered layer stack
```

Flattened previews and exports are derived files only.

Layer types:

- `AdjustmentLayer`: exposure, contrast, highlights, shadows, temperature, tint, saturation, vibrance, sharpening, denoise, grain, and vignette.
- `MaskedAdjustmentLayer`: adjustments restricted by a subject mask, polygon, color range, or painted mask.
- `ImageLayer`: uploaded or generated image superposed with transform, opacity, blend mode, and mask.
- `RetouchLayer`: synthesized background patch covering a distraction while preserving the underlying pixels.
- `GenerativePatchLayer`: Nano Banana donor patch with its mask, target region, prompt, and provenance.
- `StyleLayer`: reusable adjustments extracted from inspiration photos.
- `CanvasTransform`: reversible crop, rotation, perspective, and canvas expansion.

Users can toggle, reorder, adjust, or remove layers. Cropping hides pixels without deleting them; removal covers pixels without erasing them; export creates a separate flattened file.

Each committed version stores an immutable layer-stack snapshot. Render caches can be regenerated without losing edits.

## Capture, Analysis, and Editing

### Capture and Import

- Use Expo SDK 57 `CameraView`, requesting EXIF and permanently copying temporary captures.
- Unmount the camera whenever its tab is unfocused.
- Import JPEG, PNG, and HEIC through DocumentPicker/ImagePicker.
- Support USB files exposed through Android’s Storage Access Framework.
- Preserve the original file and metadata privately.
- Generate a 1600-pixel analysis proxy and 320-pixel thumbnail.
- Queue offline captures for later synchronization.

[Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [Expo Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/).

### Analysis Routing

| Capability | Primary method |
|---|---|
| EXIF and camera metadata | EXIF parser |
| Exposure, clipping, contrast, color cast | Luminance/RGB/Lab histograms |
| Blur and camera shake | Laplacian variance and directional blur |
| Noise and sharpness | OpenCV/scikit-image |
| Horizon, angle, and symmetry | Hough/LSD lines and mirrored-edge comparison |
| Thirds and framing | Subject centroid, intersections, margins, and crop geometry |
| Negative space | Foreground mask and occupied-area ratios |
| Leading and motion lines | Line detector plus semantic direction |
| Faces and people | MediaPipe face/pose models |
| Saliency and distractions | Saliency, edge density, and color/brightness outliers |
| Main subject and background | Deterministic saliency with Gemini segmentation fallback |
| Mood and photographic intent | Gemini semantic reasoning |
| Generative add/remove/expand | Nano Banana donor-patch generation |

Deterministic and Gemini analysis run concurrently. Gemini receives the proxy plus measured evidence and returns validated structured output.

Every issue contains at least a normalized bounding box, with optional polygon, mask, or polyline for more precise localization. [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding).

### Analysis Categories

- Composition: thirds, symmetry, tilt, horizon, perspective, framing, balance, negative space, leading lines, and motion direction.
- Focus: main subject, background separation, focus placement, edge sharpness, and competing focal points.
- Color: palette, contrast, intensity, temperature, harmony, subject/background separation, and colors to boost or dull.
- Lighting: exposure, dynamic range, clipping, direction, hardness, uneven illumination, mixed lighting, and subject/background brightness balance.
- Distractions: awkward shapes, border intersections, bright spots, color outliers, clutter, and framing conflicts.
- Intent: determine whether technical choices support the apparent mood; intentional tilt may reinforce intensity rather than count as an error.
- Metadata: camera, lens, capture time, ISO, aperture, shutter speed, focal length, orientation, GPS availability, and subject distance when present.

Each issue includes its evidence, severity, confidence, explanation, location, recommended action, and a Fix control when safely editable.

### Camera Recommendations

Use visible evidence and EXIF to recommend:

- ISO
- Aperture/f-stop
- Shutter speed
- Focal length
- Subject distance
- Stability or tripod use
- Lighting position, diffusion, fill, or exposure compensation

Recommendations explain tradeoffs and never invent missing measurements.

### Editing and Generative Diff

Issue-to-edit mapping:

- Framing → reversible crop transform.
- Tilt/perspective → transform matrix.
- Exposure/color/lighting → global or masked adjustment layer.
- Subject emphasis → masked brightness, contrast, sharpness, or color layer.
- Distraction → retouch patch.
- Missing element → generative patch.
- Negative space → crop or generative canvas expansion.
- Irrecoverable blur/focus → honest retake advice.

Generative workflow:

1. Render the current original-plus-layers composition.
2. Send it with the target region and preservation instructions to Nano Banana.
3. Align the generated candidate with the input.
4. Calculate SSIM and Lab color-difference maps.
5. Restrict changes to the intended region plus a contextual margin.
6. Clean and feather the difference mask.
7. Extract changed pixels as an RGBA donor patch.
8. Store the patch and mask separately.
9. Superpose the patch as a generative or retouch layer.
10. Reject results with excessive unrelated drift.

The generated image is never substituted for the photograph; it only supplies localized pixels to add or cover. [Nano Banana image editing](https://ai.google.dev/gemini-api/docs/image-generation).

## Accounts, History, Portfolio, and Inspiration

- Persist Supabase sessions and open directly to Exposure’s Camera after initial sign-in.
- Navigation: Camera, Library, Portfolio, Looks, Settings.
- Studio: canvas, issue overlays, analysis cards, Coach, Edit, Layers, and History.
- Preferences: skill level, feedback detail, desired mood, export metadata, and accepted/rejected recommendations.
- Keep GPS private and exclude it from Gemini requests and exports by default.

History:

- Slider movement updates a local draft layer.
- Apply commits one layer-stack snapshot.
- Recommended and generative fixes add layers and versions.
- Restoring an old state creates a new current version from that stack.
- Disabling every layer reveals the exact original.
- Editing after restoration preserves all intervening history.

Portfolio:

- Review up to 20 selected photos for technical quality, impact, consistency, and subject clarity.
- Detect near-duplicates and choose the strongest representative.
- Recommend a coherent set and ordering with explanations.
- Never delete or hide excluded photos.

Looks:

- Select 3–8 inspiration photos.
- Extract palette, tone curve, temperature, contrast, saturation, grain, vignette, crop tendencies, and mood.
- Save the result as a reusable `StyleLayer`.
- Apply with adjustable strength.
- Preserve target content unless the user explicitly requests a generative structural change.

## Interfaces and Storage

Core records:

- `profiles`: account and preferences.
- `photos`: owner, immutable original, EXIF, current version, and capture source.
- `photo_versions`: parent/restored-from version, canvas transform, layer-stack snapshot, and render caches.
- `layer_assets`: masks, donor patches, imported images, and generated assets.
- `analyses`: deterministic metrics, subjects, lighting, composition, color, camera advice, issues, and model versions.
- `style_profiles`: references and reusable style layers.
- `portfolio_reviews`: selected photos, rankings, groups, and explanations.
- `jobs`: idempotency key, operation, progress, result, and error.

Shared types:

- `Region`
- `Issue`
- `LightingAnalysis`
- `CameraRecommendation`
- `Layer`
- `LayerStack`
- `AnalysisResult`

Compute endpoints:

- `POST /v1/analyze`
- `POST /v1/render`
- `POST /v1/layers/generative`
- `POST /v1/portfolio-review`
- `POST /v1/style-profile`
- `POST /v1/style-apply`
- `POST /v1/coach`

Use owner-only row-level security, private Storage buckets, short-lived signed URLs, and direct client uploads. Service credentials remain backend-only.

## Performance and Tests

Performance:

- Analyze resized proxies rather than originals.
- Run deterministic and Gemini processing concurrently.
- Use one structured Gemini call per version.
- Cache results by image checksum and model/schema version.
- Use Skia for local previews and FastAPI for authoritative renders.
- Upload originals once and deduplicate layer assets.
- Paginate Library results and use FlashList.

Acceptance tests:

- Verify the original remains byte-for-byte unchanged after every workflow.
- Disable all layers and recover the exact original.
- Delete render caches and reconstruct them from the layer stack.
- Confirm filters, crops, imported images, removals, additions, and Looks remain independent layers.
- Reject generative changes outside their intended masks.
- Keep boxes and masks aligned through orientation, crop, and perspective changes.
- Validate exposure, blur, tilt, contrast, color, lighting, and distraction fixtures.
- Confirm intentional mood choices are not blindly penalized.
- Ensure camera advice never invents EXIF.
- Test camera capture, Android/USB import, offline sync, history restoration, portfolio ranking, and Look application.
- Verify account and Storage isolation.
- Target camera response under 1 second, deterministic analysis under 3 seconds, combined analysis under 15 seconds, and generative edits under 20 seconds when provider latency permits.
- Produce an Android debug APK and run TypeScript, Python, API, rendering, schema, and security tests.

## Assumptions

- All user-facing branding uses `Exposure`.
- Android is guaranteed; iOS remains source-compatible but is not a release gate. Web is excluded.
- RAW development and direct tethered camera control are excluded from v1.
- Supabase is the only account, database, and storage platform.
- Lightroom APIs are not required; exports use Android’s share sheet.
- Gemini output is validated and model IDs remain environment-configurable. [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
- The current blank Expo SDK 57 scaffold and Supabase CLI configuration are retained; no feature implementation or database migration has been completed.
