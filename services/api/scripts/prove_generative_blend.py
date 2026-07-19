from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
from pathlib import Path
from typing import Literal

import httpx
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageOps

from exposure_api.generative import embed_localized_patch, extract_localized_patch, prepare_local_generation
from exposure_api.models import GenerativeLayerBatchResult, GenerativePatchResult, LayerStack, Region
from exposure_api.providers import GeminiProvider
from exposure_api.renderer import render_layer_stack


IDENTITY = {"rotationDegrees": 0, "perspective": [1, 0, 0, 0, 1, 0, 0, 0, 1]}


def _fixture() -> tuple[Image.Image, Image.Image, Region]:
    width, height = 256, 192
    yy, xx = np.indices((height, width), dtype=np.float32)
    sky = np.stack(
        (
            92 + yy * 0.05,
            145 + yy * 0.04,
            184 + yy * 0.03,
        ),
        axis=2,
    )
    grass = np.stack(
        (
            58 + xx * 0.025,
            103 + xx * 0.018,
            67 + yy * 0.018,
        ),
        axis=2,
    )
    pixels = np.where((yy < 114)[..., None], sky, grass)
    noise = (np.sin(xx * 0.53 + yy * 0.79) * 2.2)[..., None]
    clean = Image.fromarray(np.clip(pixels + noise, 0, 255).astype(np.uint8), "RGB")
    image = clean.copy()
    draw = ImageDraw.Draw(image)
    draw.ellipse((108, 100, 148, 140), fill=(207, 48, 45), outline=(120, 24, 26), width=2)
    draw.ellipse((117, 107, 128, 116), fill=(243, 115, 103))
    return image, clean, Region(x=0.38, y=0.47, width=0.24, height=0.3)


def _offline_candidate(clean: Image.Image) -> bytes:
    # Simulate the two common defects in a full-image model response: a global
    # color cast plus isolated codec/model speckles. The clean local removal
    # should survive while neither defect reaches the final layer.
    lab = np.asarray(clean.convert("LAB"), dtype=np.int16)
    lab += np.array([3, 5, -4], dtype=np.int16)
    candidate = Image.fromarray(np.clip(lab, 0, 255).astype(np.uint8), "LAB").convert("RGB")
    draw = ImageDraw.Draw(candidate)
    for point in ((102, 98), (153, 104), (106, 143), (151, 142)):
        draw.point(point, fill="black")
    return _png(candidate)


def _png(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def _checkerboard(size: tuple[int, int], cell: int = 16) -> Image.Image:
    yy, xx = np.indices((size[1], size[0]))
    values = np.where(((xx // cell) + (yy // cell)) % 2 == 0, 222, 184).astype(np.uint8)
    return Image.fromarray(np.stack((values, values, values), axis=2), "RGB")


def _proof_board(panels: list[tuple[str, Image.Image]]) -> Image.Image:
    panel_size = (320, 240)
    label_height = 32
    board = Image.new("RGB", (panel_size[0] * 3, (panel_size[1] + label_height) * 2), "#171717")
    draw = ImageDraw.Draw(board)
    for index, (label, image) in enumerate(panels):
        column = index % 3
        row = index // 3
        x = column * panel_size[0]
        y = row * (panel_size[1] + label_height)
        fitted = ImageOps.contain(image.convert("RGB"), panel_size, Image.Resampling.LANCZOS)
        panel_x = x + (panel_size[0] - fitted.width) // 2
        panel_y = y + label_height + (panel_size[1] - fitted.height) // 2
        board.paste(fitted, (panel_x, panel_y))
        draw.text((x + 10, y + 9), label, fill="white")
    return board


async def _request_endpoint(
    api_url: str,
    original_bytes: bytes,
    target: Region,
    operation: Literal["amplify", "expand"],
    prompt: str,
) -> GenerativePatchResult:
    data = {
        "target_json": target.model_dump_json(by_alias=True),
        "prompt": prompt,
        "source_version_id": f"blend-proof-{operation}-endpoint",
        "operation": operation,
        "layer_stack_json": json.dumps({"canvasTransform": IDENTITY, "layers": []}),
        "asset_ids_json": "[]",
    }
    if operation == "expand":
        data["expansion_json"] = json.dumps({"direction": "right", "fraction": 0.25})
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            f"{api_url.rstrip('/')}/v1/layers/generative",
            files={"image": ("blend-proof.png", original_bytes, "image/png")},
            data=data,
        )
        response.raise_for_status()
    batch = GenerativeLayerBatchResult.model_validate(response.json())
    if len(batch.layers) != 1:
        raise RuntimeError(f"Blend proof requires one generated layer, received {len(batch.layers)}")
    return GenerativePatchResult.model_validate(batch.layers[0]).model_copy(update={"expansion": batch.expansion})


async def _request_render_endpoint(
    api_url: str,
    original_bytes: bytes,
    stack: LayerStack,
    patch_bytes: bytes,
    mask_bytes: bytes,
) -> bytes:
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            f"{api_url.rstrip('/')}/v1/render",
            files=[
                ("image", ("photo.png", original_bytes, "image/png")),
                ("assets", ("patch.png", patch_bytes, "image/png")),
                ("assets", ("mask.png", mask_bytes, "image/png")),
            ],
            data={
                "layer_stack_json": stack.model_dump_json(by_alias=True),
                "asset_ids_json": json.dumps(["patch", "mask"]),
                "output_format": "png",
                "include_metadata": "false",
                "include_gps": "false",
            },
        )
        response.raise_for_status()
    return response.content


async def prove(
    output_dir: Path,
    *,
    offline: bool = False,
    api_url: str | None = None,
    operation: Literal["amplify", "expand"] = "amplify",
    image_path: Path | None = None,
    target_override: Region | None = None,
    prompt_override: str | None = None,
) -> dict[str, float | int | str]:
    if image_path is not None:
        with Image.open(image_path) as source:
            original = ImageOps.exif_transpose(source).convert("RGB")
        original.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        expected = None
        target = target_override or Region(x=0.35, y=0.35, width=0.3, height=0.3)
        prompt = prompt_override or {
            "amplify": "Remove the selected distraction and reconstruct the background naturally.",
            "expand": "Continue the scene naturally into the new canvas edge.",
        }[operation]
    else:
        fixture_with_object, clean, target = _fixture()
        if operation == "amplify":
            original = fixture_with_object
            expected = clean
            prompt = "Remove the red ball and reconstruct the grass and horizon behind it."
        else:
            original = clean
            expected = None
            prompt = "Continue the sky, horizon, and grass naturally into the new right canvas edge."
    original_bytes = _png(original)
    candidate: Image.Image | None
    generation_source: Image.Image | None = None
    generated_crop: Image.Image | None = None
    if api_url:
        result = await _request_endpoint(api_url, original_bytes, target, operation, prompt)
        candidate = None
    else:
        if operation == "expand":
            raise RuntimeError("direct expansion proof requires --api-url")
        if offline:
            model = "offline-noisy-candidate-fixture"
            candidate_bytes = _offline_candidate(clean)
            generation_source = original
            generation_target = target
            crop_box = None
        else:
            provider = GeminiProvider()
            if not provider.configured:
                raise RuntimeError("GEMINI_API_KEY is not configured")
            model = provider.image_model
            generation_source, generation_target, crop_box = prepare_local_generation(original, target)
            generation_bytes = _png(generation_source)
            candidate_bytes = await provider.generate_candidate(
                generation_bytes,
                "image/png",
                prompt,
                generation_target,
                operation,
                request_timeout_seconds=90,
            )
        result = extract_localized_patch(
            _png(generation_source),
            candidate_bytes,
            generation_target,
            operation=operation,
            model=model,
            source_version_id="blend-proof",
            prompt=prompt,
        )
        generated_crop = Image.open(io.BytesIO(candidate_bytes)).convert("RGB").resize(
            generation_source.size,
            Image.Resampling.LANCZOS,
        )
        if crop_box is not None:
            result = embed_localized_patch(result, original, crop_box)
            candidate = original.copy()
            candidate.paste(generated_crop, crop_box[:2])
        else:
            candidate = generated_crop
    # Expansion replaces the user's provisional selection with the exact new
    # canvas band. All proof bounds must use the authoritative returned target.
    target = result.target
    patch_bytes = base64.b64decode(result.patch_base64)
    mask_bytes = base64.b64decode(result.mask_base64)
    patch = Image.open(io.BytesIO(patch_bytes)).convert("RGBA")
    mask = Image.open(io.BytesIO(mask_bytes)).convert("L")

    layer = {
        "id": "blend-proof",
        "type": "generative-patch",
        "enabled": True,
        "opacity": 1,
        "patchAssetId": "patch",
        "maskAssetId": "mask",
        "canvasSpace": True,
        "canvasExpansion": result.expansion.model_dump(by_alias=True) if result.expansion else {"top": 0, "right": 0, "bottom": 0, "left": 0},
    }
    canvas_transform = dict(IDENTITY)
    if result.expansion:
        canvas_transform["expansion"] = result.expansion.model_dump(by_alias=True)
    base_stack = LayerStack.model_validate({"canvasTransform": canvas_transform, "layers": []})
    stack = LayerStack.model_validate({"canvasTransform": canvas_transform, "layers": [layer]})
    base = render_layer_stack(original_bytes, base_stack)
    rendered = render_layer_stack(original_bytes, stack, {"patch": patch_bytes, "mask": mask_bytes})
    exported: Image.Image | None = None
    export_pixel_mismatches = 0
    if api_url:
        exported_bytes = await _request_render_endpoint(
            api_url,
            original_bytes,
            stack,
            patch_bytes,
            mask_bytes,
        )
        exported = Image.open(io.BytesIO(exported_bytes)).convert("RGB")
        if exported.size != rendered.size:
            raise RuntimeError(
                f"render endpoint changed output geometry: expected={rendered.size}, actual={exported.size}"
            )
        export_pixel_mismatches = int(np.count_nonzero(
            np.any(np.asarray(exported) != np.asarray(rendered.convert("RGB")), axis=2)
        ))
        if export_pixel_mismatches:
            raise RuntimeError(
                f"render endpoint diverged from authoritative blend: {export_pixel_mismatches} pixels"
            )

    base_pixels = np.asarray(base.convert("RGB"))
    rendered_pixels = np.asarray(rendered.convert("RGB"))
    mask_pixels = np.asarray(mask)
    height, width = mask_pixels.shape
    x0, y0 = round(target.x * width), round(target.y * height)
    x1, y1 = round((target.x + target.width) * width), round((target.y + target.height) * height)
    allowed = np.zeros(mask_pixels.shape, dtype=bool)
    allowed[y0:y1, x0:x1] = True
    changed = np.any(rendered_pixels != base_pixels, axis=2)
    outside_changed = int(np.count_nonzero(changed & ~allowed))
    inside_changed = int(np.count_nonzero(changed & allowed))
    outside_alpha = int(np.max(mask_pixels[~allowed])) if np.any(~allowed) else 0
    background_pixels_over_tolerance = 0
    removed_object_mean_error = 0.0
    if expected is not None:
        expected_pixels = np.asarray(expected.convert("RGB"))
        removed_object = np.any(np.asarray(original) != expected_pixels, axis=2)
        background_target = allowed & ~removed_object
        error_from_expected = np.max(
            np.abs(rendered_pixels.astype(np.int16) - expected_pixels.astype(np.int16)),
            axis=2,
        )
        background_pixels_over_tolerance = int(np.count_nonzero((error_from_expected > 8) & background_target))
        removed_object_mean_error = float(np.mean(error_from_expected[removed_object]))
    if outside_changed or outside_alpha:
        raise RuntimeError(f"localized blend leaked outside target: pixels={outside_changed}, alpha={outside_alpha}")
    if inside_changed == 0 or mask.getbbox() is None:
        raise RuntimeError("localized blend produced no visible change")
    if offline and expected is not None and background_pixels_over_tolerance:
        raise RuntimeError(f"noise remained visible in clean background: {background_pixels_over_tolerance} pixels")

    output_dir.mkdir(parents=True, exist_ok=True)
    original.save(output_dir / "01-original.png")
    if generation_source is not None:
        generation_source.save(output_dir / "02a-gemini-input-crop.png")
    if generated_crop is not None:
        generated_crop.save(output_dir / "02b-gemini-output-crop.png")
    if base.size != original.size:
        base.save(output_dir / "02-pre-layer-canvas.png")
    if candidate is not None:
        candidate.save(output_dir / "02-gemini-full-candidate.png")
    patch.save(output_dir / "03-isolated-patch.png")
    mask.save(output_dir / "04-clean-mask.png")
    rendered.save(output_dir / "05-authoritative-blend.png")
    if exported is not None:
        exported.save(output_dir / "06-http-render.png")
    patch_preview = _checkerboard(patch.size)
    patch_preview.paste(patch.convert("RGB"), mask=patch.getchannel("A"))
    difference = ImageEnhance.Contrast(ImageChops.difference(base.convert("RGB"), rendered.convert("RGB"))).enhance(4)
    if candidate is None:
        target_preview = base.convert("RGB")
        draw = ImageDraw.Draw(target_preview)
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline="#ffd34e", width=3)
        panels = [
            ("Original sent over HTTP", original),
            ("Requested target", target_preview),
            ("RGBA layer from endpoint", patch_preview),
            ("Alpha mask from endpoint", mask.convert("RGB")),
            ("Authoritative final blend", rendered),
            ("Final visible difference x4", difference),
        ]
    else:
        panels = [
            ("Original", original),
            ("Full-image candidate", candidate),
            ("Isolated RGBA patch", patch_preview),
            ("Clean alpha mask", mask.convert("RGB")),
            ("Authoritative final blend", rendered),
            ("Final visible difference x4", difference),
        ]
    _proof_board(panels).save(output_dir / "proof-board.png")

    margin_x = max(8, (x1 - x0) // 2)
    margin_y = max(8, (y1 - y0) // 2)
    detail_box = (
        max(0, x0 - margin_x),
        max(0, y0 - margin_y),
        min(rendered.width, x1 + margin_x),
        min(rendered.height, y1 + margin_y),
    )
    detail_target = base.convert("RGB")
    ImageDraw.Draw(detail_target).rectangle((x0, y0, x1 - 1, y1 - 1), outline="#ffd34e", width=3)
    _proof_board([
        ("Original detail", base.crop(detail_box)),
        ("Requested area", detail_target.crop(detail_box)),
        ("RGBA layer detail", patch_preview.crop(detail_box)),
        ("Alpha detail", mask.crop(detail_box).convert("RGB")),
        ("Final blend detail", rendered.crop(detail_box)),
        ("Visible difference x4", difference.crop(detail_box)),
    ]).save(output_dir / "detail-board.png")

    transition_pixels = int(np.count_nonzero((mask_pixels > 0) & (mask_pixels < 255)))
    solid_pixels = int(np.count_nonzero(mask_pixels == 255))
    alpha_levels = int(np.unique(mask_pixels).size)
    seam_discontinuity_ratio = 0.0
    if operation == "expand" and original.width < rendered.width:
        seam = original.width
        adjacent_delta = np.mean(
            np.abs(rendered_pixels[:, 1:].astype(np.int16) - rendered_pixels[:, :-1].astype(np.int16)),
            axis=(0, 2),
        )
        seam_delta = float(adjacent_delta[seam - 1])
        nearby = adjacent_delta[max(0, seam - 33):min(adjacent_delta.size, seam + 32)]
        nearby = np.delete(nearby, min(32, seam - 1)) if nearby.size > 1 else nearby
        baseline_delta = float(np.median(nearby)) if nearby.size else 0.0
        seam_discontinuity_ratio = seam_delta / max(0.001, baseline_delta)
    if transition_pixels == 0:
        raise RuntimeError("blend mask has a hard binary edge with no transparency transition")
    if operation == "expand" and seam_discontinuity_ratio > 1.5:
        raise RuntimeError(
            f"expansion seam is too discontinuous relative to nearby detail: {seam_discontinuity_ratio:.3f}"
        )

    metrics: dict[str, float | int | str] = {
        "model": result.model,
        "operation": operation,
        "source": str(image_path) if image_path else "synthetic-fixture",
        "transport": "http-endpoint" if api_url else "offline" if offline else "direct-provider",
        "renderTransport": "http-endpoint" if exported is not None else "in-process",
        "exportPixelMismatchCount": export_pixel_mismatches,
        "outsideChangedPixels": outside_changed,
        "outsideMaximumAlpha": outside_alpha,
        "insideChangedPixels": inside_changed,
        "maskCoverageOfTarget": round(float(np.mean(mask_pixels[allowed] > 0)), 6),
        "alphaTransitionPixels": transition_pixels,
        "solidAlphaPixels": solid_pixels,
        "distinctAlphaLevels": alpha_levels,
        "seamDiscontinuityRatio": round(seam_discontinuity_ratio, 3),
        "backgroundPixelsOver8Delta": background_pixels_over_tolerance,
        "removedObjectMeanError": round(removed_object_mean_error, 3),
        "outsideDriftDiagnostic": round(result.drift_score, 6),
        "prompt": prompt,
        "target": target.model_dump(mode="json"),
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    return metrics


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create visual proof of a localized generative blend.")
    parser.add_argument("--output-dir", type=Path, default=Path("../../artifacts/generative-proof"))
    parser.add_argument("--offline", action="store_true", help="Use a deterministic noisy full-image candidate.")
    parser.add_argument("--api-url", help="Call the running API endpoint and verify its exact response payload.")
    parser.add_argument("--operation", choices=("amplify", "expand"), default="amplify")
    parser.add_argument("--image", type=Path, help="Use a real photograph instead of the synthetic fixture.")
    parser.add_argument("--target-json", help="Normalized target region for --image.")
    parser.add_argument("--prompt", help="Operation prompt for --image.")
    arguments = parser.parse_args()
    requested_target = Region.model_validate_json(arguments.target_json) if arguments.target_json else None
    print(json.dumps(asyncio.run(prove(
        arguments.output_dir,
        offline=arguments.offline,
        api_url=arguments.api_url,
        operation=arguments.operation,
        image_path=arguments.image,
        target_override=requested_target,
        prompt_override=arguments.prompt,
    )), indent=2))
