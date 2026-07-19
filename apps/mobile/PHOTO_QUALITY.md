# Photo Capture Quality

Exposure configures still capture from the active camera's native capability metadata instead of assuming that Android and iOS expose the same formats.

## Applied safeguards

| Measure | Android | iOS |
|---|---|---|
| Resolution selection | Query the active CameraX camera for its advertised JPEG sizes and select the largest pixel count matching 4:3 or 16:9. If an OEM reports no exact match, retain CameraX's highest-available strategy constrained by the requested ratio. | Use AVFoundation's symbolic `Photo` preset for full-resolution 4:3 stills. For 16:9, select the largest advertised 16:9 preset. This avoids incorrectly treating `640x480` as the best 4:3 choice. |
| Camera changes | Refresh capability metadata whenever the user switches between front and rear cameras. | Refresh capability metadata whenever the user switches between front and rear cameras. |
| Configuration safety | Disable the shutter until native resolution and ratio changes have settled. | Disable the shutter until native resolution and ratio changes have settled. |
| Encoding | Request JPEG quality `1` (maximum), EXIF, and native processing. | Request JPEG quality `1` (maximum), EXIF, and native processing. |
| Focus and orientation | Keep CameraX's native focus behavior and Expo's orientation processing. | Explicitly retain continuous autofocus (`autofocus="off"` in Expo's API means the device focuses automatically as needed), enable responsive capture orientation, and retain Expo's orientation processing. |

`skipProcessing` remains `false`; enabling it would bypass the quality setting and make orientation device-dependent. Captures are requested only after `onCameraReady`.

The returned width, height, and EXIF are stored with the photo. EXIF is passed to the analysis pipeline (with GPS removed for remote analysis), allowing ISO, exposure time, aperture, focal length, lens, and camera-model metadata to inform recommendations when the device supplies those fields. Recommendations must still be based only on fields actually present.

## Platform basis

- Apple identifies [`AVCaptureSession.Preset.photo`](https://developer.apple.com/documentation/avfoundation/avcapturesession/preset/photo) as the high-resolution still-photo preset and [recommends it as the simplest route](https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/ishighestphotoqualitysupported) to the platform's highest photo quality.
- Android documents that CameraX `ImageCapture` defaults to the highest available or device-preferred resolution matching the requested aspect ratio, with device-specific selection handled by CameraX. Exposure makes that choice explicit when the camera reports a matching JPEG size and retains [`HIGHEST_AVAILABLE_STRATEGY`](https://developer.android.com/reference/androidx/camera/core/resolutionselector/ResolutionStrategy) as its safe fallback.
- Expo documents that [`pictureSize`](https://docs.expo.dev/versions/v54.0.0/sdk/camera/#picturesize) must come from `getAvailablePictureSizesAsync`, that `quality: 1` is maximum compression quality, and that disabling `skipProcessing` prevents device-dependent orientation errors. The SDK 57 contract was checked as well.

## Original preservation

The camera initially writes a temporary native file. `ingestPhoto` immediately copies those bytes into Exposure's document storage before derived work begins. The original is never resized or recompressed. Analysis proxies (1600 px) and thumbnails (320 px) are separate derived files, and the original byte size and checksum are stored for integrity and sync deduplication.

## Automated coverage

`src/domain/cameraControls.test.ts` verifies:

- maximum-quality capture options remain enabled;
- iOS 4:3 selects `Photo`, not VGA;
- iOS 16:9 selects the largest matching preset;
- Android selects the largest matching device format;
- Android safely falls back to its native highest-resolution strategy when metadata is incomplete.

Run:

```bash
pnpm --dir apps/mobile test
pnpm --dir apps/mobile typecheck
```

## Physical-device validation

Camera hardware is device-only, so release validation must cover at least one current Android phone and one current iPhone. On each device:

1. Capture rear- and front-camera photographs at both 4:3 and 16:9.
2. Repeat in portrait and landscape orientations.
3. Confirm saved dimensions match the largest advertised format for the selected ratio (or the iOS `Photo` result for 4:3).
4. Inspect the saved original at 100% for focus and orientation, and confirm EXIF survives ingestion.
5. Confirm the stored original byte count and checksum remain unchanged after analysis, editing, export, and sync.

The implementation is checked against the installed Expo SDK 54 / `expo-camera` 17 API and the target SDK 57 camera contract. Re-run this matrix after an Expo SDK upgrade because native camera behavior is device- and version-dependent.
