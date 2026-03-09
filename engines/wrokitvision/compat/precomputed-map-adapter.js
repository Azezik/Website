(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WrokitVisionPrecomputedCompat = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  function clamp01(value){
    const n = Number(value);
    if(!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function normalizeViewport(viewport){
    return {
      width: Math.max(1, Number(viewport?.width || viewport?.w) || 1),
      height: Math.max(1, Number(viewport?.height || viewport?.h) || 1)
    };
  }



  function normalizeGeometry(region){
    const geometry = region?.geometry || {};
    const bbox = geometry?.bbox || {};
    const normalizedBBox = {
      x: Number(bbox.x) || 0,
      y: Number(bbox.y) || 0,
      w: Math.max(0, Number(bbox.w) || 0),
      h: Math.max(0, Number(bbox.h) || 0)
    };
    if(Array.isArray(geometry.contour) && geometry.contour.length >= 3){
      return { kind: 'contour', points: geometry.contour, bbox: normalizedBBox };
    }
    if(Array.isArray(geometry.hull) && geometry.hull.length >= 3){
      return { kind: 'hull', points: geometry.hull, bbox: normalizedBBox };
    }
    if(geometry.rotatedRect?.center){
      return { kind: 'rotated_rect', rotatedRect: geometry.rotatedRect, bbox: normalizedBBox };
    }
    return { kind: 'bbox', bbox: normalizedBBox };
  }

  function toLegacyTextNode(token, viewport){
    const bbox = token?.geometry?.bbox || {};
    const x = Number(bbox.x) || 0;
    const y = Number(bbox.y) || 0;
    const w = Math.max(0, Number(bbox.w) || 0);
    const h = Math.max(0, Number(bbox.h) || 0);
    return {
      id: token?.id || null,
      text: String(token?.text || ''),
      x,
      y,
      w,
      h,
      cx: x + (w / 2),
      cy: y + (h / 2),
      nx: clamp01(x / viewport.width),
      ny: clamp01(y / viewport.height),
      nw: clamp01(w / viewport.width),
      nh: clamp01(h / viewport.height),
      ncx: clamp01((x + (w / 2)) / viewport.width),
      ncy: clamp01((y + (h / 2)) / viewport.height)
    };
  }

  function toLegacyStructuralNode(region, viewport){
    const bbox = region?.geometry?.bbox || {};
    const x = Number(bbox.x) || 0;
    const y = Number(bbox.y) || 0;
    const w = Math.max(0, Number(bbox.w) || 0);
    const h = Math.max(0, Number(bbox.h) || 0);
    const cx = x + (w / 2);
    const cy = y + (h / 2);
    const confidence = Number(region?.confidence) || 0;
    const textDensity = Number(region?.textDensity) || 0;

    return {
      id: region?.id || null,
      type: 'region_surface',
      derivedPanelClass: region?.surfaceTypeCandidate === 'panel' ? 'panel' : null,
      surfaceTypeCandidate: region?.surfaceTypeCandidate || 'unknown',
      x,
      y,
      w,
      h,
      cx,
      cy,
      nx: clamp01(x / viewport.width),
      ny: clamp01(y / viewport.height),
      nw: clamp01(w / viewport.width),
      nh: clamp01(h / viewport.height),
      ncx: clamp01(cx / viewport.width),
      ncy: clamp01(cy / viewport.height),
      areaFraction: clamp01((w * h) / (viewport.width * viewport.height)),
      orientation: (region?.geometry?.orientation || 0) > 0 ? 'rotated' : (w >= h ? 'horizontal' : 'vertical'),
      textOverlapScore: clamp01(textDensity),
      stabilityScore: clamp01((confidence * 0.8) + ((1 - textDensity) * 0.2)),
      provenance: region?.provenance || null,
      geometry: normalizeGeometry(region)
    };
  }

  function buildVisualRegionLayer(regionNodes, viewport){
    const regions = (Array.isArray(regionNodes) ? regionNodes : []).map((node) => {
      const meanLuminance = Number(node?.features?.meanLuminanceNorm);
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        cx: node.cx,
        cy: node.cy,
        nx: node.nx,
        ny: node.ny,
        nw: node.nw,
        nh: node.nh,
        ncx: node.ncx,
        ncy: node.ncy,
        areaFraction: node.areaFraction,
        meanLuminance: Number.isFinite(meanLuminance) ? clamp01(meanLuminance) : 0.5,
        fillRatio: 1,
        orientation: node.orientation,
        provenance: node.provenance || null,
        geometry: node.geometry || { kind: 'bbox', bbox: { x: node.x, y: node.y, w: node.w, h: node.h } }
      };
    });

    return {
      version: 2,
      role: 'geometry-faithful-debug',
      bboxLayerRole: 'compatibility-bbox-debug',
      regions,
      gridW: Math.max(1, Math.round(viewport.width / 16)),
      gridH: Math.max(1, Math.round(viewport.height / 16))
    };
  }

  // Remap a typed graph edge (sourceNodeId/targetNodeId/edgeType) to the legacy
  // format (from/to/type) expected by the overlay renderer.
  function toLegacyEdge(edge){
    return {
      from: edge.sourceNodeId || edge.from || null,
      to:   edge.targetNodeId || edge.to   || null,
      type: edge.edgeType     || edge.type || 'unknown',
      weight: typeof edge.weight === 'number' ? edge.weight : 1
    };
  }

  function adaptPrecomputedStructuralMapToLegacyMaps(precomputedStructuralMap, fallbackTokens = [], fallbackViewport = null){
    const analysis = precomputedStructuralMap?.uploadedImageAnalysis || {};
    const viewport = normalizeViewport(analysis.viewport || fallbackViewport || null);
    const textTokens = Array.isArray(analysis.textTokens) ? analysis.textTokens : [];
    const textNodes = textTokens.length
      ? textTokens.map(token => toLegacyTextNode(token, viewport)).filter(node => node.text)
      : (Array.isArray(fallbackTokens) ? fallbackTokens : []).map(tok => ({
        text: String(tok?.text || ''),
        x: Number(tok?.x) || 0,
        y: Number(tok?.y) || 0,
        w: Math.max(0, Number(tok?.w) || 0),
        h: Math.max(0, Number(tok?.h) || 0,
        )
      })).filter(t => t.text).map(tok => ({
        ...tok,
        cx: tok.x + tok.w / 2,
        cy: tok.y + tok.h / 2,
        nx: clamp01(tok.x / viewport.width),
        ny: clamp01(tok.y / viewport.height),
        nw: clamp01(tok.w / viewport.width),
        nh: clamp01(tok.h / viewport.height),
        ncx: clamp01((tok.x + tok.w / 2) / viewport.width),
        ncy: clamp01((tok.y + tok.h / 2) / viewport.height)
      }));

    const regionNodes = (analysis.regionNodes || []).map(region => toLegacyStructuralNode(region, viewport));

    // Remap typed structural edges (sourceNodeId/targetNodeId/edgeType) → legacy
    // (from/to/type) so the overlay renderer can resolve edge endpoints by node id.
    const regionEdges = Array.isArray(analysis.regionGraph?.edges)
      ? analysis.regionGraph.edges.map(toLegacyEdge)
      : [];

    // Wire text-graph edges from the typed textGraph.  The overlay renderer
    // uses integer array indices (edge.from, edge.to) into the textNodes array,
    // so we build an id→index map and remap the typed sourceNodeId/targetNodeId.
    const textNodeIndexById = new Map(textNodes.map((n, i) => [n.id, i]));
    const typedTextEdges = Array.isArray(analysis.textGraph?.edges) ? analysis.textGraph.edges : [];
    const textEdges = typedTextEdges.reduce((acc, edge) => {
      const fromIdx = textNodeIndexById.get(edge.sourceNodeId ?? edge.from);
      const toIdx   = textNodeIndexById.get(edge.targetNodeId ?? edge.to);
      if(fromIdx != null && toIdx != null){
        acc.push({ from: fromIdx, to: toIdx, type: edge.edgeType || edge.type || 'unknown' });
      }
      return acc;
    }, []);

    return {
      source: 'precomputed-structural-map',
      precomputedStructuralMap,
      textMap: {
        version: 1,
        nodeCount: textNodes.length,
        edgeCount: textEdges.length,
        nodes: textNodes,
        edges: textEdges
      },
      structuralGraph: {
        version: 3,
        nodeCount: regionNodes.length,
        edgeCount: regionEdges.length,
        nodes: regionNodes,
        edges: regionEdges,
        visualRegionLayer: buildVisualRegionLayer(regionNodes, viewport),
        _method: 'precomputed-adapter',
        _viewport: viewport,
        _contentBounds: { x: 0, y: 0, w: viewport.width, h: viewport.height }
      }
    };
  }

  return { adaptPrecomputedStructuralMapToLegacyMaps };
});
