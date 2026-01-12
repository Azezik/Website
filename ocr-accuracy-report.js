(function initOcrAccuracyReport(global){
  const ANY_TOKEN = 'any';
  const VERIFY_DONE_EVENT = 'ocrmagic.anyfield.verify.done';
  const VERIFY_SKIP_EVENT = 'ocrmagic.anyfield.verify.skip';
  const MAGIC_TYPE_EVENT = 'ocrmagic.magictype.processed';
  const APPLY_EVENT = 'ocrmagic.apply';

  function normalizeFieldKey(value){
    if(value === null || value === undefined) return '';
    return String(value).trim().toLowerCase();
  }

  function isAny(value){
    if(value === null || value === undefined) return false;
    return String(value).trim().toLowerCase() === ANY_TOKEN;
  }

  function safeJsonParse(value){
    try { return JSON.parse(value); }
    catch(err){ return null; }
  }

  function parseLine(line){
    let trimmed = (line || '').trim();
    if(!trimmed) return null;
    trimmed = trimmed.replace(/^\[[^\]]+\]\s*/, '');
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if(firstBrace !== -1 && lastBrace > firstBrace){
      const label = trimmed.slice(0, firstBrace).trim();
      const jsonText = trimmed.slice(firstBrace, lastBrace + 1).trim();
      const details = safeJsonParse(jsonText);
      return { label, details, line: trimmed };
    }
    return { label: trimmed, details: null, line: trimmed };
  }

  function extractFieldKey(details){
    if(!details || typeof details !== 'object') return '';
    return normalizeFieldKey(details.fieldKey || details.field || details.key || '');
  }

  function extractMode(details){
    if(!details || typeof details !== 'object') return null;
    const mode = details.mode || details.meta?.mode || null;
    if(!mode) return null;
    return String(mode).toUpperCase();
  }

  function extractRulesApplied(details){
    if(!details || typeof details !== 'object') return [];
    const rules = details.rulesApplied ?? details.rules ?? [];
    if(Array.isArray(rules)){
      return rules.map(rule => String(rule)).filter(Boolean);
    }
    if(typeof rules === 'string'){
      return rules.split(',').map(rule => rule.trim()).filter(Boolean);
    }
    return [];
  }

  function extractTraceContext(details){
    if(!details || typeof details !== 'object') return null;
    const docId = details.docId ?? details.documentId ?? details.meta?.docId ?? null;
    const page = details.page ?? details.pageIndex ?? details.meta?.page ?? null;
    if(docId === null && page === null) return null;
    return { docId, page };
  }

  function extractVerifyCleaned(details){
    if(!details || typeof details !== 'object') return null;
    const candidates = [
      details.cleaned,
      details.value,
      details.after,
      details.result,
      details.final,
      details.verified,
      details.text
    ];
    for(const candidate of candidates){
      if(candidate !== undefined && candidate !== null){
        return String(candidate);
      }
    }
    return null;
  }

  function buildRow({ fieldKey, mode, raw, cleaned, rulesApplied, confidence, traceContext }){
    return {
      fieldKey,
      mode,
      raw,
      cleaned,
      changed: raw !== cleaned,
      correctedBy: 'none',
      rulesApplied,
      confidence: confidence ?? null,
      ...(traceContext ? { traceContext } : {})
    };
  }

  function ensureFieldStats(stats, fieldKey){
    if(!fieldKey) return;
    if(!stats.perField[fieldKey]){
      stats.perField[fieldKey] = {
        total: 0,
        changed: 0,
        byCorrector: { none: 0, ocrmagic: 0, tesseract: 0, 'upstream/pdf.js': 0 }
      };
    }
  }

  function finalizeRows(rows){
    const stats = {
      totalAnyOccurrences: rows.length,
      totalChanges: 0,
      changesByCorrector: {
        none: 0,
        ocrmagic: 0,
        tesseract: 0,
        'upstream/pdf.js': 0
      },
      perField: {},
      introducedErrors: 0,
      tesseractSkippedAlignFail: 0
    };

    rows.forEach(row => {
      if(row.changed){
        stats.totalChanges += 1;
      }
      const corrector = row.correctedBy || 'none';
      if(stats.changesByCorrector[corrector] !== undefined){
        stats.changesByCorrector[corrector] += 1;
      }
      ensureFieldStats(stats, row.fieldKey);
      const fieldStats = stats.perField[row.fieldKey];
      if(fieldStats){
        fieldStats.total += 1;
        if(row.changed){
          fieldStats.changed += 1;
        }
        if(fieldStats.byCorrector[corrector] !== undefined){
          fieldStats.byCorrector[corrector] += 1;
        }
      }
      if(row._introducedError){
        stats.introducedErrors += 1;
      }
      if(row._tesseractSkippedAlignFail){
        stats.tesseractSkippedAlignFail += 1;
      }
      delete row._introducedError;
      delete row._tesseractSkippedAlignFail;
      delete row._applyChanged;
      delete row._preview;
    });

    return stats;
  }

  function parseOcrAccuracyReport(logText){
    const lines = String(logText || '').split(/\r?\n/);
    const rows = [];
    const lastMagicTypeByField = {};
    const lastPreviewByField = {};
    const lastRowByField = {};
    const rowMetaByField = {};

    lines.forEach(rawLine => {
      const parsed = parseLine(rawLine);
      if(!parsed) return;
      const label = (parsed.label || '').trim();
      const labelLower = label.toLowerCase();
      const details = parsed.details;

      if(/static-debug resolve/i.test(parsed.line)){
        const match = parsed.line.match(/static-debug resolve\s+([^:]+):\s*preview=\"([^\"]*)\"/i);
        if(match){
          const fieldKey = normalizeFieldKey(match[1]);
          lastPreviewByField[fieldKey] = match[2];
        }
      }

      if(labelLower.includes(MAGIC_TYPE_EVENT)){
        const fieldKey = extractFieldKey(details);
        if(fieldKey){
          lastMagicTypeByField[fieldKey] = details?.magicTypeResolved ?? details?.magicType ?? null;
        }
      }

      if(labelLower.includes(APPLY_EVENT)){
        const fieldKey = extractFieldKey(details);
        const magicTypeResolved = details?.magicDataType ?? lastMagicTypeByField[fieldKey];
        if(!isAny(magicTypeResolved)) return;
        const raw = details?.raw ?? '';
        const cleaned = details?.cleaned ?? raw;
        const rulesApplied = extractRulesApplied(details);
        const mode = extractMode(details);
        const confidence = details?.confidence ?? null;
        const traceContext = extractTraceContext(details);
        const row = buildRow({ fieldKey, mode, raw, cleaned, rulesApplied, confidence, traceContext });
        row._applyChanged = row.changed;
        row._preview = lastPreviewByField[fieldKey] || null;
        delete lastPreviewByField[fieldKey];
        rows.push(row);
        lastRowByField[fieldKey] = row;
        rowMetaByField[fieldKey] = {
          preVerifyCleaned: row.cleaned,
          raw: row.raw
        };
      }

      if(labelLower.includes(VERIFY_DONE_EVENT)){
        const fieldKey = extractFieldKey(details);
        const magicTypeResolved = details?.magicTypeResolved ?? lastMagicTypeByField[fieldKey];
        if(!isAny(magicTypeResolved)) return;
        const row = lastRowByField[fieldKey];
        if(!row) return;
        if(details?.confidence !== undefined && details?.confidence !== null){
          row.confidence = details.confidence;
        }
        const verifyChanged = details?.changed === true;
        if(verifyChanged){
          const postCleaned = extractVerifyCleaned(details);
          const meta = rowMetaByField[fieldKey] || {};
          if(postCleaned !== null && postCleaned !== undefined){
            if(row._applyChanged && meta.raw !== undefined && postCleaned === String(meta.raw)){
              row._introducedError = true;
            }
            row.cleaned = String(postCleaned);
          }
          row.changed = row.raw !== row.cleaned;
          row.correctedBy = 'tesseract';
        }
      }

      if(labelLower.includes(VERIFY_SKIP_EVENT)){
        const fieldKey = extractFieldKey(details);
        const magicTypeResolved = details?.magicTypeResolved ?? lastMagicTypeByField[fieldKey];
        if(!isAny(magicTypeResolved)) return;
        if(details?.reason === 'alignFail'){
          const row = lastRowByField[fieldKey];
          if(row){
            row._tesseractSkippedAlignFail = true;
          }
        }
      }
    });

    rows.forEach(row => {
      if(!row.changed){
        row.correctedBy = 'none';
        return;
      }
      if(row.correctedBy === 'tesseract'){
        return;
      }
      if(row._applyChanged){
        row.correctedBy = 'ocrmagic';
        return;
      }
      if(row._preview && row._preview !== row.cleaned){
        row.correctedBy = 'upstream/pdf.js';
        return;
      }
      row.correctedBy = 'none';
    });

    const stats = finalizeRows(rows);
    return { rows, stats };
  }

  global.parseOcrAccuracyReport = parseOcrAccuracyReport;
})(window);
