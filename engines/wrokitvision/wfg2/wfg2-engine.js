(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  }
  root.WrokitFeatureGraph2 = factory();
})(typeof window !== 'undefined' ? window : globalThis, function(){
  // Schema version: bump when DEFAULT_PARAMS change to invalidate stale presets
  const PARAMS_SCHEMA_VERSION = 4;

  /* ─── Pipeline modes ─────────────────────────────────────────────
     'partition'   – Color-first partition only (Stage 1).
     'structural'  – Legacy structural-only (grid-based region growing).
     'hybrid'      – Partition first, then structural refinement pass.
     'combined'    – Show both partition and structural side-by-side. */
  const PIPELINE_MODES = Object.freeze(['partition', 'structural', 'hybrid', 'combined']);

  const DEFAULT_PARAMS = Object.freeze({
    _schemaVersion: PARAMS_SCHEMA_VERSION,
    gridSize: 8, edgeSensitivity: 28, mergeThreshold: 18,
    minRegionArea: 0.0008, fragmentationTolerance: 0.22, rectangularBiasPenalty: 0.35,
    /* Color-dominant boundary evidence: chromatic difference is the anchor signal.
       Luminance and variance are tertiary — heavily suppressed where color is present. */
    colorWeight: 0.80, luminanceWeight: 0.08, varianceWeight: 0.05,
    colorMergePenalty: 2.5,
    /* Chromatic vs luminance separation: controls how much hue/saturation
       dominates over brightness in boundary and merge decisions. */
    chromaWeight: 0.85,  // 0-1: fraction of boundary signal from chromatic (a*b*) vs luminance (L*)
    /* Color distance calibration */
    colorDistFloor: 20,      // ΔE below this is ignored (shadows, lighting gradients)
    colorDistCeiling: 50,    // ΔE at/above this produces maximum boundary signal
    colorDistGamma: 2.2,     // >1 = suppress small distances, amplify large ones
    surfaceUniformityBias: 0.70, // 0-1: how much intra-region color uniformity relaxes merge
    /* Continuity / closure (now color-informed when color data is available) */
    closureRadius: 3, closureWeight: 0.20,
    parentContourBonus: 0.25, minEnclosingArea: 0.01,

    /* ═══ Color-First Partition (Stage 1) parameters ═══ */
    pipelineMode: 'partition',                // default to partition-first
    partitionColorTolerance: 15,              // ΔE tolerance for contiguous color flood
    partitionMinRegionPixels: 64,             // minimum pixels to keep a region candidate
    partitionBoundaryContinuation: 0.6,       // 0-1: strength of boundary repair through noise
    partitionLocalRefinementRange: 8,         // pixel radius for local tolerance refinement
    /* Region scoring weights (for greedy selection) */
    partitionScoreVarianceW: 0.25,            // internal color variance (lower = better)
    partitionScoreBoundaryW: 0.25,            // boundary contrast strength
    partitionScoreContourW: 0.20,             // contour continuity
    partitionScoreClosureW: 0.15,             // closure quality
    partitionScoreLeakW: 0.15                 // leakage risk penalty
  });
  const FEEDBACK_TAGS = Object.freeze([
    'too_many_regions','too_few_regions',
    'split_object','merged_objects','shape_mismatch','missed_object',
    'color_boundary_missed','surface_fragmented'
  ]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const copyParams = (params) => ({ ...DEFAULT_PARAMS, ...(params || {}) });

  /* ─── sRGB → CIE Lab (D65) ────────────────────────────────────── */
  function srgbToLab(r8, g8, b8){
    let r = r8 / 255, g = g8 / 255, b = b8 / 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750);
    let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  /* ─── Normalization: preserve color channels alongside gray ──── */
  function normalizeVisualInput(imageData, options){
    const opts = options || {};
    const width = Number(imageData?.width) || 0;
    const height = Number(imageData?.height) || 0;
    if(width <= 0 || height <= 0) return null;
    const gray = imageData.gray || new Uint8Array(width * height);
    const targetMax = Number(opts.maxSide) || 1200;
    const scale = Math.min(1, targetMax / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const n = outW * outH;
    const outGray = new Uint8Array(n);

    // Resolve source RGB channels
    const srcRgba = imageData.rgba || imageData.data || null;
    const srcR = imageData.r || null;
    const srcG = imageData.g || null;
    const srcB = imageData.b || null;
    const hasRgb = (srcR && srcG && srcB && srcR.length >= width * height) ||
                   (srcRgba && srcRgba.length >= width * height * 4);

    const outR = hasRgb ? new Uint8Array(n) : null;
    const outG = hasRgb ? new Uint8Array(n) : null;
    const outB = hasRgb ? new Uint8Array(n) : null;

    for(let y = 0; y < outH; y++){
      const srcY = Math.min(height - 1, Math.round(y / scale));
      for(let x = 0; x < outW; x++){
        const srcX = Math.min(width - 1, Math.round(x / scale));
        const si = srcY * width + srcX;
        const di = y * outW + x;
        outGray[di] = gray[si] || 0;
        if(hasRgb){
          if(srcR){
            outR[di] = srcR[si] || 0;
            outG[di] = srcG[si] || 0;
            outB[di] = srcB[si] || 0;
          } else {
            const j = si * 4;
            outR[di] = srcRgba[j] || 0;
            outG[di] = srcRgba[j + 1] || 0;
            outB[di] = srcRgba[j + 2] || 0;
          }
        }
      }
    }

    const stretched = stretchContrast(outGray);
    const blurred = boxBlur3x3(stretched, outW, outH);

    // Build Lab channels for color-aware processing
    let labL = null, labA = null, labB = null;
    if(outR){
      labL = new Float32Array(n);
      labA = new Float32Array(n);
      labB = new Float32Array(n);
      for(let i = 0; i < n; i++){
        const lab = srgbToLab(outR[i], outG[i], outB[i]);
        labL[i] = lab.L;
        labA[i] = lab.a;
        labB[i] = lab.b;
      }
    }

    return {
      kind: 'wfg2-normalized-surface', width: outW, height: outH,
      gray: blurred,
      rgb: outR ? { r: outR, g: outG, b: outB } : null,
      lab: labL ? { L: labL, a: labA, b: labB } : null,
      source: { width, height, scale },
      artifacts: { contrastStretched: true, blurred: true, hasColor: !!outR, hasLab: !!labL }
    };
  }

  function stretchContrast(gray){
    let min = 255, max = 0;
    for(let i = 0; i < gray.length; i++){ const v = gray[i]; if(v < min) min = v; if(v > max) max = v; }
    if(max <= min + 1) return gray.slice();
    const out = new Uint8Array(gray.length);
    const span = max - min;
    for(let i = 0; i < gray.length; i++) out[i] = clamp(Math.round(((gray[i] - min) / span) * 255), 0, 255);
    return out;
  }

  function boxBlur3x3(gray, w, h){
    const out = new Uint8Array(gray.length);
    for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
      let sum = 0, count = 0;
      for(let dy = -1; dy <= 1; dy++){
        const yy = y + dy; if(yy < 0 || yy >= h) continue;
        for(let dx = -1; dx <= 1; dx++){
          const xx = x + dx; if(xx < 0 || xx >= w) continue;
          sum += gray[yy * w + xx]; count++;
        }
      }
      out[y * w + x] = Math.round(sum / Math.max(1, count));
    }
    return out;
  }

  /* ─── Gradient helpers ─────────────────────────────────────────── */
  function computeGradient(gray, w, h){
    const mag = new Uint8Array(w * h);
    for(let y = 1; y < h - 1; y++) for(let x = 1; x < w - 1; x++){
      const i = y * w + x;
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = clamp(Math.round(Math.sqrt(gx * gx + gy * gy) / 4), 0, 255);
    }
    return mag;
  }

  /* ─── Part 1: Color-aware boundary evidence ────────────────────── */

  /* Magnitude-weighted color distance → boundary strength.
     Uses a dead-zone (floor), ceiling, and gamma curve so that:
     - ΔE < floor  → 0  (lighting noise, shadow variation)
     - ΔE ≥ ceiling → 1  (strong object boundary)
     - In between   → non-linear ramp that suppresses small distances
                       and amplifies large ones (gamma > 1).            */
  function colorDistToStrength(de, floor, ceiling, gamma){
    if(de <= floor) return 0;
    if(de >= ceiling) return 1;
    const t = (de - floor) / (ceiling - floor); // 0-1 linear
    return Math.pow(t, gamma);                   // gamma curve
  }

  /* Compute chromatic-dominant color distance between two Lab pixels.
     Separates chromatic difference (Δa, Δb) from luminance difference (ΔL)
     and weights chromatic change much higher.  This prevents shading/lighting
     gradients (L-only changes) from producing false boundaries. */
  function chromaDominantDeltaE(L1, a1, b1, L2, a2, b2, chromaW){
    const da = a1 - a2, db = b1 - b2;
    const dChroma = Math.sqrt(da * da + db * db);
    const dL = Math.abs(L1 - L2);
    // Chromatic distance is the dominant signal; luminance is attenuated
    return dChroma * chromaW + dL * (1 - chromaW);
  }

  function computeColorBoundary(lab, w, h, params){
    if(!lab) return null;
    const p = params || {};
    const floor    = p.colorDistFloor   ?? 20;
    const ceiling  = p.colorDistCeiling ?? 50;
    const gamma    = p.colorDistGamma   ?? 2.2;
    const chromaW  = clamp(p.chromaWeight ?? 0.85, 0, 1);
    const out = new Float32Array(w * h);
    const L = lab.L, a = lab.a, b = lab.b;
    for(let y = 1; y < h - 1; y++) for(let x = 1; x < w - 1; x++){
      const i = y * w + x;
      // Max chromatic-dominant ΔE across 4-connected neighbors
      let maxDelta = 0;
      const nbrs = [i - 1, i + 1, i - w, i + w];
      for(const ni of nbrs){
        const de = chromaDominantDeltaE(L[i], a[i], b[i], L[ni], a[ni], b[ni], chromaW);
        if(de > maxDelta) maxDelta = de;
      }
      out[i] = colorDistToStrength(maxDelta, floor, ceiling, gamma);
    }
    return out;
  }

  /* Per-cell color statistics in Lab space, including intra-cell color
     variance (used for surface uniformity reasoning). */
  function computeCellLabStats(cells, lab, w){
    if(!lab) return;
    const L = lab.L, a = lab.a, b = lab.b;
    for(const cell of cells){
      let sumL = 0, sumA = 0, sumB = 0, cnt = 0;
      let sumL2 = 0, sumA2 = 0, sumB2 = 0;
      for(let y = cell.y0; y < cell.y1; y++) for(let x = cell.x0; x < cell.x1; x++){
        const pi = y * w + x;
        const vL = L[pi], vA = a[pi], vB = b[pi];
        sumL += vL; sumA += vA; sumB += vB;
        sumL2 += vL * vL; sumA2 += vA * vA; sumB2 += vB * vB;
        cnt++;
      }
      const n = Math.max(1, cnt);
      cell.meanL = sumL / n;
      cell.meanA = sumA / n;
      cell.meanB = sumB / n;
      // Intra-cell color variance: low = uniform surface, high = textured/mixed
      const varL = Math.max(0, sumL2 / n - cell.meanL * cell.meanL);
      const varA = Math.max(0, sumA2 / n - cell.meanA * cell.meanA);
      const varB = Math.max(0, sumB2 / n - cell.meanB * cell.meanB);
      // Combined color standard deviation (Euclidean in Lab)
      cell.colorStdDev = Math.sqrt(varL + varA + varB);
    }
  }

  /* ─── Part 2: Continuity / Closure evidence ────────────────────── */

  /* Morphological dilation of a binary edge map (3x3 square structuring element),
     repeated `radius` times.  This bridges small gaps in contours. */
  function dilate(map, w, h, radius){
    let src = map;
    for(let pass = 0; pass < radius; pass++){
      const dst = new Uint8Array(w * h);
      for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
        let v = 0;
        for(let dy = -1; dy <= 1; dy++){
          const yy = y + dy; if(yy < 0 || yy >= h) continue;
          for(let dx = -1; dx <= 1; dx++){
            const xx = x + dx; if(xx < 0 || xx >= w) continue;
            if(src[yy * w + xx]) { v = 1; break; }
          }
          if(v) break;
        }
        dst[y * w + x] = v;
      }
      src = dst;
    }
    return src;
  }

  /* Morphological erosion (3x3 square), repeated `radius` times. */
  function erode(map, w, h, radius){
    let src = map;
    for(let pass = 0; pass < radius; pass++){
      const dst = new Uint8Array(w * h);
      for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
        let all = 1;
        for(let dy = -1; dy <= 1; dy++){
          const yy = y + dy; if(yy < 0 || yy >= h){ all = 0; break; }
          for(let dx = -1; dx <= 1; dx++){
            const xx = x + dx; if(xx < 0 || xx >= w){ all = 0; break; }
            if(!src[yy * w + xx]){ all = 0; break; }
          }
          if(!all) break;
        }
        dst[y * w + x] = all;
      }
      src = dst;
    }
    return src;
  }

  /* Morphological closing = dilate then erode.  Bridges small gaps in edge
     maps, producing closure evidence that favors continuous contours. */
  function morphClose(edgeMap, w, h, radius){
    return erode(dilate(edgeMap, w, h, radius), w, h, radius);
  }

  /* Build a closure-evidence map.  When color boundaries are available they
     are used as the primary edge source (much cleaner than luminance gradient
     on synthetic / colored-shape scenes).  The luminance gradient is used as
     a fallback only where color evidence is absent or weak. */
  function buildClosureEvidence(grad, w, h, params, colorBoundary){
    const p = copyParams(params);
    const radius = clamp(Math.round(p.closureRadius), 1, 8);

    // Build a fused edge map: prefer color boundary, fall back to luminance
    const binary = new Uint8Array(w * h);
    if(colorBoundary){
      // Color boundary is Float32 0-1.  Use a higher threshold (0.25) so that
      // only meaningful chromatic transitions produce closure edges.  Shading
      // gradients (which produce low color boundary values) are excluded.
      // Luminance fallback is restricted to areas with zero color evidence and
      // requires a very strong gradient to prevent shading artifacts.
      const sorted = Array.from(grad).sort((a, b) => b - a);
      const lumCutoff = Math.max(20, sorted[Math.floor(sorted.length * 0.15)] || 25);
      for(let i = 0; i < binary.length; i++){
        if(colorBoundary[i] >= 0.25){
          binary[i] = 1;
        } else if(colorBoundary[i] < 0.05 && grad[i] >= lumCutoff){
          binary[i] = 1; // luminance fallback only in truly color-silent areas
        }
      }
    } else {
      // No color data — original luminance-only path
      const sorted = Array.from(grad).sort((a, b) => b - a);
      const cutoff = Math.max(8, sorted[Math.floor(sorted.length * 0.30)] || 15);
      for(let i = 0; i < grad.length; i++) binary[i] = grad[i] >= cutoff ? 1 : 0;
    }
    const closed = morphClose(binary, w, h, radius);
    return closed; // Uint8Array, 0 or 1
  }

  /* Flood-fill to find enclosed regions in the closure map.
     Returns an array of { area, bbox, enclosedPixels } for regions fully
     surrounded by closed contour edges. */
  function findEnclosedRegions(closureMap, w, h, minAreaFraction){
    const labels = new Int32Array(w * h).fill(-1);
    const regions = [];
    let nextId = 0;
    const minArea = Math.max(25, Math.round(w * h * minAreaFraction));

    for(let i = 0; i < closureMap.length; i++){
      if(closureMap[i] || labels[i] >= 0) continue;
      // Flood-fill this non-edge region
      const id = nextId++;
      const queue = [i];
      labels[i] = id;
      let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      let touchesBorder = false;
      while(queue.length){
        const idx = queue.pop();
        area++;
        const x = idx % w, y = (idx / w) | 0;
        if(x < x0) x0 = x; if(y < y0) y0 = y;
        if(x > x1) x1 = x; if(y > y1) y1 = y;
        if(x === 0 || x === w - 1 || y === 0 || y === h - 1) touchesBorder = true;
        const nbrs = [idx - 1, idx + 1, idx - w, idx + w];
        for(const ni of nbrs){
          if(ni < 0 || ni >= w * h) continue;
          const nx = ni % w, ny = (ni / w) | 0;
          if(Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
          if(labels[ni] >= 0 || closureMap[ni]) continue;
          labels[ni] = id;
          queue.push(ni);
        }
      }
      regions.push({ id, area, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, touchesBorder });
    }

    // Enclosed = does not touch image border and meets minimum area
    return regions.filter(r => !r.touchesBorder && r.area >= minArea);
  }

  /* Build a per-pixel "closure confidence" float map.  Pixels inside enclosed
     contours get a boost; pixels on strong closed edges also get a boost. */
  function buildClosureConfidence(closureMap, enclosedRegions, grad, w, h){
    const conf = new Float32Array(w * h);
    // Mark closure-edge pixels
    for(let i = 0; i < closureMap.length; i++){
      if(closureMap[i]) conf[i] = 0.3;
    }
    // Boost enclosed interior pixels
    // Re-flood to mark which pixel belongs to which enclosed region
    if(enclosedRegions.length > 0){
      const enclosed = new Int32Array(w * h).fill(-1);
      for(const reg of enclosedRegions){
        const bx0 = reg.bbox.x, by0 = reg.bbox.y;
        const bx1 = bx0 + reg.bbox.w, by1 = by0 + reg.bbox.h;
        // Simple flood from region's bbox interior
        for(let y = by0; y < by1 && y < h; y++) for(let x = bx0; x < bx1 && x < w; x++){
          const idx = y * w + x;
          if(!closureMap[idx] && enclosed[idx] < 0){
            enclosed[idx] = reg.id;
            conf[idx] = Math.max(conf[idx], 0.6);
          }
        }
      }
    }
    return conf;
  }

  /* ─── Combined boundary evidence (color-primary architecture) ───
     Color evidence is the primary structural signal.  Luminance gradient and
     local variance are secondary — they only contribute significantly where
     color evidence is absent or weak.  This prevents noisy luminance/variance
     edges from corrupting the boundary map on scenes where color is clean. */
  function buildCombinedBoundaryEvidence(gray, lab, grad, colorBoundary, closureMap, w, h, params){
    const p = copyParams(params);
    const evidence = new Uint8Array(w * h);
    const wColor = clamp(p.colorWeight, 0, 1);
    const wLum = clamp(p.luminanceWeight, 0, 1);
    const wVar = clamp(p.varianceWeight, 0, 1);
    const wClosure = clamp(p.closureWeight, 0, 1);
    const hasColor = !!colorBoundary;

    for(let i = 0; i < evidence.length; i++){
      const lumEdge = grad[i] / 255;
      const colEdge = hasColor ? colorBoundary[i] : 0;
      const closureBit = closureMap ? closureMap[i] : 0;

      // Compute local variance inline (3x3 window)
      const x = i % w, y = (i / w) | 0;
      let sum = 0, sumSq = 0, cnt = 0;
      for(let dy = -1; dy <= 1; dy++){
        const yy = y + dy; if(yy < 0 || yy >= h) continue;
        for(let dx = -1; dx <= 1; dx++){
          const xx = x + dx; if(xx < 0 || xx >= w) continue;
          const v = gray[yy * w + xx]; sum += v; sumSq += v * v; cnt++;
        }
      }
      const meanV = sum / Math.max(1, cnt);
      const varV = Math.sqrt(Math.max(0, (sumSq / Math.max(1, cnt)) - (meanV * meanV))) / 64;
      const varNorm = Math.min(1, varV);

      // Color-dominant: chromatic color evidence is the anchor signal.
      const colSq = colEdge * colEdge; // 0-1, strongly non-linear

      // Aggressive secondary suppression: when ANY color data is available,
      // luminance & variance are near-zero contributors.  They only have
      // meaningful influence when no color data exists at all.
      // This prevents shading/lighting gradients from producing false edges.
      const colorPresence = hasColor ? clamp(colEdge * 6, 0, 1) : 0; // 0-1 aggressive soft gate
      const secondaryDamp = 1 - colorPresence * 0.95; // 1.0 when no color → 0.05 when strong color
      // Even when color is absent at this pixel, if color data exists globally,
      // still attenuate luminance to prevent shading artifacts inside objects.
      const globalColorDamp = hasColor ? 0.3 : 1.0;
      const lumContrib  = lumEdge  * wLum * secondaryDamp * globalColorDamp;
      const varContrib  = varNorm  * wVar * secondaryDamp * globalColorDamp;

      const edgeSignal = colSq * wColor + lumContrib + varContrib;
      // Closure boosts edge evidence where morphological closing bridged gaps
      const closureBoost = closureBit ? wClosure * secondaryDamp * globalColorDamp : 0;
      evidence[i] = clamp(Math.round(Math.min(1, edgeSignal + closureBoost) * 255), 0, 255);
    }
    return evidence;
  }

  /* ═══════════════════════════════════════════════════════════════════
     STAGE 1: COLOR-FIRST REGION PARTITION
     ═══════════════════════════════════════════════════════════════════
     Produces a non-overlapping, pixel-level partition where:
       - Every pixel belongs to exactly one region
       - Boundaries are shared between adjacent regions
       - No overlapping region proposals
     Uses a greedy, masked extraction pipeline:
       1. Initial contiguous color flood segmentation
       2. Score all candidate regions
       3. Lock highest-confidence region
       4. Locally refine tolerance at boundaries
       5. Mask committed pixels from further competition
       6. Refine neighbor boundaries against committed region
       7. Repeat until full partition achieved                        */

  function computePartition(surface, params){
    const p = copyParams(params);
    const w = surface.width, h = surface.height;
    const n = w * h;
    const lab = surface.lab;
    const gray = surface.gray;
    const hasColor = !!lab;

    // Per-pixel label map: -1 = unassigned
    const labelMap = new Int32Array(n).fill(-1);
    // Region data store
    const regions = [];
    let nextRegionId = 0;

    // Compute color boundary map for scoring
    const colorBoundary = hasColor ? computeColorBoundary(lab, w, h, p) : null;

    // Compute gradient for boundary contrast scoring
    const grad = computeGradient(gray, w, h);

    const baseTolerance = p.partitionColorTolerance;
    const minPixels = Math.max(4, p.partitionMinRegionPixels);
    const refinementRange = Math.max(1, p.partitionLocalRefinementRange);
    const continuationStrength = clamp(p.partitionBoundaryContinuation, 0, 1);

    // ── A. Initial pass: flood-fill contiguous color regions ──
    // Produces candidate regions with medium tolerance
    function floodFillColor(startIdx, tolerance, mask){
      if(mask[startIdx]) return null;
      const queue = [startIdx];
      const pixels = [];
      const visited = new Uint8Array(n);
      visited[startIdx] = 1;

      // Seed color (Lab or gray)
      let seedL, seedA, seedB, seedGray;
      if(hasColor){
        seedL = lab.L[startIdx]; seedA = lab.a[startIdx]; seedB = lab.b[startIdx];
      }
      seedGray = gray[startIdx];

      // Running mean for color drift prevention
      let sumL = 0, sumA = 0, sumB = 0, cnt = 0;

      while(queue.length > 0){
        const idx = queue.pop();
        if(mask[idx]) continue;
        pixels.push(idx);

        if(hasColor){
          sumL += lab.L[idx]; sumA += lab.a[idx]; sumB += lab.b[idx];
        }
        cnt++;

        const x = idx % w, y = (idx / w) | 0;
        // 4-connected neighbors
        const nbrs = [];
        if(x > 0) nbrs.push(idx - 1);
        if(x < w - 1) nbrs.push(idx + 1);
        if(y > 0) nbrs.push(idx - w);
        if(y < h - 1) nbrs.push(idx + w);

        // Current region mean (prevents drift)
        const meanL = sumL / cnt, meanA = sumA / cnt, meanB = sumB / cnt;

        for(const ni of nbrs){
          if(visited[ni] || mask[ni]) continue;

          let dist;
          if(hasColor){
            const chromaW = clamp(p.chromaWeight, 0, 1);
            // Distance to both seed and running mean (prevents color drift)
            const dSeed = chromaDominantDeltaE(lab.L[ni], lab.a[ni], lab.b[ni], seedL, seedA, seedB, chromaW);
            const dMean = chromaDominantDeltaE(lab.L[ni], lab.a[ni], lab.b[ni], meanL, meanA, meanB, chromaW);
            dist = Math.max(dSeed, dMean);
          } else {
            dist = Math.abs(gray[ni] - seedGray);
          }

          if(dist <= tolerance){
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }

      if(pixels.length < minPixels) return null;
      return pixels;
    }

    // ── B. Region scoring ──
    function scoreRegion(pixels){
      const numPx = pixels.length;
      if(numPx < minPixels) return -1;

      const wVar = p.partitionScoreVarianceW;
      const wBnd = p.partitionScoreBoundaryW;
      const wCont = p.partitionScoreContourW;
      const wClos = p.partitionScoreClosureW;
      const wLeak = p.partitionScoreLeakW;

      // Internal color variance (lower is better)
      let sumL = 0, sumA = 0, sumB = 0, sumL2 = 0, sumA2 = 0, sumB2 = 0;
      if(hasColor){
        for(const idx of pixels){
          const vL = lab.L[idx], vA = lab.a[idx], vB = lab.b[idx];
          sumL += vL; sumA += vA; sumB += vB;
          sumL2 += vL * vL; sumA2 += vA * vA; sumB2 += vB * vB;
        }
        const mn = numPx;
        const varL = Math.max(0, sumL2 / mn - (sumL / mn) * (sumL / mn));
        const varA = Math.max(0, sumA2 / mn - (sumA / mn) * (sumA / mn));
        const varB = Math.max(0, sumB2 / mn - (sumB / mn) * (sumB / mn));
        var internalVariance = Math.sqrt(varL + varA + varB);
      } else {
        let sumG = 0, sumG2 = 0;
        for(const idx of pixels){ const v = gray[idx]; sumG += v; sumG2 += v * v; }
        internalVariance = Math.sqrt(Math.max(0, sumG2 / numPx - (sumG / numPx) * (sumG / numPx)));
      }
      // Normalize: 0 variance = 1.0 score, high variance = 0 score
      const varianceScore = clamp(1 - internalVariance / 40, 0, 1);

      // Boundary contrast: average color boundary strength at region border pixels
      let boundarySum = 0, boundaryCount = 0;
      const pixSet = new Set(pixels);
      for(const idx of pixels){
        const x = idx % w, y = (idx / w) | 0;
        const nbrs = [];
        if(x > 0) nbrs.push(idx - 1);
        if(x < w - 1) nbrs.push(idx + 1);
        if(y > 0) nbrs.push(idx - w);
        if(y < h - 1) nbrs.push(idx + w);
        let isBorder = false;
        for(const ni of nbrs){
          if(!pixSet.has(ni)){ isBorder = true; break; }
        }
        if(isBorder){
          boundarySum += colorBoundary ? colorBoundary[idx] : (grad[idx] / 255);
          boundaryCount++;
        }
      }
      const boundaryScore = boundaryCount > 0 ? clamp(boundarySum / boundaryCount, 0, 1) : 0;

      // Contour continuity: fraction of border pixels with strong boundary evidence
      let contiguousBoundary = 0;
      if(boundaryCount > 0){
        let strongCount = 0;
        for(const idx of pixels){
          const x = idx % w, y = (idx / w) | 0;
          const nbrs = [];
          if(x > 0) nbrs.push(idx - 1);
          if(x < w - 1) nbrs.push(idx + 1);
          if(y > 0) nbrs.push(idx - w);
          if(y < h - 1) nbrs.push(idx + w);
          let isBorder = false;
          for(const ni of nbrs){ if(!pixSet.has(ni)){ isBorder = true; break; } }
          if(isBorder){
            const ev = colorBoundary ? colorBoundary[idx] : (grad[idx] / 255);
            if(ev > 0.2) strongCount++;
          }
        }
        contiguousBoundary = strongCount / boundaryCount;
      }
      const contourScore = clamp(contiguousBoundary, 0, 1);

      // Closure quality: compactness (area vs perimeter^2)
      const perimeter = boundaryCount;
      const compactness = perimeter > 0 ? (4 * Math.PI * numPx) / (perimeter * perimeter) : 0;
      const closureScore = clamp(compactness, 0, 1);

      // Leakage risk: if region touches image border excessively
      let borderTouch = 0;
      for(const idx of pixels){
        const x = idx % w, y = (idx / w) | 0;
        if(x === 0 || x === w - 1 || y === 0 || y === h - 1) borderTouch++;
      }
      const leakScore = clamp(1 - (borderTouch / Math.max(1, perimeter)) * 2, 0, 1);

      // Weighted composite score + area bonus (larger regions preferred)
      const areaBonus = clamp(Math.log2(numPx) / 16, 0, 0.3);
      const score = varianceScore * wVar + boundaryScore * wBnd + contourScore * wCont + closureScore * wClos + leakScore * wLeak + areaBonus;

      return score;
    }

    // ── D. Local tolerance refinement ──
    function refineTolerance(seedIdx, mask){
      let bestTol = baseTolerance;
      let bestScore = -1;
      let bestPixels = null;

      // Search tolerance in a range around the base
      const steps = [baseTolerance * 0.6, baseTolerance * 0.8, baseTolerance, baseTolerance * 1.2, baseTolerance * 1.5];
      for(const tol of steps){
        const pixels = floodFillColor(seedIdx, tol, mask);
        if(!pixels) continue;
        const score = scoreRegion(pixels);
        if(score > bestScore){
          bestScore = score;
          bestTol = tol;
          bestPixels = pixels;
        }
      }
      return { tolerance: bestTol, score: bestScore, pixels: bestPixels };
    }

    // ── E-F. Boundary continuation / repair ──
    // After committing a region, repair short corrupted boundary spans
    // by checking if boundary pixels have clean neighbors on both sides
    function repairBoundaries(regionPixels, regionId){
      if(continuationStrength <= 0) return;
      const pixSet = new Set(regionPixels);
      const repairRadius = Math.max(1, Math.round(refinementRange * continuationStrength));

      // Find boundary pixels of the committed region
      for(const idx of regionPixels){
        const x = idx % w, y = (idx / w) | 0;
        // Check 4-connected neighbors that are unassigned
        const nbrs = [];
        if(x > 0) nbrs.push(idx - 1);
        if(x < w - 1) nbrs.push(idx + 1);
        if(y > 0) nbrs.push(idx - w);
        if(y < h - 1) nbrs.push(idx + w);

        for(const ni of nbrs){
          if(labelMap[ni] !== -1) continue; // already assigned
          // Check if this unassigned pixel is a short noise gap
          // (clean region on both sides of a small gap)
          if(hasColor){
            const chromaW = clamp(p.chromaWeight, 0, 1);
            // Mean color of region
            const rMeanL = regionMeans[regionId].L;
            const rMeanA = regionMeans[regionId].A;
            const rMeanB = regionMeans[regionId].B;
            const dist = chromaDominantDeltaE(lab.L[ni], lab.a[ni], lab.b[ni], rMeanL, rMeanA, rMeanB, chromaW);
            // If the gap pixel is very close in color, absorb it
            if(dist <= baseTolerance * (0.5 + continuationStrength * 0.8)){
              // Check that it's a short gap: at least 2 committed neighbors
              let committedNeighbors = 0;
              const nx = ni % w, ny = (ni / w) | 0;
              if(nx > 0 && labelMap[ni - 1] === regionId) committedNeighbors++;
              if(nx < w - 1 && labelMap[ni + 1] === regionId) committedNeighbors++;
              if(ny > 0 && labelMap[ni - w] === regionId) committedNeighbors++;
              if(ny < h - 1 && labelMap[ni + w] === regionId) committedNeighbors++;
              if(committedNeighbors >= 2){
                labelMap[ni] = regionId;
                regionPixels.push(ni);
              }
            }
          }
        }
      }
    }

    // Region mean color storage for boundary repair
    const regionMeans = {};

    // ── MAIN PARTITION LOOP ──
    // Mask of committed pixels (1 = committed)
    const committed = new Uint8Array(n);

    // Phase 1: Generate all initial flood candidates
    const candidates = [];
    // Sample seed points on a grid for efficiency
    const seedStep = Math.max(2, Math.round(Math.sqrt(n / 2000)));
    for(let sy = 0; sy < h; sy += seedStep){
      for(let sx = 0; sx < w; sx += seedStep){
        const si = sy * w + sx;
        if(committed[si]) continue;
        const pixels = floodFillColor(si, baseTolerance, committed);
        if(pixels){
          const score = scoreRegion(pixels);
          if(score > 0) candidates.push({ seedIdx: si, pixels, score });
        }
      }
    }

    // Sort by score descending (greedy: best first)
    candidates.sort((a, b) => b.score - a.score);

    // Phase 2: Greedy commit loop
    for(const cand of candidates){
      // Re-check: if seed is already committed, skip
      if(committed[cand.seedIdx]) continue;

      // D. Local tolerance refinement on the seed
      const refined = refineTolerance(cand.seedIdx, committed);
      if(!refined.pixels || refined.score <= 0) continue;

      // E. Mask commitment: lock region, remove pixels from competition
      const regionId = nextRegionId++;
      const regionPixels = refined.pixels;

      // Compute and store region mean color
      if(hasColor){
        let sL = 0, sA = 0, sB = 0;
        for(const idx of regionPixels){
          sL += lab.L[idx]; sA += lab.a[idx]; sB += lab.b[idx];
        }
        const cnt = regionPixels.length;
        regionMeans[regionId] = { L: sL / cnt, A: sA / cnt, B: sB / cnt };
      }

      for(const idx of regionPixels){
        if(committed[idx]) continue; // pixel may have been taken by a prior candidate
        labelMap[idx] = regionId;
        committed[idx] = 1;
      }

      // F. Boundary repair
      repairBoundaries(regionPixels, regionId);

      // Count actual pixels assigned to this region (some may have been pre-committed)
      let actualCount = 0;
      for(let i = 0; i < n; i++) if(labelMap[i] === regionId) actualCount++;

      if(actualCount < minPixels){
        // Too small after commitment conflicts — unmark
        for(let i = 0; i < n; i++) if(labelMap[i] === regionId) labelMap[i] = -1;
        continue;
      }

      // Build region bbox and contour
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for(let i = 0; i < n; i++){
        if(labelMap[i] !== regionId) continue;
        const x = i % w, y = (i / w) | 0;
        if(x < x0) x0 = x; if(y < y0) y0 = y;
        if(x > x1) x1 = x; if(y > y1) y1 = y;
      }

      regions.push({
        id: regionId,
        score: refined.score,
        tolerance: refined.tolerance,
        pixelCount: actualCount,
        bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
        meanColor: regionMeans[regionId] || null
      });
    }

    // Phase 3: Assign remaining unassigned pixels to nearest committed neighbor
    let changed = true;
    let passCount = 0;
    while(changed && passCount < 50){
      changed = false;
      passCount++;
      for(let i = 0; i < n; i++){
        if(labelMap[i] !== -1) continue;
        const x = i % w, y = (i / w) | 0;
        // Find nearest committed neighbor
        let bestLabel = -1, bestDist = Infinity;
        const nbrs = [];
        if(x > 0) nbrs.push(i - 1);
        if(x < w - 1) nbrs.push(i + 1);
        if(y > 0) nbrs.push(i - w);
        if(y < h - 1) nbrs.push(i + w);
        for(const ni of nbrs){
          if(labelMap[ni] === -1) continue;
          let dist;
          if(hasColor){
            const rm = regionMeans[labelMap[ni]];
            if(rm){
              const chromaW = clamp(p.chromaWeight, 0, 1);
              dist = chromaDominantDeltaE(lab.L[i], lab.a[i], lab.b[i], rm.L, rm.A, rm.B, chromaW);
            } else {
              dist = 0;
            }
          } else {
            dist = Math.abs(gray[i] - gray[ni]);
          }
          if(dist < bestDist){ bestDist = dist; bestLabel = labelMap[ni]; }
        }
        if(bestLabel !== -1){
          labelMap[i] = bestLabel;
          changed = true;
        }
      }
    }

    // If any pixels still unassigned (isolated), assign to region 0 or create background
    for(let i = 0; i < n; i++){
      if(labelMap[i] === -1){
        labelMap[i] = regions.length > 0 ? regions[0].id : 0;
      }
    }

    // Build shared boundary map
    const sharedBoundaries = new Uint8Array(n);
    for(let y = 0; y < h; y++){
      for(let x = 0; x < w; x++){
        const i = y * w + x;
        const myLabel = labelMap[i];
        if(x < w - 1 && labelMap[i + 1] !== myLabel) sharedBoundaries[i] = 1;
        if(y < h - 1 && labelMap[i + w] !== myLabel) sharedBoundaries[i] = 1;
      }
    }

    // Build adjacency from shared boundaries
    const adjSet = new Set();
    for(let y = 0; y < h; y++){
      for(let x = 0; x < w; x++){
        const i = y * w + x;
        const myLabel = labelMap[i];
        if(x < w - 1 && labelMap[i + 1] !== myLabel){
          const pair = Math.min(myLabel, labelMap[i + 1]) + ':' + Math.max(myLabel, labelMap[i + 1]);
          adjSet.add(pair);
        }
        if(y < h - 1 && labelMap[i + w] !== myLabel){
          const pair = Math.min(myLabel, labelMap[i + w]) + ':' + Math.max(myLabel, labelMap[i + w]);
          adjSet.add(pair);
        }
      }
    }
    const adjacency = [];
    for(const pair of adjSet){
      const parts = pair.split(':');
      adjacency.push({ from: Number(parts[0]), to: Number(parts[1]) });
    }

    // Build final region nodes with full metadata
    const partitionNodes = [];
    for(const reg of regions){
      // Compute contour (convex hull of border pixels)
      const borderPoints = [];
      for(let i = 0; i < n; i++){
        if(labelMap[i] !== reg.id) continue;
        const x = i % w, y = (i / w) | 0;
        if(sharedBoundaries[i]){
          borderPoints.push([x, y]);
        }
      }
      // If no border points (fully interior), use bbox corners
      if(borderPoints.length < 3){
        borderPoints.push([reg.bbox.x, reg.bbox.y]);
        borderPoints.push([reg.bbox.x + reg.bbox.w, reg.bbox.y]);
        borderPoints.push([reg.bbox.x + reg.bbox.w, reg.bbox.y + reg.bbox.h]);
        borderPoints.push([reg.bbox.x, reg.bbox.y + reg.bbox.h]);
      }
      const contourPts = hull(borderPoints).map(p => ({ x: p[0], y: p[1] }));

      // Surface uniformity from region mean color
      let surfaceUniformity = 0.5;
      if(hasColor && reg.meanColor){
        let sumStd = 0;
        let stdCnt = 0;
        for(let i = 0; i < n; i++){
          if(labelMap[i] !== reg.id) continue;
          const dL = lab.L[i] - reg.meanColor.L;
          const dA = lab.a[i] - reg.meanColor.A;
          const dB = lab.b[i] - reg.meanColor.B;
          sumStd += Math.sqrt(dL * dL + dA * dA + dB * dB);
          stdCnt++;
        }
        const avgDev = stdCnt > 0 ? sumStd / stdCnt : 0;
        surfaceUniformity = clamp(1 - avgDev / 20, 0, 1);
      }

      // Color confidence: chroma magnitude of region mean
      let colorConfidence = 0;
      if(reg.meanColor){
        const chroma = Math.sqrt(reg.meanColor.A * reg.meanColor.A + reg.meanColor.B * reg.meanColor.B);
        colorConfidence = clamp(chroma / 40, 0, 1);
      }

      partitionNodes.push({
        id: 'wfg2-p-' + reg.id,
        type: 'partition_region',
        partitionId: reg.id,
        bbox: reg.bbox,
        center: { x: reg.bbox.x + reg.bbox.w * 0.5, y: reg.bbox.y + reg.bbox.h * 0.5 },
        area: reg.pixelCount,
        contour: contourPts,
        confidence: clamp(reg.score, 0, 1),
        tolerance: reg.tolerance,
        commitOrder: regions.indexOf(reg),
        surfaceUniformity,
        colorConfidence,
        closureScore: 0, // computed from contour compactness
        compactness: contourPts.length > 0 ? clamp((4 * Math.PI * reg.pixelCount) / (contourPts.length * contourPts.length * 4), 0, 1) : 0
      });
    }

    // Build adjacency edges with partition IDs mapped to node IDs
    const idLookup = {};
    for(const node of partitionNodes) idLookup[node.partitionId] = node.id;
    const partitionEdges = [];
    for(const adj of adjacency){
      const fromId = idLookup[adj.from];
      const toId = idLookup[adj.to];
      if(fromId && toId){
        partitionEdges.push({ from: fromId, to: toId, kind: 'shared_boundary', distance: 0 });
      }
    }

    return {
      labelMap,
      sharedBoundaries,
      nodes: partitionNodes,
      edges: partitionEdges,
      adjacency,
      regionCount: regions.length
    };
  }

  /* ─── Legacy structural region growing (grid-based) ─────────── */
  function runStructuralPipeline(normalizedSurface, p){
    const w = normalizedSurface.width, h = normalizedSurface.height;
    const gray = normalizedSurface.gray;
    const lab = normalizedSurface.lab || null;
    const grad = computeGradient(gray, w, h);
    const colorBoundary = computeColorBoundary(lab, w, h, p);
    const closureMap = buildClosureEvidence(grad, w, h, p, colorBoundary);
    const enclosedRegions = findEnclosedRegions(closureMap, w, h, p.minEnclosingArea);
    const closureConf = buildClosureConfidence(closureMap, enclosedRegions, grad, w, h);
    const combinedEvidence = buildCombinedBoundaryEvidence(
      gray, lab, grad, colorBoundary, closureMap, w, h, p
    );

    const grid = Math.max(4, Math.round(p.gridSize));
    const cols = Math.ceil(w / grid), rows = Math.ceil(h / grid);
    const cells = new Array(cols * rows);
    for(let cy = 0; cy < rows; cy++) for(let cx = 0; cx < cols; cx++){
      const idx = cy * cols + cx;
      let sumGray = 0, sumGrad = 0, sumEvid = 0, sumClosure = 0, sumColorBnd = 0, count = 0;
      const x0 = cx * grid, y0 = cy * grid, x1 = Math.min(w, x0 + grid), y1 = Math.min(h, y0 + grid);
      for(let y = y0; y < y1; y++) for(let x = x0; x < x1; x++){
        const pi = y * w + x;
        sumGray += gray[pi]; sumGrad += grad[pi]; sumEvid += combinedEvidence[pi];
        sumClosure += closureConf[pi];
        sumColorBnd += colorBoundary ? colorBoundary[pi] : 0;
        count++;
      }
      cells[idx] = {
        idx, cx, cy, x0, y0, x1, y1,
        meanGray: sumGray / Math.max(1, count),
        meanGrad: sumGrad / Math.max(1, count),
        meanEvidence: sumEvid / Math.max(1, count),
        meanClosure: sumClosure / Math.max(1, count),
        meanColorBoundary: sumColorBnd / Math.max(1, count)
      };
    }
    if(lab) computeCellLabStats(cells, lab, w);

    const visited = new Uint8Array(cells.length);
    const rawRegions = [];
    const neighbors = [[1,0],[-1,0],[0,1],[0,-1]];

    for(let i = 0; i < cells.length; i++){
      if(visited[i]) continue;
      const seed = cells[i], queue = [seed], memberIdx = [];
      visited[i] = 1;
      while(queue.length){
        const cell = queue.pop();
        memberIdx.push(cell.idx);
        for(const n of neighbors){
          const nx = cell.cx + n[0], ny = cell.cy + n[1];
          if(nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if(visited[ni]) continue;
          const c2 = cells[ni];
          const chromaW = clamp(p.chromaWeight ?? 0.85, 0, 1);
          let colorDist = 0, colorStrength = 0;
          if(lab && seed.meanL !== undefined){
            const deSeed = chromaDominantDeltaE(c2.meanL, c2.meanA, c2.meanB, seed.meanL, seed.meanA, seed.meanB, chromaW);
            const deLocal = chromaDominantDeltaE(c2.meanL, c2.meanA, c2.meanB, cell.meanL, cell.meanA, cell.meanB, chromaW);
            colorDist = Math.max(deSeed, deLocal);
            colorStrength = colorDistToStrength(colorDist, p.colorDistFloor, p.colorDistCeiling, p.colorDistGamma);
          }
          const uBias = clamp(p.surfaceUniformityBias, 0, 1);
          let uniformityRelax = 1.0;
          if(uBias > 0 && cell.colorStdDev !== undefined && c2.colorStdDev !== undefined){
            const avgStdDev = (cell.colorStdDev + c2.colorStdDev) * 0.5;
            uniformityRelax = 1 + clamp(1 - avgStdDev / 12, 0, 1) * uBias;
          }
          const closureRelax = (cell.meanClosure > 0.4 && c2.meanClosure > 0.4) ? 1.3 : 1.0;
          const effectiveFloor = p.colorDistFloor * uniformityRelax * closureRelax;
          if(lab && seed.meanL !== undefined && colorDist <= effectiveFloor){
            visited[ni] = 1; queue.push(c2);
          } else {
            const colorBarrier = colorStrength * colorStrength * p.colorMergePenalty;
            const toneDiff = Math.abs(c2.meanGray - seed.meanGray) * (1 - chromaW);
            const evidBarrier = colorBoundary ? (c2.meanColorBoundary + cell.meanColorBoundary) * 0.5 * 255 : (c2.meanEvidence + cell.meanEvidence) * 0.5;
            const mergeScore = toneDiff + colorBarrier * p.mergeThreshold / uniformityRelax;
            if(mergeScore <= p.mergeThreshold * closureRelax && evidBarrier <= p.edgeSensitivity * closureRelax){
              visited[ni] = 1; queue.push(c2);
            }
          }
        }
      }
      rawRegions.push(makeRegionFromCells(memberIdx, cells, grid, w, h, p, closureConf, enclosedRegions));
    }

    const minPx = Math.max(25, Math.round(w * h * p.minRegionArea));
    let filtered = rawRegions.filter(r => {
      if(r.area >= minPx) return true;
      if(r.colorConfidence > 0.35 && r.area >= minPx * 0.4) return true;
      return false;
    });
    filtered = mergeInteriorFragments(filtered, p);

    return {
      nodes: filtered,
      edges: buildAdjacency(filtered),
      colorBoundary, closureMap, enclosedRegions, combinedEvidence
    };
  }

  /* ─── Feature graph generation (partition-first architecture) ── */
  function generateFeatureGraph(normalizedSurface, params){
    if(!normalizedSurface?.gray) return null;
    const p = copyParams(params);
    const w = normalizedSurface.width, h = normalizedSurface.height;
    const gray = normalizedSurface.gray;
    const lab = normalizedSurface.lab || null;
    const mode = (p.pipelineMode && PIPELINE_MODES.includes(p.pipelineMode)) ? p.pipelineMode : 'partition';

    // Evidence maps (always computed for visualization)
    const grad = computeGradient(gray, w, h);
    const colorBoundary = computeColorBoundary(lab, w, h, p);
    const closureMap = buildClosureEvidence(grad, w, h, p, colorBoundary);
    const enclosedRegions = findEnclosedRegions(closureMap, w, h, p.minEnclosingArea);
    const combinedEvidence = buildCombinedBoundaryEvidence(
      gray, lab, grad, colorBoundary, closureMap, w, h, p
    );

    let finalNodes, finalEdges;
    let partitionResult = null;
    let structuralResult = null;

    // ── Stage 1: Color-First Partition (mandatory for partition/hybrid/combined) ──
    if(mode === 'partition' || mode === 'hybrid' || mode === 'combined'){
      partitionResult = computePartition(normalizedSurface, p);
    }

    // ── Structural pipeline (for structural/hybrid/combined) ──
    if(mode === 'structural' || mode === 'hybrid' || mode === 'combined'){
      structuralResult = runStructuralPipeline(normalizedSurface, p);
    }

    // ── Mode-specific output assembly ──
    if(mode === 'partition'){
      // Pure partition: graph is built entirely from the partition
      finalNodes = partitionResult.nodes;
      finalEdges = partitionResult.edges;
    } else if(mode === 'structural'){
      // Legacy structural-only mode
      finalNodes = structuralResult.nodes;
      finalEdges = structuralResult.edges;
    } else if(mode === 'hybrid'){
      // Partition first, then structural refinement.
      // Partition regions are the foundation. Structural regions that
      // are fully contained within a single partition region are ignored
      // (the partition already got it right). Structural regions that
      // span multiple partition regions contribute refinement data.
      finalNodes = partitionResult.nodes;
      finalEdges = partitionResult.edges;
      // Structural refinement pass: enrich partition nodes with structural data
      if(structuralResult?.nodes?.length > 0){
        for(const sNode of structuralResult.nodes){
          // Find the partition region(s) this structural region overlaps
          let bestMatch = null, bestOverlap = 0;
          for(const pNode of finalNodes){
            const ox = Math.max(0, Math.min(pNode.bbox.x + pNode.bbox.w, sNode.bbox.x + sNode.bbox.w) - Math.max(pNode.bbox.x, sNode.bbox.x));
            const oy = Math.max(0, Math.min(pNode.bbox.y + pNode.bbox.h, sNode.bbox.y + sNode.bbox.h) - Math.max(pNode.bbox.y, sNode.bbox.y));
            const overlap = ox * oy;
            if(overlap > bestOverlap){ bestOverlap = overlap; bestMatch = pNode; }
          }
          if(bestMatch && bestOverlap > 0){
            // Enrich the partition node with structural closure data
            bestMatch.closureScore = Math.max(bestMatch.closureScore || 0, sNode.closureScore || 0);
            bestMatch.structuralRefinement = true;
          }
        }
      }
    } else {
      // Combined view: partition is authoritative, structural is informational
      finalNodes = partitionResult.nodes;
      finalEdges = partitionResult.edges;
    }

    const graph = {
      engine: 'WFG2', version: 3, parameters: p,
      pipelineMode: mode,
      normalizedSize: { width: w, height: h },
      nodes: finalNodes,
      edges: finalEdges,
      partition: partitionResult ? {
        labelMap: partitionResult.labelMap,
        sharedBoundaries: partitionResult.sharedBoundaries,
        regionCount: partitionResult.regionCount,
        adjacency: partitionResult.adjacency
      } : null,
      structural: structuralResult ? {
        nodes: structuralResult.nodes,
        edges: structuralResult.edges
      } : null,
      artifacts: {
        contourLayer: finalNodes.map(r => ({ id: r.id, contour: r.contour })),
        debugPrimitives: finalNodes.map(r => ({
          id: r.id, bbox: r.bbox,
          compactness: r.compactness, closureScore: r.closureScore,
          colorConfidence: r.colorConfidence, surfaceUniformity: r.surfaceUniformity,
          confidence: r.confidence, commitOrder: r.commitOrder
        })),
        colorBoundaryActive: !!colorBoundary,
        closureActive: true,
        enclosedRegionCount: enclosedRegions.length,
        colorBoundaryMap: colorBoundary,
        closureMap: closureMap,
        combinedEvidenceMap: combinedEvidence,
        partitionLabelMap: partitionResult ? partitionResult.labelMap : null,
        partitionSharedBoundaries: partitionResult ? partitionResult.sharedBoundaries : null
      }
    };
    return graph;
  }

  /* Merge small fragments that are fully contained inside a larger region
     and where the larger region has high closure confidence. */
  function mergeInteriorFragments(regions, params){
    if(regions.length < 2) return regions;
    const p = copyParams(params);
    const bonus = clamp(p.parentContourBonus, 0, 1);
    if(bonus <= 0) return regions;

    // Sort largest first for containment checks
    const sorted = regions.slice().sort((a, b) => b.area - a.area);
    const absorbed = new Set();

    for(let i = 0; i < sorted.length; i++){
      const parent = sorted[i];
      if(absorbed.has(parent.id)) continue;
      if(parent.closureScore < 0.3) continue; // parent must have closure evidence

      for(let j = i + 1; j < sorted.length; j++){
        const child = sorted[j];
        if(absorbed.has(child.id)) continue;
        // Check containment: child bbox fully inside parent bbox
        const pb = parent.bbox, cb = child.bbox;
        if(cb.x >= pb.x && cb.y >= pb.y &&
           cb.x + cb.w <= pb.x + pb.w &&
           cb.y + cb.h <= pb.y + pb.h){
          // Child is geometrically inside parent
          // Absorb if child is much smaller (likely internal detail)
          if(child.area < parent.area * 0.35){
            absorbed.add(child.id);
            parent.area += child.area;
            parent.absorbedCount = (parent.absorbedCount || 0) + 1;
          }
        }
      }
    }

    return sorted.filter(r => !absorbed.has(r.id));
  }

  function makeRegionFromCells(memberIdx, cells, grid, w, h, params, closureConf, enclosedRegions){
    let minX = w, minY = h, maxX = 0, maxY = 0;
    const points = [];
    let sumClosure = 0;
    let sumColorConf = 0;
    let sumColorStdDev = 0;
    let colorStdDevCount = 0;
    for(const idx of memberIdx){
      const c = cells[idx];
      minX = Math.min(minX, c.x0); minY = Math.min(minY, c.y0);
      maxX = Math.max(maxX, c.x1); maxY = Math.max(maxY, c.y1);
      points.push([c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]);
      sumClosure += c.meanClosure || 0;
      // Color confidence: higher when cell has Lab stats (color is meaningful)
      if(c.meanL !== undefined){
        // Chroma magnitude indicates color richness
        const chroma = Math.sqrt(c.meanA * c.meanA + c.meanB * c.meanB);
        sumColorConf += Math.min(1, chroma / 40);
      }
      // Track intra-region surface uniformity
      if(c.colorStdDev !== undefined){
        sumColorStdDev += c.colorStdDev;
        colorStdDevCount++;
      }
    }
    const area = memberIdx.length * grid * grid;
    const bboxArea = Math.max(1, (maxX - minX) * (maxY - minY));
    const fillRatio = clamp(area / bboxArea, 0, 1);

    // Closure score: average closure confidence across member cells
    const closureScore = clamp(sumClosure / Math.max(1, memberIdx.length), 0, 1);

    // Color confidence: how much color contributed to this region's definition
    const colorConfidence = clamp(sumColorConf / Math.max(1, memberIdx.length), 0, 1);

    // Surface uniformity: 0-1, high = internally uniform surface (sky, wall)
    const avgColorStdDev = colorStdDevCount > 0 ? sumColorStdDev / colorStdDevCount : 0;
    const surfaceUniformity = clamp(1 - avgColorStdDev / 15, 0, 1);

    // Compactness: boosted by closure (enclosed regions are more compact/confident)
    const baseCompactness = (fillRatio * 0.7) + (memberIdx.length > 1 ? 0.15 : 0) + (closureScore * 0.15);

    return {
      id: 'wfg2-r-' + Math.random().toString(36).slice(2, 10),
      type: 'visual_region',
      bbox: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) },
      center: { x: minX + (maxX - minX) * 0.5, y: minY + (maxY - minY) * 0.5 },
      area,
      contour: hull(points).map(p => ({ x: p[0], y: p[1] })),
      compactness: clamp(baseCompactness, 0, 1) - (1 - fillRatio) * params.rectangularBiasPenalty,
      closureScore,
      colorConfidence,
      surfaceUniformity
    };
  }

  function buildAdjacency(nodes){
    const out = [];
    for(let i = 0; i < nodes.length; i++) for(let j = i + 1; j < nodes.length; j++){
      const a = nodes[i].bbox, b = nodes[j].bbox;
      const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
      const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
      const dist = Math.sqrt(dx * dx + dy * dy);
      if(dist <= Math.max(6, Math.min(a.w, a.h, b.w, b.h) * 0.3)) out.push({ from: nodes[i].id, to: nodes[j].id, kind: 'adjacent', distance: dist });
    }
    return out;
  }

  function hull(points){
    if(points.length <= 3) return points;
    points = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for(const p of points){ while(lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    const upper = [];
    for(let i = points.length - 1; i >= 0; i--){ const p = points[i]; while(upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    upper.pop(); lower.pop(); return lower.concat(upper);
  }

  function adaptParametersFromFeedback(params, feedback){
    const p = copyParams(params), tags = new Set(Array.isArray(feedback?.tags) ? feedback.tags : []);

    // ── Region count ──
    if(tags.has('too_many_regions')){
      p.mergeThreshold += 3;
      // Gentler minRegionArea increase — the small-object rescue in the
      // filter stage (based on colorConfidence) now handles legitimate small
      // objects, so we can be slightly more aggressive here without losing them.
      p.minRegionArea += 0.0003;
      p.colorDistFloor = Math.min(25, p.colorDistFloor + 1);
      p.surfaceUniformityBias = Math.min(0.8, p.surfaceUniformityBias + 0.06);
      // Reduce luminance weight to suppress noisy non-color edges
      p.luminanceWeight = Math.max(0.1, p.luminanceWeight - 0.03);
      p.varianceWeight = Math.max(0, p.varianceWeight - 0.02);
    }
    if(tags.has('too_few_regions')){
      p.mergeThreshold -= 2;
      p.minRegionArea = Math.max(0.0001, p.minRegionArea - 0.0003);
      p.edgeSensitivity += 2;
      p.colorMergePenalty = Math.min(4, p.colorMergePenalty + 0.15);
      p.colorDistFloor = Math.max(1, p.colorDistFloor - 1);
    }

    // ── Boundaries & shapes ──
    if(tags.has('split_object')){
      p.mergeThreshold += 3;
      p.edgeSensitivity += 2;
      p.colorDistFloor = Math.min(35, p.colorDistFloor + 3);
      p.surfaceUniformityBias = Math.min(0.9, p.surfaceUniformityBias + 0.08);
      p.closureWeight = Math.min(0.6, p.closureWeight + 0.05);
      p.parentContourBonus = Math.min(0.6, p.parentContourBonus + 0.06);
      // Increase chroma dominance to suppress luminance-based splits
      p.chromaWeight = Math.min(1.0, (p.chromaWeight || 0.85) + 0.03);
      p.luminanceWeight = Math.max(0, p.luminanceWeight - 0.02);
    }
    if(tags.has('merged_objects')){
      p.mergeThreshold -= 2;
      p.edgeSensitivity -= 3;
      p.colorMergePenalty = Math.min(4, p.colorMergePenalty + 0.3);
      p.colorDistFloor = Math.max(1, p.colorDistFloor - 1);
      p.surfaceUniformityBias = Math.max(0, p.surfaceUniformityBias - 0.06);
    }
    if(tags.has('shape_mismatch')){
      p.rectangularBiasPenalty += 0.08;
      p.gridSize = Math.max(4, p.gridSize - 1);
      p.closureRadius = Math.min(8, p.closureRadius + 1);
      p.closureWeight = Math.min(0.6, p.closureWeight + 0.06);
    }
    if(tags.has('missed_object')){
      p.minRegionArea = Math.max(0.0001, p.minRegionArea - 0.0003);
      p.edgeSensitivity += 2;
      p.gridSize = Math.max(4, p.gridSize - 1);
      p.colorMergePenalty = Math.min(4, p.colorMergePenalty + 0.2);
      p.colorDistFloor = Math.max(1, p.colorDistFloor - 2);
    }

    // ── Color & surface ──
    if(tags.has('color_boundary_missed')){
      p.colorWeight = Math.min(0.8, p.colorWeight + 0.08);
      p.colorMergePenalty = Math.min(4, p.colorMergePenalty + 0.3);
      p.colorDistFloor = Math.max(1, p.colorDistFloor - 3);
      p.colorDistGamma = Math.max(0.8, p.colorDistGamma - 0.2);
    }
    if(tags.has('surface_fragmented')){
      p.mergeThreshold += 3;
      p.colorDistFloor = Math.min(35, p.colorDistFloor + 3);
      p.surfaceUniformityBias = Math.min(0.9, p.surfaceUniformityBias + 0.1);
      p.colorDistGamma = Math.min(3.5, p.colorDistGamma + 0.15);
      p.closureWeight = Math.min(0.6, p.closureWeight + 0.04);
      p.chromaWeight = Math.min(1.0, (p.chromaWeight || 0.85) + 0.03);
      p.luminanceWeight = Math.max(0, p.luminanceWeight - 0.02);
    }

    const rating = Number(feedback?.rating || 0);
    if(Number.isFinite(rating) && rating > 0){
      if(rating <= 2) p.edgeSensitivity = Math.max(8, p.edgeSensitivity - 1);
      if(rating >= 4) p.mergeThreshold = Math.min(60, p.mergeThreshold + 1);
    }
    p.gridSize = clamp(Math.round(p.gridSize), 4, 24);
    p.edgeSensitivity = clamp(Math.round(p.edgeSensitivity), 8, 120);
    p.mergeThreshold = clamp(Math.round(p.mergeThreshold), 4, 60);
    p.minRegionArea = clamp(p.minRegionArea, 0.0001, 0.08);
    p.fragmentationTolerance = clamp(p.fragmentationTolerance, 0.05, 0.8);
    p.rectangularBiasPenalty = clamp(p.rectangularBiasPenalty, 0, 1);
    p.colorWeight = clamp(p.colorWeight, 0.3, 0.95);
    p.luminanceWeight = clamp(p.luminanceWeight, 0, 0.3);
    p.varianceWeight = clamp(p.varianceWeight, 0, 0.2);
    p.colorMergePenalty = clamp(p.colorMergePenalty, 0.5, 5);
    p.chromaWeight = clamp(p.chromaWeight ?? 0.85, 0.5, 1.0);
    p.colorDistFloor = clamp(p.colorDistFloor, 0, 25);
    p.colorDistCeiling = clamp(p.colorDistCeiling, 15, 80);
    p.colorDistGamma = clamp(p.colorDistGamma, 0.5, 3.5);
    p.surfaceUniformityBias = clamp(p.surfaceUniformityBias, 0, 0.8);
    p.closureRadius = clamp(Math.round(p.closureRadius), 1, 8);
    p.closureWeight = clamp(p.closureWeight, 0, 0.6);
    p.parentContourBonus = clamp(p.parentContourBonus, 0, 0.6);
    p.minEnclosingArea = clamp(p.minEnclosingArea, 0.002, 0.1);
    // Partition params
    p.partitionColorTolerance = clamp(p.partitionColorTolerance ?? 15, 3, 60);
    p.partitionMinRegionPixels = clamp(Math.round(p.partitionMinRegionPixels ?? 64), 4, 2000);
    p.partitionBoundaryContinuation = clamp(p.partitionBoundaryContinuation ?? 0.6, 0, 1);
    p.partitionLocalRefinementRange = clamp(Math.round(p.partitionLocalRefinementRange ?? 8), 1, 32);
    p.partitionScoreVarianceW = clamp(p.partitionScoreVarianceW ?? 0.25, 0, 1);
    p.partitionScoreBoundaryW = clamp(p.partitionScoreBoundaryW ?? 0.25, 0, 1);
    p.partitionScoreContourW = clamp(p.partitionScoreContourW ?? 0.20, 0, 1);
    p.partitionScoreClosureW = clamp(p.partitionScoreClosureW ?? 0.15, 0, 1);
    p.partitionScoreLeakW = clamp(p.partitionScoreLeakW ?? 0.15, 0, 1);
    return p;
  }

  function createAttemptStore(storage, key){
    const storageKey = key || 'wfg2.graphLearningAttempts.v1';
    const read = () => { try { const raw = storage?.getItem(storageKey); return raw ? JSON.parse(raw) : []; } catch(err){ return []; } };
    const write = (rows) => { try { storage?.setItem(storageKey, JSON.stringify(rows)); } catch(err){ /* ignore */ } };
    return {
      getAll(){ return read(); },
      addAttempt(attempt){ const rows = read(); rows.push(attempt); write(rows); return attempt; },
      clear(){ write([]); }
    };
  }

  function createPresetStore(storage, key){
    const storageKey = key || 'wfg2.graphLearningPreset.v1';
    const read = () => {
      try {
        const raw = storage?.getItem(storageKey);
        if(!raw) return null;
        const parsed = JSON.parse(raw);
        if(!parsed || typeof parsed !== 'object') return null;
        if(!parsed.params || typeof parsed.params !== 'object') return null;
        // Invalidate presets saved with an older schema version — their
        // weight tuning no longer matches the current engine architecture.
        if((parsed.params._schemaVersion || 0) < PARAMS_SCHEMA_VERSION){
          try { storage?.removeItem(storageKey); } catch(e){}
          return null;
        }
        return {
          ...parsed,
          params: copyParams(parsed.params)
        };
      } catch(err){
        return null;
      }
    };
    const write = (row) => {
      try {
        storage?.setItem(storageKey, JSON.stringify(row));
      } catch(err){
        /* ignore */
      }
    };
    return {
      get(){ return read(); },
      save(preset){
        const now = new Date().toISOString();
        const payload = {
          presetId: preset?.presetId || 'wfg2-baseline',
          name: preset?.name || 'WFG2 Baseline',
          params: copyParams(preset?.params || DEFAULT_PARAMS),
          sourceAttemptId: preset?.sourceAttemptId || null,
          sourceResult: preset?.sourceResult || null,
          sourceFileName: preset?.sourceFileName || null,
          savedAt: now,
          createdAt: preset?.createdAt || now
        };
        write(payload);
        return payload;
      },
      clear(){
        try {
          storage?.removeItem(storageKey);
        } catch(err){
          /* ignore */
        }
      }
    };
  }

  return { DEFAULT_PARAMS, FEEDBACK_TAGS, PIPELINE_MODES, copyParams, normalizeVisualInput, generateFeatureGraph, computePartition, adaptParametersFromFeedback, createAttemptStore, createPresetStore };
});
