(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WrokitVisionMaps = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  // ── Reference to the canonical page-space module (loaded as a global) ──────
  const PageSpace = (typeof self !== 'undefined' ? self : this).EnginePageSpace || null;

  function clamp01(v){ return Math.max(0, Math.min(1, Number(v) || 0)); }

  /**
   * Compute canonical page-space (normalised [0,1]) coordinates for a pixel box.
   * Uses detectDocumentBounds from EnginePageSpace when available; otherwise falls
   * back to simple viewport-relative normalisation.  Either way, the result is
   * consistent with how extraction normBoxes are stored (x0n = x / vpW, etc.).
   */
  function pageSpaceNorm(box, vpW, vpH){
    return {
      nx:  clamp01(box.x / vpW),
      ny:  clamp01(box.y / vpH),
      nw:  clamp01(box.w / vpW),
      nh:  clamp01(box.h / vpH),
      ncx: clamp01((box.x + box.w / 2) / vpW),
      ncy: clamp01((box.y + box.h / 2) / vpH)
    };
  }

  function normToken(tok, viewport){
    const width = Math.max(1, Number(viewport?.width || viewport?.w) || 1);
    const height = Math.max(1, Number(viewport?.height || viewport?.h) || 1);
    const x = Number(tok?.x) || 0;
    const y = Number(tok?.y) || 0;
    const w = Math.max(0, Number(tok?.w) || 0);
    const h = Math.max(0, Number(tok?.h) || 0);
    return {
      text: String(tok?.text || ''),
      x, y, w, h,
      cx: x + (w / 2),
      cy: y + (h / 2),
      nx: clamp01(x / width),
      ny: clamp01(y / height),
      nw: clamp01(w / width),
      nh: clamp01(h / height),
      ncx: clamp01((x + w / 2) / width),
      ncy: clamp01((y + h / 2) / height)
    };
  }

  function buildTextMap(tokens, viewport){
    const nodes = (Array.isArray(tokens) ? tokens : [])
      .map(tok => normToken(tok, viewport))
      .filter(tok => !!tok.text.trim());

    const sorted = nodes.slice().sort((a,b)=> (a.cy - b.cy) || (a.cx - b.cx));
    const edges = [];
    for(let i=0;i<sorted.length;i++){
      const a = sorted[i];
      for(let j=i+1;j<Math.min(sorted.length, i + 18);j++){
        const b = sorted[j];
        const dx = b.ncx - a.ncx;
        const dy = b.ncy - a.ncy;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if(ady <= 0.015 && adx <= 0.35){
          edges.push({ from:i, to:j, type:'same_line', dx, dy, dist: Math.hypot(dx,dy) });
        } else if(adx <= 0.06 && ady <= 0.2){
          edges.push({ from:i, to:j, type:'vertical_near', dx, dy, dist: Math.hypot(dx,dy) });
        } else if(adx <= 0.25 && ady <= 0.12){
          edges.push({ from:i, to:j, type:'near', dx, dy, dist: Math.hypot(dx,dy) });
        }
      }
    }

    return {
      version: 1,
      nodeCount: sorted.length,
      edgeCount: edges.length,
      nodes: sorted,
      edges
    };
  }

  function buildTextInfluenceMask(textMap){
    const nodes = textMap?.nodes || [];
    return {
      version: 1,
      boxes: nodes.map(n => ({ x:n.x, y:n.y, w:n.w, h:n.h, weight:1 }))
    };
  }

  function scoreTextOverlap(feature, textMask){
    const boxes = textMask?.boxes || [];
    if(!boxes.length) return 0;
    const fx0 = feature.x;
    const fy0 = feature.y;
    const fx1 = fx0 + feature.w;
    const fy1 = fy0 + feature.h;
    let overlapArea = 0;
    const area = Math.max(1, feature.w * feature.h);
    for(const b of boxes){
      const ox = Math.max(0, Math.min(fx1, b.x + b.w) - Math.max(fx0, b.x));
      const oy = Math.max(0, Math.min(fy1, b.y + b.h) - Math.max(fy0, b.y));
      overlapArea += ox * oy;
    }
    return Math.max(0, Math.min(1, overlapArea / area));
  }

  function estimateBackground(textMap){
    const nodes = textMap?.nodes || [];
    if(!nodes.length){
      return { confidence: 0.25, occupiedRatio: 0 };
    }
    const occupied = nodes.reduce((sum, n)=> sum + (n.nw * n.nh), 0);
    const occupiedRatio = Math.max(0, Math.min(1, occupied));
    return {
      confidence: Math.max(0.3, 1 - occupiedRatio),
      occupiedRatio
    };
  }

  /* ── Geometry helpers ────────────────────────────────────────────── */

  function boundingBox(items){
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(const t of items){
      x0 = Math.min(x0, t.x);
      y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w);
      y1 = Math.max(y1, t.y + t.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function boxContains(outer, inner){
    return inner.x >= outer.x - 1 && inner.y >= outer.y - 1
      && (inner.x + inner.w) <= (outer.x + outer.w + 1)
      && (inner.y + inner.h) <= (outer.y + outer.h + 1);
  }

  function boxGap(a, b){
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    return { gapX, gapY };
  }

  /* ── Pixel-level image analysis ────────────────────────────────── */

  function sobelEdges(gray, w, h){
    // Returns Uint8Array where 1 = edge pixel, 0 = not
    const out = new Uint8Array(w * h);
    for(let y = 1; y < h - 1; y++){
      for(let x = 1; x < w - 1; x++){
        const i = y * w + x;
        const gx = -gray[i-w-1] - 2*gray[i-1] - gray[i+w-1]
                  + gray[i-w+1] + 2*gray[i+1] + gray[i+w+1];
        const gy = -gray[i-w-1] - 2*gray[i-w] - gray[i-w+1]
                  + gray[i+w-1] + 2*gray[i+w] + gray[i+w+1];
        const g = Math.sqrt(gx*gx + gy*gy);
        out[i] = g > 80 ? 1 : 0;
      }
    }
    return out;
  }

  function buildTextMask2D(textMap, w, h, dilate){
    // Binary mask: 1 = text region, 0 = non-text
    const mask = new Uint8Array(w * h);
    const pad = dilate || 3;
    for(const n of (textMap?.nodes || [])){
      const x0 = Math.max(0, Math.floor(n.x) - pad);
      const y0 = Math.max(0, Math.floor(n.y) - pad);
      const x1 = Math.min(w, Math.ceil(n.x + n.w) + pad);
      const y1 = Math.min(h, Math.ceil(n.y + n.h) + pad);
      for(let y = y0; y < y1; y++){
        const row = y * w;
        for(let x = x0; x < x1; x++) mask[row + x] = 1;
      }
    }
    return mask;
  }

  function detectStructuralLines(edges, textMask2D, w, h){
    // Scan for horizontal and vertical runs of edge pixels outside text mask
    const hLines = [];
    const vLines = [];
    const minHLen = Math.max(20, w * 0.08); // min 8% of width
    const minVLen = Math.max(15, h * 0.05); // min 5% of height

    // Horizontal line scan
    for(let y = 0; y < h; y++){
      let runStart = -1;
      let runLen = 0;
      for(let x = 0; x <= w; x++){
        const i = y * w + x;
        const isEdge = x < w && edges[i] === 1 && textMask2D[i] === 0;
        if(isEdge){
          if(runStart < 0) runStart = x;
          runLen++;
        } else {
          if(runLen >= minHLen){
            hLines.push({ x1: runStart, y1: y, x2: runStart + runLen, y2: y, len: runLen });
          }
          runStart = -1;
          runLen = 0;
        }
      }
    }

    // Vertical line scan
    for(let x = 0; x < w; x++){
      let runStart = -1;
      let runLen = 0;
      for(let y = 0; y <= h; y++){
        const i = y * w + x;
        const isEdge = y < h && edges[i] === 1 && textMask2D[i] === 0;
        if(isEdge){
          if(runStart < 0) runStart = y;
          runLen++;
        } else {
          if(runLen >= minVLen){
            vLines.push({ x1: x, y1: runStart, x2: x, y2: runStart + runLen, len: runLen });
          }
          runStart = -1;
          runLen = 0;
        }
      }
    }

    // Merge collinear segments that are nearly aligned
    const mergedH = mergeLines(hLines, 'h', 4, minHLen * 0.5);
    const mergedV = mergeLines(vLines, 'v', 4, minVLen * 0.5);

    return { hLines: mergedH, vLines: mergedV };
  }

  function mergeLines(lines, orientation, alignTol, gapTol){
    if(!lines.length) return lines;
    // Sort by perpendicular coordinate, then by parallel start
    const sorted = lines.slice().sort((a, b) => {
      const perpA = orientation === 'h' ? a.y1 : a.x1;
      const perpB = orientation === 'h' ? b.y1 : b.x1;
      if(Math.abs(perpA - perpB) > alignTol) return perpA - perpB;
      const paraA = orientation === 'h' ? a.x1 : a.y1;
      const paraB = orientation === 'h' ? b.x1 : b.y1;
      return paraA - paraB;
    });
    const merged = [sorted[0]];
    for(let i = 1; i < sorted.length; i++){
      const prev = merged[merged.length - 1];
      const cur = sorted[i];
      const perpPrev = orientation === 'h' ? prev.y1 : prev.x1;
      const perpCur = orientation === 'h' ? cur.y1 : cur.x1;
      const prevEnd = orientation === 'h' ? prev.x2 : prev.y2;
      const curStart = orientation === 'h' ? cur.x1 : cur.y1;
      const curEnd = orientation === 'h' ? cur.x2 : cur.y2;
      if(Math.abs(perpPrev - perpCur) <= alignTol && curStart - prevEnd <= gapTol){
        // Extend previous line
        if(orientation === 'h'){
          prev.x2 = Math.max(prev.x2, curEnd);
          prev.y1 = Math.round((perpPrev + perpCur) / 2);
          prev.y2 = prev.y1;
        } else {
          prev.y2 = Math.max(prev.y2, curEnd);
          prev.x1 = Math.round((perpPrev + perpCur) / 2);
          prev.x2 = prev.x1;
        }
        prev.len = orientation === 'h' ? (prev.x2 - prev.x1) : (prev.y2 - prev.y1);
      } else {
        merged.push(cur);
      }
    }
    return merged;
  }

  function detectWhitespaceCorridors(tokens, vpW, vpH){
    if(!tokens.length) return { hCorridors: [], vCorridors: [] };
    // Compute median token height for gap threshold
    const heights = tokens.map(t => t.h).sort((a,b) => a - b);
    const medH = heights[Math.floor(heights.length / 2)] || 12;
    const gapThreshold = medH * 2;

    // Horizontal corridors: find vertical gaps between rows of tokens
    // Project tokens onto Y axis as intervals, find gaps
    const yIntervals = tokens.map(t => ({ y0: t.y, y1: t.y + t.h }))
      .sort((a,b) => a.y0 - b.y0);
    const hCorridors = findGaps(yIntervals, 'y0', 'y1', gapThreshold, vpH);

    // Vertical corridors: find horizontal gaps
    const xIntervals = tokens.map(t => ({ x0: t.x, x1: t.x + t.w }))
      .sort((a,b) => a.x0 - b.x0);
    const vCorridors = findGaps(xIntervals, 'x0', 'x1', gapThreshold, vpW);

    return { hCorridors, vCorridors };
  }

  function findGaps(intervals, startKey, endKey, minGap, maxExtent){
    // Sweep line to find gaps in coverage
    const gaps = [];
    let covered = 0;
    for(const iv of intervals){
      const start = iv[startKey];
      const end = iv[endKey];
      if(start > covered + minGap){
        gaps.push({ start: covered, end: start, size: start - covered });
      }
      covered = Math.max(covered, end);
    }
    if(maxExtent - covered > minGap){
      gaps.push({ start: covered, end: maxExtent, size: maxExtent - covered });
    }
    return gaps;
  }

  function buildRegionsFromLines(hLines, vLines, hCorridors, vCorridors, vpW, vpH){
    // Combine detected lines and whitespace corridors into boundary coordinates
    // Horizontal boundaries (Y coordinates that separate rows)
    const hBounds = new Set([0, vpH]);
    for(const l of hLines) hBounds.add(l.y1);
    for(const c of hCorridors) hBounds.add(Math.round((c.start + c.end) / 2));

    // Vertical boundaries (X coordinates that separate columns)
    const vBounds = new Set([0, vpW]);
    for(const l of vLines) vBounds.add(l.x1);
    for(const c of vCorridors) vBounds.add(Math.round((c.start + c.end) / 2));

    const ys = Array.from(hBounds).sort((a,b) => a - b);
    const xs = Array.from(vBounds).sort((a,b) => a - b);

    // Build grid cells
    const cells = [];
    for(let r = 0; r < ys.length - 1; r++){
      for(let c = 0; c < xs.length - 1; c++){
        const x = xs[c], y = ys[r];
        const w = xs[c+1] - xs[c], h = ys[r+1] - ys[r];
        // Skip very thin slivers
        if(w < 5 || h < 5) continue;
        // Skip cells smaller than 0.5% of viewport
        if(w * h < vpW * vpH * 0.005) continue;
        cells.push({ x, y, w, h, row: r, col: c });
      }
    }

    return cells;
  }

  function mergeAdjacentCells(cells, hLines, vLines, vpW, vpH){
    // Merge adjacent cells that have no separating structural line between them
    // Build a lookup for which line boundaries exist
    const hLineSet = new Set();
    for(const l of hLines){
      // Mark the Y coordinate as a firm boundary within the line's X range
      hLineSet.add(`${l.y1}:${Math.floor(l.x1 / 10)}:${Math.ceil(l.x2 / 10)}`);
    }
    const vLineSet = new Set();
    for(const l of vLines){
      vLineSet.add(`${l.x1}:${Math.floor(l.y1 / 10)}:${Math.ceil(l.y2 / 10)}`);
    }

    function hasHLine(y, x0, x1){
      for(const l of hLines){
        if(Math.abs(l.y1 - y) <= 3 && l.x1 <= x0 + 5 && l.x2 >= x1 - 5) return true;
      }
      return false;
    }
    function hasVLine(x, y0, y1){
      for(const l of vLines){
        if(Math.abs(l.x1 - x) <= 3 && l.y1 <= y0 + 5 && l.y2 >= y1 - 5) return true;
      }
      return false;
    }

    // Union-Find for merging
    const parent = cells.map((_, i) => i);
    function find(i){ return parent[i] === i ? i : (parent[i] = find(parent[i])); }
    function union(a, b){ parent[find(a)] = find(b); }

    // Build spatial index: row,col → cell index
    const byCR = new Map();
    cells.forEach((c, i) => byCR.set(`${c.row}:${c.col}`, i));

    for(let i = 0; i < cells.length; i++){
      const c = cells[i];
      // Try merge with cell below (same col, next row)
      const belowIdx = byCR.get(`${c.row+1}:${c.col}`);
      if(belowIdx !== undefined){
        const below = cells[belowIdx];
        // The boundary between them is at c.y + c.h
        if(!hasHLine(c.y + c.h, c.x, c.x + c.w)){
          union(i, belowIdx);
        }
      }
      // Try merge with cell to right (same row, next col)
      const rightIdx = byCR.get(`${c.row}:${c.col+1}`);
      if(rightIdx !== undefined){
        const right = cells[rightIdx];
        if(!hasVLine(c.x + c.w, c.y, c.y + c.h)){
          union(i, rightIdx);
        }
      }
    }

    // Group by root
    const groups = new Map();
    for(let i = 0; i < cells.length; i++){
      const root = find(i);
      if(!groups.has(root)) groups.set(root, []);
      groups.get(root).push(cells[i]);
    }

    // Compute merged regions
    const regions = [];
    for(const [, group] of groups){
      const box = boundingBox(group);
      // Filter out very small merged regions
      if(box.w * box.h < vpW * vpH * 0.008) continue;
      // Filter out regions covering >90% of page
      if(box.w * box.h > vpW * vpH * 0.90) continue;
      regions.push(box);
    }

    return regions;
  }

  /* ── Visual region layer: tolerance-based connected-component grouping ── */

  /**
   * Builds a general-purpose visual region layer from raw image luminance data.
   *
   * Algorithm (classical CV, no ML):
   *   1. Downsample image to a coarse 64×48 grid.  Each cell stores mean luminance.
   *   2. Run a Union-Find connected-components pass on the grid.  Two adjacent cells
   *      are merged when their mean luminance difference ≤ TOLERANCE (30 / 255).
   *      This gives "magic-wand / paint-bucket" behaviour: large surfaces of similar
   *      brightness merge into one component; sharp contrast boundaries keep regions
   *      separate.
   *   3. Discard components covering < 2 % of the grid (noise / fine detail).
   *   4. Convert surviving components into viewport-space region descriptors with
   *      bounding-box, area fraction, mean luminance, fill ratio, and normalised
   *      coordinates.  Regions are sorted by area (largest first).
   *
   * The result is lightweight and works on any uploaded image, not just documents.
   *
   * @param {object} imageData  { gray: Uint8Array, width: number, height: number }
   * @param {number} vpW        Viewport width in pixels
   * @param {number} vpH        Viewport height in pixels
   * @returns {{ version:number, regions:Array, gridW:number, gridH:number }}
   */
  
  function orientedRectFromPoints(points = [], fallback = null){
    if(!Array.isArray(points) || points.length < 2){
      if(fallback) return {
        center: { x: fallback.x + fallback.w / 2, y: fallback.y + fallback.h / 2 },
        size: { w: fallback.w, h: fallback.h },
        angleDeg: 0
      };
      return null;
    }
    let mx = 0, my = 0;
    for(const p of points){ mx += p.x; my += p.y; }
    mx /= points.length;
    my /= points.length;
    let xx = 0, yy = 0, xy = 0;
    for(const p of points){
      const dx = p.x - mx;
      const dy = p.y - my;
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
    xx /= Math.max(1, points.length);
    yy /= Math.max(1, points.length);
    xy /= Math.max(1, points.length);
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for(const p of points){
      const dx = p.x - mx;
      const dy = p.y - my;
      const u = (dx * cosA) + (dy * sinA);
      const v = (-dx * sinA) + (dy * cosA);
      if(u < minU) minU = u;
      if(u > maxU) maxU = u;
      if(v < minV) minV = v;
      if(v > maxV) maxV = v;
    }
    return {
      center: { x: mx, y: my },
      size: { w: Math.max(1, maxU - minU), h: Math.max(1, maxV - minV) },
      angleDeg: angle * (180 / Math.PI)
    };
  }

function buildVisualRegionLayer(imageData, vpW, vpH){
    if(!imageData || !imageData.gray || !imageData.width || !imageData.height){
      return { version: 1, regions: [], gridW: 0, gridH: 0 };
    }

    const imgW = imageData.width;
    const imgH = imageData.height;
    const gray = imageData.gray;
    const edges = sobelEdges(gray, imgW, imgH);

    // Coarse grid – 64 cols × 48 rows (3072 cells, trivially fast)
    const GW = 64;
    const GH = 48;
    const cellW = imgW / GW;
    const cellH = imgH / GH;

    // ── Step 1: Mean luminance per grid cell ──────────────────────────────
    const lum = new Float32Array(GW * GH);
    for(let gy = 0; gy < GH; gy++){
      for(let gx = 0; gx < GW; gx++){
        const px0 = Math.floor(gx * cellW);
        const py0 = Math.floor(gy * cellH);
        const px1 = Math.min(imgW, Math.ceil((gx + 1) * cellW));
        const py1 = Math.min(imgH, Math.ceil((gy + 1) * cellH));
        let sum = 0, cnt = 0;
        for(let py = py0; py < py1; py++){
          const row = py * imgW;
          for(let px = px0; px < px1; px++){ sum += gray[row + px]; cnt++; }
        }
        lum[gy * GW + gx] = cnt ? sum / cnt : 0;
      }
    }

    // ── Step 2: Union-Find connected components ───────────────────────────
    // Merge adjacent cells (4-connected) when |lum_a – lum_b| ≤ TOLERANCE.
    // TOLERANCE = 30 out of 255 (~12 %) — broad enough to absorb texture
    // variation within a surface, strict enough to respect visual boundaries.
    const TOLERANCE = 30;

    const parent = new Int32Array(GW * GH);
    for(let i = 0; i < parent.length; i++) parent[i] = i;

    function hasStrongEdgeBarrierBetweenCells(gx, gy, direction){
      const EDGE_DENSITY_BLOCK = 0.28;
      let hits = 0;
      let samples = 0;

      if(direction === 'right'){
        const borderX = Math.max(0, Math.min(imgW - 1, Math.round((gx + 1) * cellW)));
        const y0 = Math.max(0, Math.floor(gy * cellH));
        const y1 = Math.min(imgH - 1, Math.ceil((gy + 1) * cellH) - 1);
        for(let y = y0; y <= y1; y++){
          for(let dx = -1; dx <= 1; dx++){
            const sx = borderX + dx;
            if(sx < 0 || sx >= imgW) continue;
            samples += 1;
            if(edges[(y * imgW) + sx]) hits += 1;
          }
        }
      } else if(direction === 'down'){
        const borderY = Math.max(0, Math.min(imgH - 1, Math.round((gy + 1) * cellH)));
        const x0 = Math.max(0, Math.floor(gx * cellW));
        const x1 = Math.min(imgW - 1, Math.ceil((gx + 1) * cellW) - 1);
        for(let x = x0; x <= x1; x++){
          for(let dy = -1; dy <= 1; dy++){
            const sy = borderY + dy;
            if(sy < 0 || sy >= imgH) continue;
            samples += 1;
            if(edges[(sy * imgW) + x]) hits += 1;
          }
        }
      }

      if(samples <= 0) return false;
      return (hits / samples) >= EDGE_DENSITY_BLOCK;
    }

    function find(i){
      // Iterative path-halving
      while(parent[i] !== i){ parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(a, b){
      const ra = find(a), rb = find(b);
      if(ra !== rb) parent[ra] = rb;
    }

    for(let gy = 0; gy < GH; gy++){
      for(let gx = 0; gx < GW; gx++){
        const i   = gy * GW + gx;
        const li  = lum[i];
        // Right
        if(gx + 1 < GW){
          const j = i + 1;
          if(Math.abs(li - lum[j]) <= TOLERANCE && !hasStrongEdgeBarrierBetweenCells(gx, gy, 'right')){
            union(i, j);
          }
        }
        // Below
        if(gy + 1 < GH){
          const j = i + GW;
          if(Math.abs(li - lum[j]) <= TOLERANCE && !hasStrongEdgeBarrierBetweenCells(gx, gy, 'down')){
            union(i, j);
          }
        }
      }
    }

    // ── Step 3: Collect components ────────────────────────────────────────
    const compMap = new Map();
    for(let gy = 0; gy < GH; gy++){
      for(let gx = 0; gx < GW; gx++){
        const i    = gy * GW + gx;
        const root = find(i);
        if(!compMap.has(root)){
          compMap.set(root, { cnt: 0, lumSum: 0, minGx: gx, maxGx: gx, minGy: gy, maxGy: gy, cells: [] });
        }
        const c = compMap.get(root);
        c.cnt++;
        c.lumSum += lum[i];
        c.cells.push({ gx, gy });
        if(gx < c.minGx) c.minGx = gx;
        if(gx > c.maxGx) c.maxGx = gx;
        if(gy < c.minGy) c.minGy = gy;
        if(gy > c.maxGy) c.maxGy = gy;
      }
    }

    // ── Step 4: Filter small components, build region descriptors ─────────
    const totalCells = GW * GH;
    const minCells   = Math.ceil(totalCells * 0.02); // 2 % minimum
    const scaleX     = vpW / GW;
    const scaleY     = vpH / GH;

    const regions = [];
    for(const [, comp] of compMap){
      if(comp.cnt < minCells) continue;

      const x  = comp.minGx * scaleX;
      const y  = comp.minGy * scaleY;
      const w  = (comp.maxGx + 1) * scaleX - x;
      const h  = (comp.maxGy + 1) * scaleY - y;
      // fillRatio: actual cells / bounding-box cells  (1 = solid rectangle)
      const bbCells       = (comp.maxGx - comp.minGx + 1) * (comp.maxGy - comp.minGy + 1);
      const areaFraction  = comp.cnt / totalCells;
      const meanLuminance = (comp.lumSum / comp.cnt) / 255; // normalised [0,1]
      const fillRatio     = comp.cnt / Math.max(1, bbCells);
      const points = comp.cells.map(cell => ({
        x: (cell.gx + 0.5) * scaleX,
        y: (cell.gy + 0.5) * scaleY
      }));
      const rotatedRect = orientedRectFromPoints(points, { x, y, w, h });

      regions.push({
        x, y, w, h,
        cx: x + w / 2,
        cy: y + h / 2,
        nx:  clamp01(x / vpW),
        ny:  clamp01(y / vpH),
        nw:  clamp01(w / vpW),
        nh:  clamp01(h / vpH),
        ncx: clamp01((x + w / 2) / vpW),
        ncy: clamp01((y + h / 2) / vpH),
        cellCount:     comp.cnt,
        areaFraction,
        meanLuminance,
        fillRatio,
        orientation: w >= h ? 'horizontal' : 'vertical',
        geometry: {
          kind: 'rotated_rect',
          rotatedRect,
          bbox: { x, y, w, h }
        }
      });
    }

    // Sort by area descending and assign stable IDs
    regions.sort((a, b) => b.cellCount - a.cellCount);
    regions.forEach((r, i) => { r.id = `vr_${i}`; });

    return { version: 1, regions, gridW: GW, gridH: GH };
  }

  /**
   * Given a pixel-space bounding box and a visual region layer, returns:
   *  - primary: the smallest region whose bounding box contains the bbox centre
   *             (falls back to nearest region by centroid distance)
   *  - memberIds: IDs of every region whose bounding box overlaps the bbox
   *  - relativePos: { rx, ry } — normalised position of bbox centre inside
   *                 the primary region (0 = left/top edge, 1 = right/bottom)
   *
   * These descriptors let you say "this field lives near the top-left of a
   * large dark region" and use that as a matching signal on future uploads.
   */

  function visualRegionToNode(region, idx, vpW, vpH, textMask){
    const box = {
      x: Number(region?.x) || 0,
      y: Number(region?.y) || 0,
      w: Math.max(0, Number(region?.w) || 0),
      h: Math.max(0, Number(region?.h) || 0)
    };
    const textOverlapScore = scoreTextOverlap(box, textMask);
    const fillRatio = Number(region?.fillRatio);
    const areaFraction = Number(region?.areaFraction);
    return {
      id: region?.id || `visual_region_${idx}`,
      type: 'visual_region',
      ...box,
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
      ...pageSpaceNorm(box, vpW, vpH),
      tokenCount: 0,
      orientation: region?.orientation || (box.w >= box.h ? 'horizontal' : 'vertical'),
      contrastScore: Math.max(0.2, Math.min(1, 1 - (Number(region?.meanLuminance) || 0))),
      textOverlapScore,
      stabilityScore: Math.max(0.2, (Number.isFinite(fillRatio) ? fillRatio : 0.6) * 0.75 + (Number.isFinite(areaFraction) ? Math.min(0.25, areaFraction) : 0.15)),
      depth: 0,
      geometry: region?.geometry || null,
      source: 'visual-region-layer'
    };
  }

  function locateBboxInVisualRegions(bbox, visualRegionLayer){
    const regions = visualRegionLayer?.regions;
    if(!bbox || !regions || !regions.length){
      return { primary: null, memberIds: [], relativePos: null };
    }

    const bxc = bbox.x + bbox.w / 2;
    const byc = bbox.y + bbox.h / 2;

    // Most specific (smallest areaFraction) region whose bbox contains the centre
    let primary = null;
    for(const r of regions){
      if(bxc >= r.x && bxc <= r.x + r.w && byc >= r.y && byc <= r.y + r.h){
        if(!primary || r.areaFraction < primary.areaFraction) primary = r;
      }
    }

    // Fallback: nearest region by centroid Manhattan distance
    if(!primary){
      let best = Infinity;
      for(const r of regions){
        const d = Math.abs(bxc - r.cx) + Math.abs(byc - r.cy);
        if(d < best){ best = d; primary = r; }
      }
    }

    // All regions whose bounding box overlaps the bbox at all
    const memberIds = regions.filter(r => {
      const ox = Math.max(0, Math.min(bbox.x + bbox.w, r.x + r.w) - Math.max(bbox.x, r.x));
      const oy = Math.max(0, Math.min(bbox.y + bbox.h, r.y + r.h) - Math.max(bbox.y, r.y));
      return ox * oy > 0;
    }).map(r => r.id);

    const relativePos = primary ? {
      rx: clamp01((bxc - primary.x) / Math.max(1, primary.w)),
      ry: clamp01((byc - primary.y) / Math.max(1, primary.h))
    } : null;

    return {
      primary: primary ? {
        id:           primary.id,
        nx:           primary.nx,  ny:  primary.ny,
        nw:           primary.nw,  nh:  primary.nh,
        ncx:          primary.ncx, ncy: primary.ncy,
        areaFraction: primary.areaFraction,
        meanLuminance:primary.meanLuminance,
        fillRatio:    primary.fillRatio,
        orientation:  primary.orientation
      } : null,
      memberIds,
      relativePos
    };
  }

  /* ── Region-based structural graph (pixel-driven) ──────────────── */

  function buildStructuralGraph(tokens, viewport, textMap, imageData){
    const vpW = Math.max(1, Number(viewport?.width || viewport?.w) || 1);
    const vpH = Math.max(1, Number(viewport?.height || viewport?.h) || 1);
    const normalized = (Array.isArray(tokens) ? tokens : [])
      .map(tok => normToken(tok, viewport)).filter(n => n.text);
    const tm = textMap || buildTextMap(tokens, viewport);
    const textMask = buildTextInfluenceMask(tm);

    // ── Canonical page-space: detect content bounds and store viewport ─────────
    // detectDocumentBounds uses the raw-coordinate token list from normToken output
    // (same pixel space as vpW×vpH).  Result is used to annotate every region node
    // with normalised [0,1] page-space coordinates so the overlay renderer can use
    // the exact same denormalisation path as extraction boxes.
    const rawTokensForBounds = normalized.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    const contentBounds = PageSpace
      ? PageSpace.detectDocumentBounds(rawTokensForBounds, { width: vpW, height: vpH })
      : { x: 0, y: 0, w: vpW, h: vpH };

    const emptyResult = {
      version: 3, background: estimateBackground(tm), textMask,
      nodeCount: 0, edgeCount: 0, nodes: [], edges: [],
      _method: 'none',
      _viewport: { width: vpW, height: vpH },
      _contentBounds: contentBounds
    };

    // imageData: { gray: Uint8Array, width: N, height: N }
    // gray = single-channel luminance values (0-255)
    const hasPixels = imageData && imageData.gray && imageData.width && imageData.height;

    if(!hasPixels && !normalized.length) return emptyResult;

    const visualRegionLayer = hasPixels
      ? buildVisualRegionLayer(imageData, vpW, vpH)
      : { version: 1, regions: [], gridW: 0, gridH: 0 };

    let regionNodes;

    if(hasPixels){
      // ═══ PIXEL-BASED PATH: detect structure from image geometry ═══
      const imgW = imageData.width;
      const imgH = imageData.height;
      const gray = imageData.gray;

      // Phase 1: Build text mask at image resolution
      // Scale token coordinates if image size differs from viewport
      const scaleX = imgW / vpW;
      const scaleY = imgH / vpH;
      const scaledTextMap = {
        nodes: (tm?.nodes || []).map(n => ({
          x: n.x * scaleX, y: n.y * scaleY,
          w: n.w * scaleX, h: n.h * scaleY
        }))
      };
      const textMask2D = buildTextMask2D(scaledTextMap, imgW, imgH, Math.ceil(4 * scaleX));

      // Phase 2: Edge detection with text suppression
      const edges = sobelEdges(gray, imgW, imgH);

      // Phase 3: Detect structural lines (non-text edges only)
      const { hLines: rawHLines, vLines: rawVLines } = detectStructuralLines(edges, textMask2D, imgW, imgH);

      // Scale lines back to viewport coordinates
      const hLines = rawHLines.map(l => ({
        x1: l.x1 / scaleX, y1: l.y1 / scaleY,
        x2: l.x2 / scaleX, y2: l.y2 / scaleY,
        len: l.len / scaleX
      }));
      const vLines = rawVLines.map(l => ({
        x1: l.x1 / scaleX, y1: l.y1 / scaleY,
        x2: l.x2 / scaleX, y2: l.y2 / scaleY,
        len: l.len / scaleY
      }));

      // Phase 4: Whitespace corridor detection (from tokens)
      const { hCorridors, vCorridors } = detectWhitespaceCorridors(normalized, vpW, vpH);

      // Phase 5: Build grid regions from lines + corridors
      const cells = buildRegionsFromLines(hLines, vLines, hCorridors, vCorridors, vpW, vpH);

      // Phase 6: Merge cells that have no structural line between them
      const regions = mergeAdjacentCells(cells, hLines, vLines, vpW, vpH);

      // Build structural region nodes from grid-cells (kept as compatibility layer).
      const panelNodes = regions.map((r, idx) => {
        const textOverlapScore = scoreTextOverlap(r, textMask);
        const tokensInside = normalized.filter(t =>
          t.cx >= r.x && t.cx <= r.x + r.w && t.cy >= r.y && t.cy <= r.y + r.h
        ).length;
        return {
          id: `panel_${idx}`,
          type: 'panel',
          ...r,
          cx: r.x + r.w / 2,
          cy: r.y + r.h / 2,
          ...pageSpaceNorm(r, vpW, vpH),
          tokenCount: tokensInside,
          orientation: r.w >= r.h ? 'horizontal' : 'vertical',
          contrastScore: Math.max(0.2, Math.min(1, (r.w * r.h) / (vpW * vpH * 0.15))),
          textOverlapScore,
          stabilityScore: Math.max(0.1, 1 - (textOverlapScore * 0.5)),
          depth: 0,
          source: 'panel-grid'
        };
      });

      const visualNodes = (visualRegionLayer.regions || []).map((region, idx) =>
        visualRegionToNode(region, idx, vpW, vpH, textMask)
      );

      // Visual-first: keep geometry-driven nodes as primary structure.
      // Retain a reduced panel set as compatibility/debug where it adds detail.
      const panelLimit = Math.max(2, Math.floor(visualNodes.length * 0.5));
      const reducedPanels = panelNodes
        .filter(node => (node.w * node.h) <= (vpW * vpH * 0.6))
        .sort((a, b) => (a.w * a.h) - (b.w * b.h))
        .slice(0, panelLimit);

      regionNodes = [...visualNodes, ...reducedPanels];

    } else {
      // ═══ FALLBACK: whitespace-corridor-only approach ═══
      // When no pixel data available, use whitespace gaps as structural signals
      const { hCorridors, vCorridors } = detectWhitespaceCorridors(normalized, vpW, vpH);

      // Build boundary set from whitespace only
      const cells = buildRegionsFromLines([], [], hCorridors, vCorridors, vpW, vpH);
      // Without structural lines, cells can't be merged intelligently — use as-is
      regionNodes = cells
        .filter(c => c.w * c.h >= vpW * vpH * 0.01) // min 1% of viewport
        .filter(c => c.w * c.h <= vpW * vpH * 0.90)
        .map((r, idx) => {
          const textOverlapScore = scoreTextOverlap(r, textMask);
          const tokensInside = normalized.filter(t =>
            t.cx >= r.x && t.cx <= r.x + r.w && t.cy >= r.y && t.cy <= r.y + r.h
          ).length;
          return {
            id: `region_${idx}`,
            type: 'region',
            ...r,
            cx: r.x + r.w / 2,
            cy: r.y + r.h / 2,
            // ── Canonical page-space coordinates (same normalisation as extraction normBoxes) ──
            ...pageSpaceNorm(r, vpW, vpH),
            tokenCount: tokensInside,
            orientation: r.w >= r.h ? 'horizontal' : 'vertical',
            contrastScore: Math.max(0.2, Math.min(1, tokensInside / 8)),
            textOverlapScore,
            stabilityScore: Math.max(0.05, 1 - (textOverlapScore * 0.65)),
            depth: 0
          };
        });
    }

    if(!regionNodes.length) return emptyResult;

    // ── Build containment hierarchy ──
    // Sort by area descending so larger regions are checked first
    regionNodes.sort((a, b) => (b.w * b.h) - (a.w * a.h));

    const edges = [];

    // Containment: if a region fully contains another, add an edge
    for(let i = 0; i < regionNodes.length; i++){
      const outer = regionNodes[i];
      for(let j = i + 1; j < regionNodes.length; j++){
        const inner = regionNodes[j];
        if(boxContains(outer, inner)){
          // Only add if no intermediate container exists
          let hasCloserParent = false;
          for(let k = i + 1; k < j; k++){
            if(boxContains(regionNodes[k], inner) && boxContains(outer, regionNodes[k])){
              hasCloserParent = true;
              break;
            }
          }
          if(!hasCloserParent){
            edges.push({ from: outer.id, to: inner.id, type: 'contains', dist: 0 });
            inner.depth = (outer.depth || 0) + 1;
          }
        }
      }
    }

    // Adjacency: sibling regions (same depth, no containment) that share a boundary
    for(let i = 0; i < regionNodes.length; i++){
      const a = regionNodes[i];
      for(let j = i + 1; j < regionNodes.length; j++){
        const b = regionNodes[j];
        if(a.depth !== b.depth) continue;
        const { gapX, gapY } = boxGap(a, b);
        // Must be close but not overlapping significantly
        if(gapX > 20 && gapY > 20) continue;
        const overlap = Math.max(0, -gapX) * Math.max(0, -gapY);
        const smallerArea = Math.min(a.w * a.h, b.w * b.h);
        if(overlap > smallerArea * 0.5) continue; // too much overlap = nested, not adjacent

        let adjType = null;
        if(gapX < 0 && Math.abs(gapY) <= 20) adjType = 'adjacent_v';
        else if(gapY < 0 && Math.abs(gapX) <= 20) adjType = 'adjacent_h';
        if(!adjType) continue;

        const dx = (b.cx - a.cx) / vpW;
        const dy = (b.cy - a.cy) / vpH;
        edges.push({ from: a.id, to: b.id, type: adjType, dx, dy, dist: Math.hypot(dx, dy) });
      }
    }

    return {
      version: 3,
      background: estimateBackground(tm),
      textMask,
      nodeCount: regionNodes.length,
      edgeCount: edges.length,
      nodes: regionNodes,
      edges,
      visualRegionLayer,
      _method: hasPixels ? 'pixel' : 'whitespace',
      // ── Canonical page-space metadata ───────────────────────────────────────
      // Stored so the overlay renderer can denormalise using the exact same
      // viewport that was used when building the graph, regardless of any later
      // display-scale changes.  All node nx/ny/nw/nh values are relative to
      // _viewport dimensions (same as extraction normBox storage).
      _viewport: { width: vpW, height: vpH },
      _contentBounds: contentBounds
    };
  }

  function intersectArea(a, b){
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  }

  /**
   * Captures the structural and visual neighbourhood of a configured field box.
   *
   * Returns three kinds of context that are persisted in the field's wrokitVisionConfig
   * and used for matching on future uploads:
   *
   *   textNeighbors         – OCR tokens that overlap the bbox (local text structure)
   *   structuralNeighbors   – nearby structural-graph panel/region nodes
   *   visualRegionContext   – which visual region the bbox sits in, and the bbox's
   *                           relative position within that region
   *
   * The visual region context is derived from structuralGraph.visualRegionLayer,
   * which is built by buildVisualRegionLayer() when pixel data is available.
   */
  function captureFieldNeighborhood(fieldBox, textMap, structuralGraph){
    if(!fieldBox) return { textNeighbors: [], structuralNeighbors: [], visualRegionContext: null };

    const bboxCx = fieldBox.x + fieldBox.w / 2;

    const textNeighbors = (textMap?.nodes || [])
      .filter(n => intersectArea(fieldBox, { x:n.x, y:n.y, w:n.w, h:n.h }) > 0)
      .slice(0, 28)
      .map(n => ({ text: n.text, dx: n.ncx - (bboxCx / Math.max(1, fieldBox.x + fieldBox.w)), dy: n.ncy }));

    const structuralNeighbors = (structuralGraph?.nodes || [])
      .map(n => ({
        id: n.id,
        type: n.type,
        cx: n.cx,
        cy: n.cy,
        distance: Math.abs((n.cx || 0) - bboxCx) + Math.abs((n.cy || 0) - (fieldBox.y + fieldBox.h/2)),
        stabilityScore: n.stabilityScore,
        textOverlapScore: n.textOverlapScore
      }))
      .sort((a,b)=> a.distance - b.distance)
      .slice(0, 10);

    // ── Visual region context ──────────────────────────────────────────────
    // Locate the bbox within the visual region layer that was built alongside
    // the structural graph (pixel path).  This records which broad visual
    // surface/zone the configured field lives in and where inside that region
    // it sits — both become matching signals on future uploads.
    const visualRegionLayer = structuralGraph?.visualRegionLayer;
    const visualRegionContext = (visualRegionLayer && visualRegionLayer.regions && visualRegionLayer.regions.length)
      ? locateBboxInVisualRegions(fieldBox, visualRegionLayer)
      : null;

    return { textNeighbors, structuralNeighbors, visualRegionContext };
  }

  function summarizeTextMap(textMap){
    const nodes = textMap?.nodes || [];
    return {
      version: 1,
      nodeCount: nodes.length,
      sample: nodes.slice(0, 40).map(n => ({ text:n.text, x:n.nx, y:n.ny, w:n.nw, h:n.nh }))
    };
  }

  return {
    buildTextMap,
    buildTextInfluenceMask,
    buildStructuralGraph,
    captureFieldNeighborhood,
    summarizeTextMap,
    buildVisualRegionLayer,
    locateBboxInVisualRegions
  };
});
