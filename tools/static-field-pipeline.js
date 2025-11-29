(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./static-field-mode.js'));
  else root.StaticFieldPipeline = factory(root.StaticFieldMode);
})(typeof self !== 'undefined' ? self : this, function(StaticFieldMode){
  const tokensInBox = StaticFieldMode?.tokensInBox || (()=>[]);
  const assembleTextFromBox = StaticFieldMode?.assembleTextFromBox || null;
  const collectFullText = StaticFieldMode?.collectFullText || null;

  function normalizeOptions(fieldSpec={}, defaults={}){
    const base = defaults || {};
    const staticPad = Number.isFinite(fieldSpec.staticPad)
      ? fieldSpec.staticPad
      : (Number.isFinite(base.staticPad) ? base.staticPad : 1);
    const isMultiline = fieldSpec.isMultiline ?? base.isMultiline ?? false;
    const lineMetrics = fieldSpec.lineMetrics || base.lineMetrics || null;
    const lineHeights = fieldSpec.lineHeights
      || base.lineHeights
      || (lineMetrics?.lineHeights || null);
    const lineCount = fieldSpec.lineCount
      ?? lineMetrics?.lineCount
      ?? base.lineCount
      ?? (lineMetrics?.lineCount ?? null);
    return { staticPad, isMultiline, lineMetrics, lineCount, lineHeights };
  }

  function expandSearchBox(box, options={}){
    if(!box) return box;
    const pad = Number.isFinite(options.staticPad) && options.staticPad > 0 ? options.staticPad : 1;
    const base = { ...box };
    let scale = pad;
    const lm = options.lineMetrics || {};
    const expectedLineCount = options.lineCount || lm.lineCount;
    const medianHeight = options.lineHeights?.median ?? lm?.lineHeights?.median ?? null;
    if(Number.isFinite(expectedLineCount) && expectedLineCount > 1 && Number.isFinite(medianHeight) && medianHeight > 0){
      const desiredHeight = expectedLineCount * medianHeight;
      if(base.h){
        scale = Math.max(scale, desiredHeight / base.h);
      }
    }
    if(scale === 1) return base;
    const dw = (base.w || 0) * (scale - 1) / 2;
    const dh = (base.h || 0) * (scale - 1) / 2;
    return { x: base.x - dw, y: base.y - dh, w: (base.w || 0) * scale, h: (base.h || 0) * scale, page: base.page };
  }

  function assembleForRun(opts={}){
    const { tokens=[], snapBox, snappedText='', minOverlap=0.5, options={}, lineTol=4 } = opts || {};
    const normalized = normalizeOptions(options);
    const box = expandSearchBox(snapBox, normalized);
    const assembler = assembleTextFromBox || collectFullText;
    if(assembler){
      const assembled = assembler({ tokens, box, snappedText, multiline: !!normalized.isMultiline, minOverlap, lineTol });
      return { ...assembled, box, options: normalized };
    }
    const hits = tokensInBox(tokens, box, { minOverlap });
    return { hits, lines: [], text: snappedText || '', box, lineMetrics: null, lineCount: 0, lineHeights: null, options: normalized };
  }

  function finalizeConfig(opts={}){
    const { tokens=[], selectionBox=null, snappedBox=null, snappedText='', cleanFn=null, fieldKey='', fieldSpec=null, mode='CONFIG' } = opts || {};
    const options = normalizeOptions(fieldSpec || opts);
    const extractor = StaticFieldMode?.finalizeConfigValue || StaticFieldMode?.extractConfigStatic || null;
    if(extractor){
      const res = extractor({ tokens, selectionBox, snappedBox, snappedText, cleanFn, fieldKey, mode, multiline: !!options.isMultiline });
      return { ...res, options };
    }
    const box = selectionBox || snappedBox || null;
    if(!box){
      return { hits: [], text: '', value: '', raw: '', box: null, cleaned: null, lineMetrics: null, lineCount: 0, lineHeights: null, options };
    }
    const assembled = assembleForRun({ tokens, snapBox: box, snappedText, options, minOverlap: 0.5 });
    const cleaned = cleanFn ? cleanFn(fieldKey || '', assembled.text, mode) : null;
    return { ...assembled, value: assembled.text, raw: assembled.text, box: assembled.box, cleaned, options };
  }

  return { normalizeOptions, expandSearchBox, assembleForRun, finalizeConfig };
});
