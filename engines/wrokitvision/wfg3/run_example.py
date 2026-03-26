from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from .pipeline import run_wfg3
from .types import WFG3Config


def _make_synthetic(path: Path) -> None:
    img = np.full((780, 1100, 3), 245, dtype=np.uint8)

    cv2.rectangle(img, (70, 50), (1030, 730), (230, 230, 230), -1)
    cv2.rectangle(img, (90, 80), (620, 145), (25, 25, 25), -1)
    cv2.putText(img, "ACME SUPPLY CO.", (110, 123), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2)

    cv2.putText(img, "INVOICE # 10384", (90, 190), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (35, 35, 35), 2)
    cv2.putText(img, "DATE 2026-03-20", (90, 230), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (35, 35, 35), 2)

    for i in range(8):
        y = 300 + i * 42
        cv2.rectangle(img, (95, y - 24), (1005, y + 8), (250, 250, 250), -1)
        cv2.putText(img, f"Item {i+1} long description", (110, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (60, 60, 60), 1)
        cv2.putText(img, str(i + 1), (820, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (60, 60, 60), 1)
        cv2.putText(img, f"${(i+1)*12}.00", (900, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (60, 60, 60), 1)

    cv2.rectangle(img, (760, 640), (1010, 720), (40, 40, 40), -1)
    cv2.putText(img, "TOTAL $432.00", (780, 690), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.imwrite(str(path), img)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run WFG3 example pipeline")
    parser.add_argument("--image", type=str, default="", help="Input image path")
    parser.add_argument("--out", type=str, default="artifacts/wfg3", help="Output directory")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    image_path = Path(args.image) if args.image else out_dir / "synthetic_input.png"
    if not image_path.exists():
        _make_synthetic(image_path)

    result = run_wfg3(str(image_path), str(out_dir), WFG3Config())

    summary = {
        "image": str(image_path),
        "size": [result.normalized_surface.width, result.normalized_surface.height],
        "tokens": len(result.boundary_tokens),
        "boundary_chains": len(result.boundary_graph.chains),
        "boundary_loops": len(result.boundary_graph.loops),
        "regions": result.region_partition.region_count,
        "groups": result.group_map.group_count,
        "structure_edges": len(result.structure_graph.edges),
        "debug_outputs": result.debug.paths,
    }

    with open(out_dir / "summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
