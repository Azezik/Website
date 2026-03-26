# WFG3 Visual Processing Engine

WFG3 is a deterministic, staged visual processing pipeline that transforms an input image/document into:

1. Side-aware boundary tokens
2. A boundary connectivity graph
3. A full-image non-overlapping region partition
4. Region groups
5. A structure graph of group relationships

## Pipeline Stages

- **A. Normalization** (`stage_a_normalize.py`)
- **B. Boundary Evidence** (`stage_b_boundary_evidence.py`)
- **C. Boundary Tokens** (`stage_c_boundary_tokens.py`)
- **D. Boundary Graph** (`stage_d_boundary_graph.py`)
- **E. Region Partition** (`stage_e_region_partition.py`)
- **F. Region Grouping** (`stage_f_region_grouping.py`)
- **G. Structure Graph** (`stage_g_structure_graph.py`)
- **H. Debug Visualization** (`stage_h_debug_viz.py`)

`pipeline.py` orchestrates all stages and returns typed artifacts from `types.py`.

## Example Run

```bash
python -m engines.wrokitvision.wfg3.run_example --out artifacts/wfg3
```

If no image is supplied, the script generates a deterministic synthetic invoice-like input image.

## Outputs

- `normalized.png`
- `edge_map.png`
- `boundary_tokens.png`
- `boundary_graph.png`
- `region_map.png`
- `group_map.png`
- `structure_graph.png`
- `summary.json`

## Parameter Tuning (`WFG3Config` in `types.py`)

- `canny_low` / `canny_high`: edge sensitivity
- `lab_delta_threshold`: color-edge sensitivity in LAB space
- `token_step`: density of boundary tokens
- `graph_neighbor_radius`: token graph connectivity radius
- `min_region_area`: threshold for tiny region merge
- `grouping_coherence_threshold`: grouping strictness against texture/noise

All stages are deterministic and inspectable via artifacts written in stage H.
