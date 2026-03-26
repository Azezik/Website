from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def stable_palette(n: int) -> np.ndarray:
    rng = np.random.default_rng(17)
    palette = rng.integers(30, 255, size=(max(1, n), 3), dtype=np.uint8)
    palette[0] = [0, 0, 0]
    return palette


def colorize_labels(labels: np.ndarray, nlabels: int) -> np.ndarray:
    palette = stable_palette(nlabels + 1)
    safe = np.clip(labels, 0, nlabels).astype(np.int32)
    return palette[safe]


def clamp_point(x: float, y: float, w: int, h: int) -> tuple[int, int]:
    return int(min(max(round(x), 0), w - 1)), int(min(max(round(y), 0), h - 1))


def connected_components_u8(mask: np.ndarray) -> tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    mask_u8 = (mask > 0).astype(np.uint8)
    return cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
