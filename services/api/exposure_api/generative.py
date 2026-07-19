from __future__ import annotations

import base64
from collections import deque
import io
import re
from typing import Literal

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from .models import GenerativePatchResult, Region


LOCAL_CHANGE_THRESHOLD = 14
MATERIAL_DRIFT_THRESHOLD = 32
MAX_ADAPTIVE_THRESHOLD = 40
FOCUSED_EDIT_THRESHOLD = 48

_PROMPT_COLOR_RGB: dict[str, tuple[tuple[int, int, int], ...]] = {
    "black": ((8, 8, 8),),
    "blue": ((35, 85, 210), (25, 155, 225)),
    "brown": ((115, 70, 35),),
    "cyan": ((20, 190, 210),),
    "gold": ((220, 165, 25),),
    "golden": ((220, 165, 25),),
    "gray": ((128, 128, 128),),
    "green": ((35, 155, 70), (75, 115, 45)),
    "grey": ((128, 128, 128),),
    "magenta": ((205, 35, 175),),
    "orange": ((230, 115, 25),),
    "pink": ((230, 105, 155),),
    "purple": ((125, 55, 175),),
    "red": ((220, 35, 35), (135, 15, 20)),
    "silver": ((190, 195, 200),),
    "violet": ((125, 55, 175),),
    "white": ((247, 247, 247),),
    "yellow": ((235, 210, 30),),
}
_DARK_INTENT_WORDS = {"black", "dark", "darken", "darkened", "night", "shadow", "silhouette"}
_LIGHT_INTENT_WORDS = {"bright", "brighten", "brightened", "light", "white"}


def _prompt_words(prompt: str) -> set[str]:
    return set(re.findall(r"[a-z]+", prompt.lower()))


def _prompt_color_palette(prompt: str) -> np.ndarray | None:
    colors = [color for word in _prompt_words(prompt) for color in _PROMPT_COLOR_RGB.get(word, ())]
    return np.asarray(colors, dtype=np.float32) if colors else None


def _intent_color_seeds(
    original_rgb: np.ndarray,
    candidate_rgb: np.ndarray,
    residual_delta: np.ndarray,
    allowed: np.ndarray,
    prompt: str,
    operation: Literal["remove", "add"],
    threshold: float,
) -> np.ndarray | None:
    """Locate pixels that move toward the color explicitly requested by the user.

    A generated black block can be a stronger pixel difference than two red
    irises. Raw thresholding therefore ranks the artifact above the requested
    edit. Color intent reverses that failure mode: additions seed from pixels
    that became closer to the requested color, while removals seed from source
    pixels that used to match the requested color.
    """
    palette = _prompt_color_palette(prompt)
    if palette is None:
        return None
    original_distance = np.min(
        np.linalg.norm(original_rgb[..., None, :] - palette[None, None, ...], axis=3),
        axis=2,
    )
    candidate_distance = np.min(
        np.linalg.norm(candidate_rgb[..., None, :] - palette[None, None, ...], axis=3),
        axis=2,
    )
    if operation == "add":
        intended_distance = candidate_distance
        other_distance = original_distance
    else:
        intended_distance = original_distance
        other_distance = candidate_distance
    return (
        allowed
        & (residual_delta > max(LOCAL_CHANGE_THRESHOLD, threshold * 0.75))
        & (intended_distance < 150)
        & (other_distance - intended_distance > 18)
    )


def _connected_components(mask: np.ndarray) -> list[np.ndarray]:
    """Return eight-connected component indices without a heavyweight CV dependency."""
    height, width = mask.shape
    flat_mask = mask.ravel()
    visited = np.zeros(flat_mask.shape, dtype=bool)
    components: list[np.ndarray] = []
    for start_value in np.flatnonzero(flat_mask):
        start = int(start_value)
        if visited[start]:
            continue
        visited[start] = True
        queue: deque[int] = deque([start])
        component: list[int] = []
        while queue:
            current = queue.popleft()
            component.append(current)
            y, x = divmod(current, width)
            for neighbor_y in range(max(0, y - 1), min(height, y + 2)):
                row_offset = neighbor_y * width
                for neighbor_x in range(max(0, x - 1), min(width, x + 2)):
                    neighbor = row_offset + neighbor_x
                    if flat_mask[neighbor] and not visited[neighbor]:
                        visited[neighbor] = True
                        queue.append(neighbor)
        components.append(np.asarray(component, dtype=np.int64))
    return components


def _is_generated_corner_block(
    component: np.ndarray,
    original_rgb: np.ndarray,
    candidate_rgb: np.ndarray,
    allowed_bounds: tuple[int, int, int, int],
    allowed_area: int,
    prompt_words: set[str],
) -> bool:
    """Identify newly generated, nearly uniform rectangular edge artifacts.

    This is deliberately narrow. It does not reject arbitrary dark content;
    the component must be new, dense, nearly uniform, rectangular, and either
    occupy meaningful target area or meet two adjacent target boundaries.
    """
    width = original_rgb.shape[1]
    ys, xs = np.divmod(component, width)
    component_area = component.size
    if component_area < max(20, round(allowed_area * 0.004)):
        return False
    component_width = int(xs.max() - xs.min() + 1)
    component_height = int(ys.max() - ys.min() + 1)
    rectangularity = component_area / (component_width * component_height)
    if rectangularity < 0.82:
        return False

    generated = candidate_rgb[ys, xs]
    source = original_rgb[ys, xs]
    generated_luma = generated @ np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    source_luma = source @ np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    nearly_uniform = float(np.mean(np.std(generated, axis=0))) < 12
    new_dark_block = (
        float(np.mean(generated_luma)) < 24
        and float(np.mean(source_luma - generated_luma)) > 36
        and not (_DARK_INTENT_WORDS & prompt_words)
    )
    new_light_block = (
        float(np.mean(generated_luma)) > 242
        and float(np.mean(generated_luma - source_luma)) > 36
        and not (_LIGHT_INTENT_WORDS & prompt_words)
    )
    if not nearly_uniform or not (new_dark_block or new_light_block):
        return False

    x0, y0, x1, y1 = allowed_bounds
    touches_left = int(xs.min()) <= x0 + 1
    touches_right = int(xs.max()) >= x1 - 2
    touches_top = int(ys.min()) <= y0 + 1
    touches_bottom = int(ys.max()) >= y1 - 2
    touches_corner = (touches_left or touches_right) and (touches_top or touches_bottom)
    meaningful_block = component_area >= max(64, round(allowed_area * 0.02))
    return touches_corner or meaningful_block


def _refine_focused_change(
    changed: np.ndarray,
    allowed: np.ndarray,
    requested: np.ndarray,
    original_rgb: np.ndarray,
    candidate_rgb: np.ndarray,
    residual_delta: np.ndarray,
    prompt: str,
    operation: Literal["remove", "add"],
    threshold: float,
    allowed_bounds: tuple[int, int, int, int],
) -> np.ndarray:
    """Keep prompt-supported change components and discard obvious artifacts."""
    localized = changed & allowed
    if not np.any(localized):
        return localized
    components = _connected_components(localized)
    prompt_words = _prompt_words(prompt)
    color_seeds = _intent_color_seeds(
        original_rgb,
        candidate_rgb,
        residual_delta,
        allowed,
        prompt,
        operation,
        threshold,
    )
    minimum_seed_pixels = max(3, round(int(np.count_nonzero(allowed)) * 0.0002))
    use_color_intent = color_seeds is not None and int(np.count_nonzero(color_seeds)) >= minimum_seed_pixels
    if use_color_intent:
        seed_image = Image.fromarray(color_seeds.astype(np.uint8) * 255, "L").filter(ImageFilter.MaxFilter(5))
        nearby_seed = np.asarray(seed_image, dtype=np.uint8) > 0
    else:
        nearby_seed = np.zeros_like(allowed)

    refined = np.zeros_like(localized)
    width = localized.shape[1]
    allowed_area = int(np.count_nonzero(allowed))
    for component in components:
        if _is_generated_corner_block(
            component,
            original_rgb,
            candidate_rgb,
            allowed_bounds,
            allowed_area,
            prompt_words,
        ):
            continue
        ys, xs = np.divmod(component, width)
        # The user rectangle is a seed, not a hard crop. A legitimate object
        # may extend slightly beyond an imprecise finger selection, but an
        # unrelated generated component in the surrounding context may not.
        if not np.any(requested[ys, xs]):
            continue
        if use_color_intent and not np.any(nearby_seed[ys, xs]):
            continue
        refined[ys, xs] = True
    return refined


def _expanded_edit_bounds(
    shape: tuple[int, int],
    bounds: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    """Give component growth enough room to finish an object silhouette.

    Exact rectangular clipping creates visible lines when a user's selection
    ends a few pixels inside the edited object. Growth is deliberately bounded
    and components still have to intersect the original selection.
    """
    height, width = shape
    x0, y0, x1, y1 = bounds
    margin_x = max(4, min(64, round((x1 - x0) * 0.12)))
    margin_y = max(4, min(64, round((y1 - y0) * 0.12)))
    return (
        max(0, x0 - margin_x),
        max(0, y0 - margin_y),
        min(width, x1 + margin_x),
        min(height, y1 + margin_y),
    )


def _mask_region(mask: Image.Image, fallback: Region) -> Region:
    bounds = mask.getbbox()
    if bounds is None:
        return fallback
    width, height = mask.size
    x0, y0, x1, y1 = bounds
    return Region(
        x=x0 / width,
        y=y0 / height,
        width=(x1 - x0) / width,
        height=(y1 - y0) / height,
    )


def _suppress_unrequested_black_rectangles(
    mask: Image.Image,
    original_rgb: np.ndarray,
    candidate_rgb: np.ndarray,
    prompt: str,
    allowed_bounds: tuple[int, int, int, int],
) -> Image.Image:
    """Remove opaque black matte blocks without erasing natural dark detail.

    Candidate images can occasionally contain a near-black rectangular tile.
    Looking only at the general change component is insufficient because model
    repaint can connect that tile to the requested edit. Detect the black
    subcomponent itself and clear only large, dense rectangles not requested by
    the prompt. Small pupils, shadows, hair, and thin object details survive.
    """
    if _DARK_INTENT_WORDS & _prompt_words(prompt):
        return mask
    alpha = np.asarray(mask, dtype=np.uint8)
    active = alpha > 0
    if not np.any(active):
        return mask
    luma_weights = np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    original_luma = original_rgb @ luma_weights
    candidate_luma = candidate_rgb @ luma_weights
    x0, y0, x1, y1 = allowed_bounds
    allowed = np.zeros_like(active)
    allowed[y0:y1, x0:x1] = True
    candidate_black = allowed & (candidate_luma < 26)
    if not np.any(candidate_black):
        return mask

    height, width = candidate_black.shape
    allowed_area = max(1, (x1 - x0) * (y1 - y0))
    rejected = np.zeros_like(candidate_black)
    # Erosion disconnects a rectangular tile from thin dark features such as
    # eyebrows, hair, or an object outline. A real tile retains a dense,
    # axis-aligned core; organic dark features do not.
    eroded = np.asarray(
        Image.fromarray(candidate_black.astype(np.uint8) * 255, "L").filter(ImageFilter.MinFilter(5)),
        dtype=np.uint8,
    ) > 0
    for component in _connected_components(eroded):
        ys, xs = np.divmod(component, width)
        component_width = int(xs.max() - xs.min() + 1)
        component_height = int(ys.max() - ys.min() + 1)
        rectangularity = component.size / max(1, component_width * component_height)
        source_mean = float(np.mean(original_luma[ys, xs]))
        generated_mean = float(np.mean(candidate_luma[ys, xs]))
        minimum_area = max(36, round(allowed_area * 0.002))
        is_new_uniform_tile = (
            component.size >= minimum_area
            and component_width >= 6
            and component_height >= 6
            and rectangularity >= 0.9
            and source_mean - generated_mean > 42
        )
        if is_new_uniform_tile:
            rejected[ys, xs] = True
    if not np.any(rejected):
        return mask

    # Include the compressed fringe around the black tile so a one-pixel dark
    # outline cannot remain visible after alpha filtering on the phone.
    rejected_image = Image.fromarray(rejected.astype(np.uint8) * 255, "L").filter(ImageFilter.MaxFilter(9))
    rejected = np.asarray(rejected_image, dtype=np.uint8) > 0
    cleaned = alpha.copy()
    cleaned[rejected] = 0
    return Image.fromarray(cleaned, "L")


def _global_lab_shift(
    original_lab: np.ndarray,
    candidate_lab: np.ndarray,
    outside: np.ndarray,
) -> np.ndarray:
    if not np.any(outside):
        return np.zeros(3, dtype=np.float32)
    # The median is deliberately used instead of the mean: actual generated
    # objects and reframed areas outside the selection must not define the
    # candidate's global color correction.
    return np.median(candidate_lab[outside] - original_lab[outside], axis=0)


def _adaptive_change_threshold(residual_delta: np.ndarray, outside: np.ndarray) -> float:
    if not np.any(outside):
        return float(LOCAL_CHANGE_THRESHOLD)
    outside_delta = residual_delta[outside]
    median = float(np.median(outside_delta))
    median_deviation = float(np.median(np.abs(outside_delta - median)))
    noise_ceiling = median + 6 * 1.4826 * median_deviation
    return max(LOCAL_CHANGE_THRESHOLD, min(MAX_ADAPTIVE_THRESHOLD, noise_ceiling))


def _clean_mask(
    changed: np.ndarray,
    allowed: np.ndarray,
    *,
    cover_removed_source: bool = False,
) -> Image.Image:
    localized = np.where(allowed, changed, False).astype(np.uint8) * 255
    short_edge = min(changed.shape)
    support_radius = max(1, min(4, round(short_edge * 0.001)))
    support_size = support_radius * 2 + 1
    source = Image.fromarray(localized, "L")
    local_density = np.asarray(source.filter(ImageFilter.BoxBlur(support_radius)), dtype=np.uint8)
    # Require nearby changed pixels rather than a median-majority. This removes
    # isolated codec speckles while preserving legitimate one-pixel-wide edges,
    # hair, lettering, and other thin generated detail.
    minimum_neighbors = support_radius + 1
    support_threshold = 255 * minimum_neighbors / (support_size * support_size)
    supported = np.where((localized > 0) & (local_density >= support_threshold), 255, 0).astype(np.uint8)

    close_radius = max(1, min(3, round(short_edge * 0.00075)))
    close_size = close_radius * 2 + 1
    mask = Image.fromarray(supported, "L")
    mask = mask.filter(ImageFilter.MaxFilter(close_size)).filter(ImageFilter.MinFilter(close_size))
    feather_radius = max(2, min(12, short_edge * 0.0025))
    # Removal needs solid donor pixels beyond the former source object so its
    # color cannot bleed through the feather. Addition is the inverse: broad
    # donor padding captures the model's repainted surroundings and creates a
    # colored halo, so keep its silhouette tight and use only a one-pixel guard.
    edge_padding = (
        max(1, min(24, round(feather_radius * 2)))
        if cover_removed_source
        else 1
    )
    mask = mask.filter(ImageFilter.MaxFilter(edge_padding * 2 + 1))
    return mask.filter(ImageFilter.GaussianBlur(feather_radius))


def _expansion_mask(
    shape: tuple[int, int],
    bounds: tuple[int, int, int, int],
) -> tuple[Image.Image, Region]:
    """Keep the new band solid and crossfade narrowly over the old edge.

    Expansion is not an edit against meaningful source pixels: its source is a
    temporary black border. Diffing against that border would make legitimate
    dark generated pixels transparent and produce a noisy, incomplete layer.
    A hard band edge is also visible when the model's continuation differs by
    a few color values, so the returned layer declares and uses a small overlap
    into existing content for a reversible crossfade.
    """
    height, width = shape
    x0, y0, x1, y1 = bounds
    alpha = np.zeros(shape, dtype=np.uint8)
    alpha[y0:y1, x0:x1] = 255
    overlap = max(8, min(32, round(min(shape) * 0.025)))
    blend_x0, blend_y0, blend_x1, blend_y1 = x0, y0, x1, y1

    if y0 == 0 and y1 == height and x0 > 0:  # right edge
        overlap = min(overlap, x0)
        blend_x0 = x0 - overlap
        alpha[:, blend_x0:x0] = np.linspace(0, 255, overlap + 1, dtype=np.float32)[1:].astype(np.uint8)
    elif y0 == 0 and y1 == height and x1 < width:  # left edge
        overlap = min(overlap, width - x1)
        blend_x1 = x1 + overlap
        alpha[:, x1:blend_x1] = np.linspace(255, 0, overlap + 1, dtype=np.float32)[:-1].astype(np.uint8)
    elif x0 == 0 and x1 == width and y0 > 0:  # bottom edge
        overlap = min(overlap, y0)
        blend_y0 = y0 - overlap
        ramp = np.linspace(0, 255, overlap + 1, dtype=np.float32)[1:].astype(np.uint8)
        alpha[blend_y0:y0, :] = ramp[:, None]
    elif x0 == 0 and x1 == width and y1 < height:  # top edge
        overlap = min(overlap, height - y1)
        blend_y1 = y1 + overlap
        ramp = np.linspace(255, 0, overlap + 1, dtype=np.float32)[:-1].astype(np.uint8)
        alpha[y1:blend_y1, :] = ramp[:, None]

    target = Region(
        x=blend_x0 / width,
        y=blend_y0 / height,
        width=(blend_x1 - blend_x0) / width,
        height=(blend_y1 - blend_y0) / height,
    )
    return Image.fromarray(alpha, "L"), target


def prepare_local_generation(
    source: Image.Image,
    target: Region,
) -> tuple[Image.Image, Region, tuple[int, int, int, int]]:
    """Crop bounded edits so the requested subject is large enough to edit.

    Numeric coordinates against a full-resolution photograph are unreliable
    for small real-world objects. A three-target-width context crop preserves
    scene cues while making the selected content visually unambiguous.
    """
    width, height = source.size
    x0 = max(0, min(width - 1, round(target.x * width)))
    y0 = max(0, min(height - 1, round(target.y * height)))
    x1 = max(x0 + 1, min(width, round((target.x + target.width) * width)))
    y1 = max(y0 + 1, min(height, round((target.y + target.height) * height)))
    target_width = x1 - x0
    target_height = y1 - y0
    crop_width = min(width, max(256, target_width * 3))
    crop_height = min(height, max(256, target_height * 3))
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    left = max(0, min(width - crop_width, round(center_x - crop_width / 2)))
    top = max(0, min(height - crop_height, round(center_y - crop_height / 2)))
    right = left + crop_width
    bottom = top + crop_height
    local_target = Region(
        x=(x0 - left) / crop_width,
        y=(y0 - top) / crop_height,
        width=target_width / crop_width,
        height=target_height / crop_height,
    )
    return source.crop((left, top, right, bottom)), local_target, (left, top, right, bottom)


def embed_localized_patch(
    result: GenerativePatchResult,
    canvas_source: Image.Image,
    crop_box: tuple[int, int, int, int],
) -> GenerativePatchResult:
    """Place a crop-local patch without introducing a transparent black matte."""
    patch = Image.open(io.BytesIO(base64.b64decode(result.patch_base64))).convert("RGBA")
    mask = Image.open(io.BytesIO(base64.b64decode(result.mask_base64))).convert("L")
    canvas_source = canvas_source.convert("RGB")
    canvas_size = canvas_source.size
    left, top, right, bottom = crop_box
    crop_size = (right - left, bottom - top)
    if patch.size != crop_size:
        patch = patch.resize(crop_size, Image.Resampling.LANCZOS)
    if mask.size != crop_size:
        mask = mask.resize(crop_size, Image.Resampling.LANCZOS)
    # Transparent PNG pixels still contain RGB. Initializing these pixels to
    # black made Android/Skia filtering capable of exposing a rectangular black
    # matte around a localized crop. Back them with the source image instead:
    # even if alpha is mishandled, the fallback pixel is unchanged source data.
    canvas_patch = canvas_source.convert("RGBA")
    canvas_patch.putalpha(Image.new("L", canvas_size, 0))
    canvas_mask = Image.new("L", canvas_size, 0)
    canvas_patch.paste(patch, (left, top))
    canvas_mask.paste(mask, (left, top))
    local_target = result.target
    canvas_target = Region(
        x=(left + local_target.x * crop_size[0]) / canvas_size[0],
        y=(top + local_target.y * crop_size[1]) / canvas_size[1],
        width=local_target.width * crop_size[0] / canvas_size[0],
        height=local_target.height * crop_size[1] / canvas_size[1],
    )
    patch_output = io.BytesIO()
    mask_output = io.BytesIO()
    canvas_patch.save(patch_output, format="PNG", optimize=True)
    canvas_mask.save(mask_output, format="PNG", optimize=True)
    return result.model_copy(update={
        "patch_base64": base64.b64encode(patch_output.getvalue()).decode(),
        "mask_base64": base64.b64encode(mask_output.getvalue()).decode(),
        "target": canvas_target,
    })


def extract_localized_patch(
    original_bytes: bytes,
    candidate_bytes: bytes,
    target: Region,
    *,
    operation: Literal["remove", "add", "expand"] = "remove",
    model: str,
    source_version_id: str,
    prompt: str = "",
) -> GenerativePatchResult:
    with Image.open(io.BytesIO(original_bytes)) as source:
        original = ImageOps.exif_transpose(source).convert("RGB")
    with Image.open(io.BytesIO(candidate_bytes)) as generated:
        candidate = ImageOps.exif_transpose(generated).convert("RGB").resize(original.size, Image.Resampling.LANCZOS)

    original_lab = np.asarray(original.convert("LAB"), dtype=np.float32)
    candidate_lab = np.asarray(candidate.convert("LAB"), dtype=np.float32)
    raw_delta = np.linalg.norm(candidate_lab - original_lab, axis=2)
    materially_changed = raw_delta > MATERIAL_DRIFT_THRESHOLD
    height, width = raw_delta.shape
    x0 = max(0, round(target.x * width))
    y0 = max(0, round(target.y * height))
    x1 = min(width, round((target.x + target.width) * width))
    y1 = min(height, round((target.y + target.height) * height))
    requested = np.zeros(raw_delta.shape, dtype=bool)
    requested[y0:y1, x0:x1] = True
    allowed = requested.copy()
    expansion_mask: Image.Image | None = None
    if operation == "expand":
        expansion_mask, target = _expansion_mask(raw_delta.shape, (x0, y0, x1, y1))
        allowed = np.asarray(expansion_mask, dtype=np.uint8) > 0
        requested = allowed
    else:
        allowed_x0, allowed_y0, allowed_x1, allowed_y1 = _expanded_edit_bounds(
            raw_delta.shape,
            (x0, y0, x1, y1),
        )
        allowed = np.zeros(raw_delta.shape, dtype=bool)
        allowed[allowed_y0:allowed_y1, allowed_x0:allowed_x1] = True
    outside = ~allowed
    outside_requested = ~requested
    outside_drift = (
        float(np.mean(materially_changed[outside_requested]))
        if np.any(outside_requested)
        else 0.0
    )

    # Remove the model's global color cast before deciding which pixels form
    # the local edit. Otherwise a harmless whole-image tint becomes a noisy,
    # rectangular overlay inside the selected region.
    global_shift = _global_lab_shift(original_lab, candidate_lab, outside)
    corrected_candidate_lab = np.clip(candidate_lab - global_shift, 0, 255)
    residual_delta = np.linalg.norm(corrected_candidate_lab - original_lab, axis=2)
    if float(np.linalg.norm(global_shift)) >= 1:
        patch_rgb = Image.fromarray(corrected_candidate_lab.astype(np.uint8), "LAB").convert("RGB")
    else:
        patch_rgb = candidate
    original_rgb = np.asarray(original, dtype=np.float32)
    patch_rgb_pixels = np.asarray(patch_rgb, dtype=np.float32)
    if operation == "expand":
        assert expansion_mask is not None
        mask = expansion_mask
    else:
        threshold = _adaptive_change_threshold(residual_delta, outside)
        if operation in {"add", "remove"}:
            # Image models often repaint texture throughout the requested box.
            # Seed the layer from the much stronger added/removed-object signal;
            # padding and feathering then bring in only nearby matching context
            # instead of a noisy generated rectangle.
            focused_threshold = max(FOCUSED_EDIT_THRESHOLD, threshold * 2)
            focused_change = _refine_focused_change(
                residual_delta > focused_threshold,
                allowed,
                requested,
                original_rgb,
                patch_rgb_pixels,
                residual_delta,
                prompt,
                operation,
                threshold,
                (allowed_x0, allowed_y0, allowed_x1, allowed_y1),
            )
            mask = _clean_mask(
                focused_change,
                allowed,
                cover_removed_source=operation == "remove",
            )
            if mask.getbbox() is None:
                # Subtle requested edits can have no high-contrast core.
                # Retain the ordinary localized diff rather than returning an
                # invisible layer in that case.
                subtle_change = _refine_focused_change(
                    residual_delta > threshold,
                    allowed,
                    requested,
                    original_rgb,
                    patch_rgb_pixels,
                    residual_delta,
                    prompt,
                    operation,
                    threshold,
                    (allowed_x0, allowed_y0, allowed_x1, allowed_y1),
                )
                mask = _clean_mask(
                    subtle_change,
                    allowed,
                    cover_removed_source=operation == "remove",
                )
        else:
            mask = _clean_mask(residual_delta > threshold, allowed)
    # Noise cleanup and feathering can grow a localized mask. Clip every mode
    # so generated pixels outside the intended region can never reach canvas.
    clipped_mask = np.asarray(mask, dtype=np.uint8).copy()
    clipped_mask[outside] = 0
    mask = Image.fromarray(clipped_mask, "L")
    if operation != "expand":
        mask = _suppress_unrequested_black_rectangles(
            mask,
            original_rgb,
            patch_rgb_pixels,
            prompt,
            (allowed_x0, allowed_y0, allowed_x1, allowed_y1),
        )
    if operation != "expand":
        target = _mask_region(mask, target)
    # Store source RGB beneath fully transparent pixels. The separate mask is
    # still authoritative; this merely makes the PNG safe against decoder and
    # resampling paths that expose RGB from alpha-zero texels.
    rgba = original.convert("RGBA")
    rgba.paste(patch_rgb, (0, 0), mask.point(lambda value: 255 if value else 0))
    rgba.putalpha(mask)
    patch_output = io.BytesIO()
    mask_output = io.BytesIO()
    rgba.save(patch_output, format="PNG", optimize=True)
    mask.save(mask_output, format="PNG", optimize=True)
    return GenerativePatchResult(
        patch_base64=base64.b64encode(patch_output.getvalue()).decode(),
        mask_base64=base64.b64encode(mask_output.getvalue()).decode(),
        target=target,
        drift_score=outside_drift,
        model=model,
        source_version_id=source_version_id,
    )
