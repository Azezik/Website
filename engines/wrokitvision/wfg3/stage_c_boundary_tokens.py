from __future__ import annotations

import math

import numpy as np

from .types import BoundaryEvidence, BoundaryToken, NormalizedSurface, WFG3Config
from .utils import clamp_point


def _unit(vx: float, vy: float) -> tuple[float, float]:
    n = math.hypot(vx, vy)
    if n < 1e-6:
        return 1.0, 0.0
    return vx / n, vy / n


def run_stage_c_boundary_tokens(
    surface: NormalizedSurface,
    evidence: BoundaryEvidence,
    config: WFG3Config,
) -> list[BoundaryToken]:
    ys, xs = np.where(evidence.edge_binary > 0)
    order = np.lexsort((xs, ys))
    ys = ys[order]
    xs = xs[order]

    step = max(1, config.token_step)
    tokens: list[BoundaryToken] = []
    token_id = 0
    h, w = surface.height, surface.width

    for i in range(0, len(xs), step):
        x = int(xs[i])
        y = int(ys[i])
        gx = float(evidence.grad_x[y, x])
        gy = float(evidence.grad_y[y, x])

        nx, ny = _unit(gx, gy)
        tx, ty = -ny, nx

        d = config.token_side_sample_px
        lx, ly = clamp_point(x + nx * d, y + ny * d, w, h)
        rx, ry = clamp_point(x - nx * d, y - ny * d, w, h)

        left_lab = surface.lab[ly, lx].astype(np.float32)
        right_lab = surface.lab[ry, rx].astype(np.float32)
        delta_e = float(np.linalg.norm(left_lab - right_lab))
        conf = float(min(1.0, delta_e / config.token_confidence_deltae_scale))

        tokens.append(
            BoundaryToken(
                token_id=token_id,
                x=x,
                y=y,
                tangent=(tx, ty),
                normal=(nx, ny),
                left_lab=(float(left_lab[0]), float(left_lab[1]), float(left_lab[2])),
                right_lab=(float(right_lab[0]), float(right_lab[1]), float(right_lab[2])),
                delta_e=delta_e,
                confidence=conf,
            )
        )
        token_id += 1

    return tokens
