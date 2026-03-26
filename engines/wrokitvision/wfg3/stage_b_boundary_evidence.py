from __future__ import annotations

import cv2
import numpy as np

from .types import BoundaryEvidence, NormalizedSurface, WFG3Config


def _lab_neighbor_delta(lab: np.ndarray) -> np.ndarray:
    lab_f = lab.astype(np.float32)
    right = np.roll(lab_f, -1, axis=1)
    down = np.roll(lab_f, -1, axis=0)
    dx = np.linalg.norm(right - lab_f, axis=2)
    dy = np.linalg.norm(down - lab_f, axis=2)
    delta = np.maximum(dx, dy)
    delta[-1, :] = 0
    delta[:, -1] = 0
    return delta


def run_stage_b_boundary_evidence(surface: NormalizedSurface, config: WFG3Config) -> BoundaryEvidence:
    edges = cv2.Canny(surface.gray, config.canny_low, config.canny_high, apertureSize=3, L2gradient=True)

    grad_x = cv2.Sobel(surface.gray, cv2.CV_32F, 1, 0, ksize=config.sobel_ksize)
    grad_y = cv2.Sobel(surface.gray, cv2.CV_32F, 0, 1, ksize=config.sobel_ksize)
    grad_mag = cv2.magnitude(grad_x, grad_y)

    lab_delta = _lab_neighbor_delta(surface.lab)
    lab_edge = (lab_delta >= config.lab_delta_threshold).astype(np.uint8) * 255

    edge_union = cv2.bitwise_or(edges, lab_edge)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (config.morph_kernel, config.morph_kernel))
    edge_clean = cv2.morphologyEx(edge_union, cv2.MORPH_CLOSE, kernel)

    grad_norm = cv2.normalize(grad_mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    weighted = cv2.addWeighted(edge_clean.astype(np.uint8), 0.7, grad_norm, 0.3, 0)

    contours, _ = cv2.findContours(edge_clean, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)

    return BoundaryEvidence(
        edge_binary=edge_clean,
        edge_weighted=weighted,
        grad_x=grad_x,
        grad_y=grad_y,
        grad_mag=grad_mag,
        lab_delta=lab_delta,
        contours=contours,
    )
