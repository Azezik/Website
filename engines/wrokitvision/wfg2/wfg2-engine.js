(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  }
  root.WrokitFeatureGraph2 = factory();
})(typeof window !== 'undefined' ? window : globalThis, function(){
  const DEFAULT_PARAMS = Object.freeze({ gridSize: 10, edgeSensitivity: 28, mergeThreshold: 18, minRegionArea: 0.003, fragmentationTolerance: 0.22, rectangularBiasPenalty: 0.35 });
  const FEEDBACK_TAGS = Object.freeze(['too_many_regions','too_few_regions','boundaries_inaccurate','merged_objects','split_object','missed_object','too_grid_like','shape_mismatch','noisy_fragmented','other']);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const copyParams = (params) => ({ ...DEFAULT_PARAMS, ...(params || {}) });

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
    const outGray = new Uint8Array(outW * outH);
    for(let y = 0; y < outH; y++){
      const srcY = Math.min(height - 1, Math.round(y / scale));
      for(let x = 0; x < outW; x++){
        const srcX = Math.min(width - 1, Math.round(x / scale));
        outGray[y * outW + x] = gray[srcY * width + srcX] || 0;
      }
    }
    const stretched = stretchContrast(outGray);
    return { kind: 'wfg2-normalized-surface', width: outW, height: outH, gray: boxBlur3x3(stretched, outW, outH), source: { width, height, scale }, artifacts: { contrastStretched: true, blurred: true } };
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

  function generateFeatureGraph(normalizedSurface, params){
    if(!normalizedSurface?.gray) return null;
    const p = copyParams(params);
    const w = normalizedSurface.width, h = normalizedSurface.height, gray = normalizedSurface.gray, grad = computeGradient(gray, w, h);
    const grid = Math.max(4, Math.round(p.gridSize)), cols = Math.ceil(w / grid), rows = Math.ceil(h / grid), cells = new Array(cols * rows);
    for(let cy = 0; cy < rows; cy++) for(let cx = 0; cx < cols; cx++){
      const idx = cy * cols + cx;
      let sumGray = 0, sumGrad = 0, count = 0;
      const x0 = cx * grid, y0 = cy * grid, x1 = Math.min(w, x0 + grid), y1 = Math.min(h, y0 + grid);
      for(let y = y0; y < y1; y++) for(let x = x0; x < x1; x++){ const pi = y * w + x; sumGray += gray[pi]; sumGrad += grad[pi]; count++; }
      cells[idx] = { idx, cx, cy, x0, y0, x1, y1, meanGray: sumGray / Math.max(1, count), meanGrad: sumGrad / Math.max(1, count) };
    }
    const visited = new Uint8Array(cells.length), regions = [], neighbors = [[1,0],[-1,0],[0,1],[0,-1]];
    for(let i = 0; i < cells.length; i++){
      if(visited[i]) continue;
      const seed = cells[i], queue = [seed], memberIdx = []; visited[i] = 1;
      while(queue.length){
        const cell = queue.pop(); memberIdx.push(cell.idx);
        for(const n of neighbors){
          const nx = cell.cx + n[0], ny = cell.cy + n[1];
          if(nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx; if(visited[ni]) continue;
          const c2 = cells[ni], toneDiff = Math.abs(c2.meanGray - seed.meanGray), edgeBarrier = (c2.meanGrad + cell.meanGrad) * 0.5;
          if(toneDiff <= p.mergeThreshold && edgeBarrier <= p.edgeSensitivity){ visited[ni] = 1; queue.push(c2); }
        }
      }
      regions.push(makeRegionFromCells(memberIdx, cells, grid, w, h, p));
    }
    const minPixels = Math.max(25, Math.round(w * h * p.minRegionArea));
    const filtered = regions.filter(r => r.area >= minPixels);
    return { engine: 'WFG2', version: 1, parameters: p, normalizedSize: { width: w, height: h }, nodes: filtered, edges: buildAdjacency(filtered), artifacts: { contourLayer: filtered.map(r => ({ id: r.id, contour: r.contour })), debugPrimitives: filtered.map(r => ({ id: r.id, bbox: r.bbox, compactness: r.compactness })) } };
  }

  function makeRegionFromCells(memberIdx, cells, grid, w, h, params){
    let minX = w, minY = h, maxX = 0, maxY = 0;
    const points = [];
    for(const idx of memberIdx){
      const c = cells[idx];
      minX = Math.min(minX, c.x0); minY = Math.min(minY, c.y0); maxX = Math.max(maxX, c.x1); maxY = Math.max(maxY, c.y1);
      points.push([c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]);
    }
    const area = memberIdx.length * grid * grid, bboxArea = Math.max(1, (maxX - minX) * (maxY - minY)), fillRatio = clamp(area / bboxArea, 0, 1);
    return {
      id: 'wfg2-r-' + Math.random().toString(36).slice(2, 10),
      type: 'visual_region',
      bbox: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) },
      center: { x: minX + (maxX - minX) * 0.5, y: minY + (maxY - minY) * 0.5 },
      area,
      contour: hull(points).map(p => ({ x: p[0], y: p[1] })),
      compactness: clamp((fillRatio * 0.8) + (memberIdx.length > 1 ? 0.2 : 0), 0, 1) - (1 - fillRatio) * params.rectangularBiasPenalty
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
    if(tags.has('too_many_regions')){ p.mergeThreshold += 3; p.minRegionArea += 0.0007; p.fragmentationTolerance += 0.02; }
    if(tags.has('too_few_regions')){ p.mergeThreshold -= 2; p.minRegionArea -= 0.0008; }
    if(tags.has('boundaries_inaccurate') || tags.has('merged_objects')){ p.edgeSensitivity -= 3; p.mergeThreshold -= 1; }
    if(tags.has('split_object') || tags.has('noisy_fragmented')){ p.mergeThreshold += 2; p.edgeSensitivity += 1; }
    if(tags.has('missed_object')){ p.minRegionArea -= 0.001; p.edgeSensitivity += 1; }
    if(tags.has('too_grid_like') || tags.has('shape_mismatch')){ p.rectangularBiasPenalty += 0.08; p.gridSize = Math.max(6, p.gridSize - 1); }
    const rating = Number(feedback?.rating || 0);
    if(Number.isFinite(rating) && rating > 0){ if(rating <= 2) p.edgeSensitivity = Math.max(8, p.edgeSensitivity - 1); if(rating >= 4) p.mergeThreshold = Math.min(60, p.mergeThreshold + 1); }
    p.gridSize = clamp(Math.round(p.gridSize), 4, 24); p.edgeSensitivity = clamp(Math.round(p.edgeSensitivity), 8, 120); p.mergeThreshold = clamp(Math.round(p.mergeThreshold), 4, 60); p.minRegionArea = clamp(p.minRegionArea, 0.0004, 0.08); p.fragmentationTolerance = clamp(p.fragmentationTolerance, 0.05, 0.8); p.rectangularBiasPenalty = clamp(p.rectangularBiasPenalty, 0, 1);
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

  return { DEFAULT_PARAMS, FEEDBACK_TAGS, copyParams, normalizeVisualInput, generateFeatureGraph, adaptParametersFromFeedback, createAttemptStore };
});
