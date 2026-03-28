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


def _make_token(
    token_id: int, x: int, y: int,
    surface: NormalizedSurface, evidence: BoundaryEvidence, config: WFG3Config,
) -> BoundaryToken:
    """Construct a single boundary token at (x, y)."""
    h, w = surface.height, surface.width
    gx = float(evidence.grad_x[y, x])
    gy = float(evidence.grad_y[y, x])

    nx, ny = _unit(gx, gy)
    # If gradient is near-zero, average 3×3 neighborhood
    if math.hypot(gx, gy) < 0.001:
        acc_x, acc_y = 0.0, 0.0
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                sy, sx = y + dy, x + dx
                if 0 <= sy < h and 0 <= sx < w:
                    acc_x += float(evidence.grad_x[sy, sx])
                    acc_y += float(evidence.grad_y[sy, sx])
        if math.hypot(acc_x, acc_y) >= 0.001:
            nx, ny = _unit(acc_x, acc_y)

    tx, ty = -ny, nx

    d = config.token_side_sample_px
    lx, ly = clamp_point(x + nx * d, y + ny * d, w, h)
    rx, ry = clamp_point(x - nx * d, y - ny * d, w, h)

    left_lab = surface.lab[ly, lx].astype(np.float32)
    right_lab = surface.lab[ry, rx].astype(np.float32)
    delta_e = float(np.linalg.norm(left_lab - right_lab))
    conf = float(min(1.0, delta_e / config.token_confidence_deltae_scale))

    return BoundaryToken(
        token_id=token_id, x=x, y=y,
        tangent=(tx, ty), normal=(nx, ny),
        left_lab=(float(left_lab[0]), float(left_lab[1]), float(left_lab[2])),
        right_lab=(float(right_lab[0]), float(right_lab[1]), float(right_lab[2])),
        delta_e=delta_e, confidence=conf,
    )


def _local_evidence_at(
    px: int, py: int, evidence: BoundaryEvidence, w: int, h: int,
) -> float:
    """Sample max evidence in a 3×3 window around (px, py). Returns [0, 1]."""
    best = 0.0
    ew = evidence.edge_weighted
    gm = evidence.grad_mag
    ld = evidence.lab_delta
    for dy in range(-1, 2):
        sy = py + dy
        if sy < 0 or sy >= h:
            continue
        for dx in range(-1, 2):
            sx = px + dx
            if sx < 0 or sx >= w:
                continue
            val = (
                0.4 * (float(ew[sy, sx]) / 255.0)
                + 0.35 * min(float(gm[sy, sx]) / 255.0, 1.0)
                + 0.25 * min(float(ld[sy, sx]) / 100.0, 1.0)
            )
            if val > best:
                best = val
    return best


def _snap_to_local_peak(
    px: int, py: int, evidence: BoundaryEvidence, w: int, h: int, snap_radius: int,
) -> tuple[int, int, bool]:
    """Find strongest evidence pixel within snap_radius. Returns (x, y, snapped)."""
    best_x, best_y = px, py
    best_score = -1.0
    r = snap_radius
    r2 = r * r
    for sy in range(max(0, py - r), min(h, py + r + 1)):
        for sx in range(max(0, px - r), min(w, px + r + 1)):
            ddx, ddy = sx - px, sy - py
            if ddx * ddx + ddy * ddy > r2:
                continue
            sc = (
                0.5 * (float(evidence.edge_weighted[sy, sx]) / 255.0)
                + 0.5 * min(float(evidence.grad_mag[sy, sx]) / 255.0, 1.0)
            )
            if sc > best_score:
                best_score = sc
                best_x, best_y = sx, sy
    return best_x, best_y, (best_x != px or best_y != py)


def _seed_global_stride(
    surface: NormalizedSurface, evidence: BoundaryEvidence, config: WFG3Config,
) -> list[BoundaryToken]:
    """Original global-stride seeding (preserved)."""
    ys, xs = np.where(evidence.edge_binary > 0)
    order = np.lexsort((xs, ys))
    ys, xs = ys[order], xs[order]

    step = max(1, config.token_step)
    tokens: list[BoundaryToken] = []
    token_id = 0

    for i in range(0, len(xs), step):
        tok = _make_token(token_id, int(xs[i]), int(ys[i]), surface, evidence, config)
        tokens.append(tok)
        token_id += 1

    return tokens


def _seed_uniform_scaffold(
    surface: NormalizedSurface, evidence: BoundaryEvidence, config: WFG3Config,
) -> list[BoundaryToken]:
    """Uniform scaffold seeding: fair spatial sampling with light evidence gating."""
    h, w = surface.height, surface.width
    spacing = max(4, config.scaffold_spacing_px)
    do_stagger = config.scaffold_staggered
    gate_min = config.scaffold_evidence_gate_min
    snap_r = max(0, config.scaffold_snap_radius)
    do_snap = config.scaffold_snap_enabled and snap_r > 0
    max_tokens = config.scaffold_max_tokens
    min_conf = config.token_min_confidence
    min_spacing = config.scaffold_min_spacing

    # Occupancy grid for minimum spacing enforcement
    occ_cell = max(3, min_spacing)
    occ_w = math.ceil(w / occ_cell)
    occ_h = math.ceil(h / occ_cell)
    occupied = np.zeros(occ_h * occ_w, dtype=np.uint8)

    def is_occupied(px: int, py: int) -> bool:
        gcx, gcy = px // occ_cell, py // occ_cell
        for dy in range(-1, 2):
            cy = gcy + dy
            if cy < 0 or cy >= occ_h:
                continue
            for dx in range(-1, 2):
                cx = gcx + dx
                if cx < 0 or cx >= occ_w:
                    continue
                if occupied[cy * occ_w + cx]:
                    return True
        return False

    def mark_occupied(px: int, py: int) -> None:
        gcx, gcy = px // occ_cell, py // occ_cell
        if 0 <= gcx < occ_w and 0 <= gcy < occ_h:
            occupied[gcy * occ_w + gcx] = 1

    tokens: list[BoundaryToken] = []
    token_id = 0

    def process_pass(offset_x: int, offset_y: int) -> int:
        nonlocal token_id
        count = 0
        for gy in range(offset_y, h, spacing):
            for gx in range(offset_x, w, spacing):
                if len(tokens) >= max_tokens:
                    return count

                px, py = gx, gy
                local_ev = _local_evidence_at(px, py, evidence, w, h)
                if local_ev < gate_min:
                    continue

                if do_snap:
                    px, py, _ = _snap_to_local_peak(px, py, evidence, w, h, snap_r)

                if is_occupied(px, py):
                    continue

                tok = _make_token(token_id, px, py, surface, evidence, config)
                if tok.confidence < min_conf:
                    continue

                tokens.append(tok)
                mark_occupied(px, py)
                token_id += 1
                count += 1
        return count

    process_pass(0, 0)
    if do_stagger:
        process_pass(spacing // 2, spacing // 2)

    return tokens


def run_stage_c_boundary_tokens(
    surface: NormalizedSurface,
    evidence: BoundaryEvidence,
    config: WFG3Config,
) -> list[BoundaryToken]:
    mode = config.token_seeding_mode
    if mode == "uniform_scaffold":
        return _seed_uniform_scaffold(surface, evidence, config)
    return _seed_global_stride(surface, evidence, config)
