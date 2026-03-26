from __future__ import annotations

import cv2

from .types import NormalizedSurface, WFG3Config


def run_stage_a_normalization(image_path: str, config: WFG3Config) -> NormalizedSurface:
    bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(f"Unable to read image: {image_path}")

    h0, w0 = bgr.shape[:2]
    longest = max(h0, w0)
    scale = 1.0
    if longest > config.max_dim:
        scale = config.max_dim / float(longest)
        interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
        bgr = cv2.resize(bgr, (int(round(w0 * scale)), int(round(h0 * scale))), interpolation=interp)

    if config.denoise_mode == "gaussian":
        bgr = cv2.GaussianBlur(bgr, (5, 5), 0)
    else:
        bgr = cv2.bilateralFilter(bgr, d=7, sigmaColor=35, sigmaSpace=35)

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = bgr.shape[:2]

    return NormalizedSurface(
        source_path=image_path,
        bgr=bgr,
        rgb=rgb,
        lab=lab,
        gray=gray,
        width=w,
        height=h,
        scale_from_original=scale,
    )
