from __future__ import annotations

import cv2
import numpy as np

from .types import BoundaryEvidence, NormalizedSurface, RegionPartition, WFG3Config
from .utils import connected_components_u8


def _relabel_sequential(labels: np.ndarray) -> tuple[np.ndarray, int]:
    uniq = np.unique(labels)
    remap = {int(v): i for i, v in enumerate(uniq.tolist())}
    out = np.zeros_like(labels, dtype=np.int32)
    for src, dst in remap.items():
        out[labels == src] = dst
    return out, len(uniq)


def run_stage_e_region_partition(
    surface: NormalizedSurface,
    evidence: BoundaryEvidence,
    config: WFG3Config,
) -> RegionPartition:
    inv = cv2.bitwise_not(evidence.edge_binary)
    clean = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))

    dist = cv2.distanceTransform(clean, cv2.DIST_L2, 5)
    _, sure_fg = cv2.threshold(dist, 0.25 * dist.max(), 255, cv2.THRESH_BINARY)
    sure_fg = sure_fg.astype(np.uint8)
    sure_bg = cv2.dilate(clean, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=2)
    unknown = cv2.subtract(sure_bg, sure_fg)

    n_markers, markers, _, _ = connected_components_u8(sure_fg)
    markers = markers + 1
    markers[unknown > 0] = 0

    markers_ws = cv2.watershed(surface.bgr.copy(), markers.astype(np.int32))
    labels = markers_ws.copy()
    labels[labels < 1] = 1

    # Merge tiny regions into majority neighboring label
    h, w = labels.shape
    for rid in np.unique(labels):
        if rid <= 0:
            continue
        mask = labels == rid
        area = int(mask.sum())
        if area >= config.min_region_area:
            continue
        ys, xs = np.where(mask)
        neighbor_ids: list[int] = []
        for y, x in zip(ys.tolist(), xs.tolist()):
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and labels[ny, nx] != rid:
                    neighbor_ids.append(int(labels[ny, nx]))
        if neighbor_ids:
            target = max(set(neighbor_ids), key=neighbor_ids.count)
            labels[mask] = target

    labels, count = _relabel_sequential(labels)

    stats: dict[int, dict[str, float]] = {}
    for rid in range(count):
        ys, xs = np.where(labels == rid)
        if len(xs) == 0:
            continue
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        stats[rid] = {
            "area": float(len(xs)),
            "bbox_x": float(x0),
            "bbox_y": float(y0),
            "bbox_w": float(x1 - x0 + 1),
            "bbox_h": float(y1 - y0 + 1),
        }

    return RegionPartition(labels=labels.astype(np.int32), region_count=count, stats=stats)
