(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  }
  root.WrokitFeatureGraph2 = factory();
})(typeof window !== 'undefined' ? window : globalThis, function(){
  const DEFAULT_PARAMS = Object.freeze({
    gridSize: 8, edgeSensitivity: 28, mergeThreshold: 18,
    minRegionArea: 0.0008, fragmentationTolerance: 0.22, rectangularBiasPenalty: 0.35,
    /* Color-primary boundary evidence: color is the anchor signal.
       Luminance and variance are secondary — damped where color is present. */
    colorWeight: 0.65, luminanceWeight: 0.20, varianceWeight: 0.10,
    colorMergePenalty: 1.8,
    /* Color distance calibration */
    colorDistFloor: 14,      // ΔE below this is ignored (shadows, lighting gradients)
    colorDistCeiling: 50,    // ΔE at/above this produces maximum boundary signal
    colorDistGamma: 2.2,     // >1 = suppress small distances, amplify large ones
    surfaceUniformityBias: 0.55, // 0-1: how much intra-region color uniformity relaxes merge
    /* Continuity / closure (now color-informed when color data is available) */
    closureRadius: 3, closureWeight: 0.20,
    parentContourBonus: 0.25, minEnclosingArea: 0.01
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

  function computeColorBoundary(lab, w, h, params){
    if(!lab) return null;
    const p = params || {};
    const floor   = p.colorDistFloor   ?? 6;
    const ceiling = p.colorDistCeiling ?? 45;
    const gamma   = p.colorDistGamma   ?? 1.8;
    const out = new Float32Array(w * h);
    const L = lab.L, a = lab.a, b = lab.b;
    for(let y = 1; y < h - 1; y++) for(let x = 1; x < w - 1; x++){
      const i = y * w + x;
      // Max CIE76 ΔE across 4-connected neighbors
      let maxDelta = 0;
      const nbrs = [i - 1, i + 1, i - w, i + w];
      for(const ni of nbrs){
        const dL = L[i] - L[ni], da = a[i] - a[ni], db = b[i] - b[ni];
        const de = Math.sqrt(dL * dL + da * da + db * db);
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
      // Color boundary is Float32 0-1.  Threshold at 0.15 (moderate boundary).
      // Where color evidence is weak (< 0.10), allow luminance gradient to fill in.
      const sorted = Array.from(grad).sort((a, b) => b - a);
      const lumCutoff = Math.max(8, sorted[Math.floor(sorted.length * 0.30)] || 15);
      for(let i = 0; i < binary.length; i++){
        if(colorBoundary[i] >= 0.15){
          binary[i] = 1;
        } else if(colorBoundary[i] < 0.10 && grad[i] >= lumCutoff){
          binary[i] = 1; // luminance fallback in color-silent areas
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

      // Color-primary: color evidence is the anchor signal.
      const colSq = colEdge * colEdge; // 0-1, strongly non-linear

      // Secondary suppression: when color evidence is present at a pixel,
      // luminance & variance contributions are heavily damped so they cannot
      // inject false edges.  They only contribute fully where color is silent.
      const colorPresence = hasColor ? clamp(colEdge * 4, 0, 1) : 0; // 0-1 soft gate
      const secondaryDamp = 1 - colorPresence * 0.8; // 1.0 when no color → 0.2 when strong color
      const lumContrib  = lumEdge  * wLum * secondaryDamp;
      const varContrib  = varNorm  * wVar * secondaryDamp;

      const edgeSignal = colSq * wColor + lumContrib + varContrib;
      // Closure boosts edge evidence where morphological closing bridged gaps
      const closureBoost = closureBit ? wClosure * secondaryDamp : 0;
      evidence[i] = clamp(Math.round(Math.min(1, edgeSignal + closureBoost) * 255), 0, 255);
    }
    return evidence;
  }

  /* ─── Feature graph generation (enhanced with color + closure) ── */
  function generateFeatureGraph(normalizedSurface, params){
    if(!normalizedSurface?.gray) return null;
    const p = copyParams(params);
    const w = normalizedSurface.width, h = normalizedSurface.height;
    const gray = normalizedSurface.gray;
    const lab = normalizedSurface.lab || null;
    const grad = computeGradient(gray, w, h);

    // Part 1: Color-aware boundary evidence (magnitude-weighted)
    const colorBoundary = computeColorBoundary(lab, w, h, p);

    // Part 2: Continuity / closure evidence (color-informed when available)
    const closureMap = buildClosureEvidence(grad, w, h, p, colorBoundary);
    const enclosedRegions = findEnclosedRegions(closureMap, w, h, p.minEnclosingArea);
    const closureConf = buildClosureConfidence(closureMap, enclosedRegions, grad, w, h);

    // Combined boundary evidence for region growth decisions
    const combinedEvidence = buildCombinedBoundaryEvidence(
      gray, lab, grad, colorBoundary, closureMap, w, h, p
    );

    // Grid-based cell system
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

    // Compute per-cell Lab stats for color-aware merge
    if(lab) computeCellLabStats(cells, lab, w);

    // Region growing with color + closure awareness
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

          // Compare candidate to BOTH the seed and the current frontier cell.
          // This prevents color-drift where each step is small but the region
          // gradually absorbs pixels far from the seed's color.
          const toneDiffSeed = Math.abs(c2.meanGray - seed.meanGray);
          const toneDiffLocal = Math.abs(c2.meanGray - cell.meanGray);
          const toneDiff = Math.max(toneDiffSeed, toneDiffLocal);

          // Color difference in Lab — check against both seed and frontier
          let colorStrength = 0; // 0-1 after dead-zone/gamma
          if(lab && seed.meanL !== undefined){
            const dLs = c2.meanL - seed.meanL, das = c2.meanA - seed.meanA, dbs = c2.meanB - seed.meanB;
            const deSeed = Math.sqrt(dLs * dLs + das * das + dbs * dbs);
            const dLl = c2.meanL - cell.meanL, dal = c2.meanA - cell.meanA, dbl = c2.meanB - cell.meanB;
            const deLocal = Math.sqrt(dLl * dLl + dal * dal + dbl * dbl);
            // Use the larger of the two distances — prevents drift
            const deMax = Math.max(deSeed, deLocal);
            colorStrength = colorDistToStrength(
              deMax, p.colorDistFloor, p.colorDistCeiling, p.colorDistGamma
            );
          }

          // Surface uniformity: if both cells are internally uniform
          // (low intra-cell color variance), they likely belong to the
          // same gradual surface (sky, wall) → relax color penalty.
          const uBias = clamp(p.surfaceUniformityBias, 0, 1);
          let uniformityRelax = 1.0;
          if(uBias > 0 && cell.colorStdDev !== undefined && c2.colorStdDev !== undefined){
            const avgStdDev = (cell.colorStdDev + c2.colorStdDev) * 0.5;
            const uniformity = clamp(1 - avgStdDev / 12, 0, 1);
            uniformityRelax = 1 + uniformity * uBias;
          }

          // Split barrier: color boundary is the primary gate, combined evidence
          // is secondary.  This prevents noisy luminance/variance in the combined
          // evidence from blocking merges that color says should happen.
          const colorBarrier = (c2.meanColorBoundary + cell.meanColorBoundary) * 0.5;
          const combinedBarrier = (c2.meanEvidence + cell.meanEvidence) * 0.5;
          // When color evidence is present, it is authoritative.
          // Combined evidence only adds a mild secondary veto.
          const effectiveBarrier = colorBoundary
            ? (colorBarrier * 255) * 0.7 + combinedBarrier * 0.3
            : combinedBarrier;

          // Closure-aware merge relaxation
          const closureRelax = (cell.meanClosure > 0.4 && c2.meanClosure > 0.4) ? 1.3 : 1.0;

          // Color penalty: magnitude-weighted and squared.
          // At colorStrength=1 (strong color boundary), penalty far exceeds
          // mergeThreshold, making the boundary decisive.
          const colorStr2 = colorStrength * colorStrength;
          const colorPenalty = colorStr2 * p.colorMergePenalty * p.mergeThreshold / uniformityRelax;
          const effectiveToneDiff = toneDiff + colorPenalty;

          if(effectiveToneDiff <= p.mergeThreshold * closureRelax &&
             effectiveBarrier <= p.edgeSensitivity * closureRelax){
            visited[ni] = 1;
            queue.push(c2);
          }
        }
      }
      rawRegions.push(makeRegionFromCells(memberIdx, cells, grid, w, h, p, closureConf, enclosedRegions));
    }

    // Filter by minimum area — but protect small regions that have strong
    // color confidence, since those likely represent legitimate small objects
    // that the color layer correctly identified.
    const minPixels = Math.max(25, Math.round(w * h * p.minRegionArea));
    let filtered = rawRegions.filter(r => {
      if(r.area >= minPixels) return true;
      // Small region rescue: keep if color confidence is high (the color layer
      // is confident this is a real object, not noise).  Require at least 40%
      // of the normal min area to prevent truly tiny noise fragments.
      if(r.colorConfidence > 0.35 && r.area >= minPixels * 0.4) return true;
      return false;
    });

    // Part 2 integration: merge small interior regions into their enclosing parent
    // if the parent has strong closure confidence (preserves containers with text)
    filtered = mergeInteriorFragments(filtered, p);

    const graph = {
      engine: 'WFG2', version: 2, parameters: p,
      normalizedSize: { width: w, height: h },
      nodes: filtered,
      edges: buildAdjacency(filtered),
      artifacts: {
        contourLayer: filtered.map(r => ({ id: r.id, contour: r.contour })),
        debugPrimitives: filtered.map(r => ({ id: r.id, bbox: r.bbox, compactness: r.compactness, closureScore: r.closureScore, colorConfidence: r.colorConfidence, surfaceUniformity: r.surfaceUniformity })),
        colorBoundaryActive: !!colorBoundary,
        closureActive: true,
        enclosedRegionCount: enclosedRegions.length,
        // Evidence maps for visualization overlays
        colorBoundaryMap: colorBoundary,  // Float32Array 0-1, or null
        closureMap: closureMap,           // Uint8Array 0|1, or null
        combinedEvidenceMap: combinedEvidence // Uint8Array 0-255
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
      p.colorDistFloor = Math.min(25, p.colorDistFloor + 2);
      p.surfaceUniformityBias = Math.min(0.8, p.surfaceUniformityBias + 0.08);
      p.closureWeight = Math.min(0.6, p.closureWeight + 0.05);
      p.parentContourBonus = Math.min(0.6, p.parentContourBonus + 0.06);
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
      p.colorDistFloor = Math.min(25, p.colorDistFloor + 2.5);
      p.surfaceUniformityBias = Math.min(0.8, p.surfaceUniformityBias + 0.1);
      p.colorDistGamma = Math.min(3.5, p.colorDistGamma + 0.15);
      p.closureWeight = Math.min(0.6, p.closureWeight + 0.04);
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
    p.colorWeight = clamp(p.colorWeight, 0, 0.8);
    p.luminanceWeight = clamp(p.luminanceWeight, 0.1, 0.8);
    p.varianceWeight = clamp(p.varianceWeight, 0, 0.5);
    p.colorMergePenalty = clamp(p.colorMergePenalty, 0, 4);
    p.colorDistFloor = clamp(p.colorDistFloor, 0, 25);
    p.colorDistCeiling = clamp(p.colorDistCeiling, 15, 80);
    p.colorDistGamma = clamp(p.colorDistGamma, 0.5, 3.5);
    p.surfaceUniformityBias = clamp(p.surfaceUniformityBias, 0, 0.8);
    p.closureRadius = clamp(Math.round(p.closureRadius), 1, 8);
    p.closureWeight = clamp(p.closureWeight, 0, 0.6);
    p.parentContourBonus = clamp(p.parentContourBonus, 0, 0.6);
    p.minEnclosingArea = clamp(p.minEnclosingArea, 0.002, 0.1);
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

  return { DEFAULT_PARAMS, FEEDBACK_TAGS, copyParams, normalizeVisualInput, generateFeatureGraph, adaptParametersFromFeedback, createAttemptStore, createPresetStore };
});
