(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartReady = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  const VERSION = 1;
  const CANONICAL_HEADER = ['event_date', 'money_in', 'money_out', 'gross_or_total', 'ytd_total', 'doc_id'];
  const HEADER_ALIASES = {
    event_date: ['event_date'],
    money_in: ['money_in'],
    money_out: ['money_out'],
    gross_or_total: ['gross_or_total', 'total_amount'],
    ytd_total: ['ytd_total'],
    doc_id: ['doc_id', 'file_id']
  };

  function cleanText(value){
    if(value === undefined || value === null) return '';
    return String(value).trim();
  }

  function normalizeHeader(value){
    return cleanText(value)
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
  }

  function parseCsvLine(line){
    const out = [];
    let cur = '';
    let inQuotes = false;
    for(let i = 0; i < line.length; i++){
      const ch = line[i];
      if(ch === '"'){
        if(inQuotes && line[i + 1] === '"'){
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if(ch === ',' && !inQuotes){
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function parseCsvText(csvText){
    const lines = String(csvText || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if(!lines.length) return { header: [], rows: [] };
    const header = parseCsvLine(lines[0]).map(cleanText);
    const rows = lines.slice(1).map(line => parseCsvLine(line));
    return { header, rows };
  }

  function parseNumeric(value){
    if(value === undefined || value === null) return null;
    const raw = cleanText(value);
    if(!raw) return null;
    const negativeParen = /^\(.*\)$/.test(raw);
    const normalized = raw
      .replace(/[\$,\s]/g, '')
      .replace(/^\((.*)\)$/, '$1')
      .replace(/[^0-9.+-]/g, '');
    if(!normalized || /^[-+.]$/.test(normalized)) return null;
    const num = Number(normalized);
    if(!Number.isFinite(num)) return null;
    return negativeParen ? -Math.abs(num) : num;
  }

  function parseEventDate(value){
    const text = cleanText(value);
    if(!text) return null;
    if(/^\d{4}-\d{2}-\d{2}$/.test(text)){
      return isValidYmd(text) ? text : null;
    }
    if(/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(text)){
      const parts = text.split(/[/-]/).map(v => Number(v));
      const [a,b,c] = parts;
      const mmdd = toIso(c, a, b);
      const ddmm = toIso(c, b, a);
      if(mmdd && ddmm){
        return a > 12 ? ddmm : mmdd;
      }
      return mmdd || ddmm;
    }
    const parsed = new Date(text);
    if(Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  }

  function isValidYmd(iso){
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return !!toIso(y, mo, d);
  }

  function toIso(y, m, d){
    if(!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if(m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if(dt.getUTCFullYear() !== y || (dt.getUTCMonth() + 1) !== m || dt.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function resolveColumns(headerRow){
    const map = {};
    const normalized = Array.isArray(headerRow) ? headerRow.map(normalizeHeader) : [];
    CANONICAL_HEADER.forEach(col => {
      const canonicalIndex = normalized.indexOf(col);
      if(canonicalIndex >= 0){
        map[col] = canonicalIndex;
        return;
      }
      const aliases = HEADER_ALIASES[col] || [];
      let aliasIndex = -1;
      for(let i = 0; i < aliases.length; i++){
        const idx = normalized.indexOf(aliases[i]);
        if(idx >= 0){
          aliasIndex = idx;
          break;
        }
      }
      map[col] = aliasIndex;
    });
    return map;
  }

  function rowCells(row){
    if(Array.isArray(row)) return row;
    if(row && Array.isArray(row.cells)) return row.cells;
    return [];
  }

  function buildDatasets(events){
    const series = {
      money_in: [],
      money_out: [],
      gross_or_total: [],
      ytd_total: []
    };
    (Array.isArray(events) ? events : []).forEach(event => {
      ['money_in', 'money_out', 'gross_or_total', 'ytd_total'].forEach(key => {
        if(Number.isFinite(event[key])) series[key].push({ x: event.event_date, y: event[key] });
      });
    });
    return series;
  }

  function fromRows(payload, options){
    const opts = options || {};
    const source = opts.source || 'generate';
    const header = Array.isArray(payload?.header) ? payload.header : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const cols = resolveColumns(header);
    const errors = [];
    const warnings = [];
    CANONICAL_HEADER.forEach(col => {
      if(col === 'ytd_total') return;
      if(cols[col] < 0) errors.push(`Missing required column: ${col}`);
    });
    if(errors.length){
      return {
        version: VERSION,
        createdAtISO: new Date().toISOString(),
        source,
        summary: { totalRowsRead: rows.length, rowsUsed: 0, rowsExcludedInvalidEventDate: rows.length, dedupeCollisionsResolved: 0 },
        errors,
        warnings,
        invalidRows: rows.map((row, idx) => ({ rowIndex: idx + 1, reason: 'missing_required_columns', row: rowCells(row) })),
        datasets: buildDatasets([])
      };
    }

    const lastByDocId = new Map();
    let dedupeCollisionsResolved = 0;
    const invalidRows = [];

    rows.forEach((row, idx) => {
      const cells = rowCells(row);
      const docIdRaw = cleanText(cells[cols.doc_id]);
      const docId = docIdRaw || `__row_${idx}`;
      const eventDateRaw = cleanText(cells[cols.event_date]);
      const eventDate = parseEventDate(eventDateRaw);
      const event = {
        event_date: eventDate,
        money_in: parseNumeric(cells[cols.money_in]),
        money_out: parseNumeric(cells[cols.money_out]),
        gross_or_total: parseNumeric(cells[cols.gross_or_total]),
        ytd_total: cols.ytd_total >= 0 ? parseNumeric(cells[cols.ytd_total]) : null,
        doc_id: docId
      };
      if(!eventDate){
        invalidRows.push({ rowIndex: idx + 1, reason: 'invalid_event_date', doc_id: docId, event_date: eventDateRaw, row: cells });
      }
      if(lastByDocId.has(docId)) dedupeCollisionsResolved += 1;
      lastByDocId.set(docId, event);
    });

    const deduped = Array.from(lastByDocId.values());
    const validEvents = deduped.filter(e => !!e.event_date);
    validEvents.sort((a, b) => {
      if(a.event_date < b.event_date) return -1;
      if(a.event_date > b.event_date) return 1;
      if(a.doc_id < b.doc_id) return -1;
      if(a.doc_id > b.doc_id) return 1;
      return 0;
    });

    const datasets = buildDatasets(validEvents);
    if(!datasets.ytd_total.length) warnings.push('No valid ytd_total values found; YTD chart may be omitted.');

    return {
      version: VERSION,
      createdAtISO: new Date().toISOString(),
      source,
      summary: {
        totalRowsRead: rows.length,
        rowsUsed: validEvents.length,
        rowsExcludedInvalidEventDate: deduped.length - validEvents.length,
        dedupeCollisionsResolved
      },
      errors,
      warnings,
      invalidRows,
      events: validEvents,
      datasets
    };
  }

  function fromCsvText(csvText, options){
    const parsed = parseCsvText(csvText);
    return fromRows(parsed, options);
  }

  return { VERSION, fromCsvText, fromRows, resolveColumns, buildDatasets };
});
