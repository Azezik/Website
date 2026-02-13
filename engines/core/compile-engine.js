(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineCompile = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function defaultCleanScalar(val){
    if(val === undefined || val === null) return '';
    if(typeof val === 'string') return val.replace(/\s+/g, ' ').trim();
    return String(val);
  }

  function toFieldMap(rawEntries, areaFieldKeys, extractableFields){
    const byKey = {};
    (Array.isArray(rawEntries) ? rawEntries : []).forEach((r) => {
      if(!r || areaFieldKeys.has(r.fieldKey)) return;
      byKey[r.fieldKey] = {
        value: r.value,
        raw: r.raw,
        correctionsApplied: r.correctionsApplied || [],
        confidence: r.confidence || 0,
        tokens: r.tokens || [],
        engineUsed: r.engineUsed || null,
        tokenSource: r.tokenSource || null,
        extractionMeta: r.extractionMeta ? JSON.parse(JSON.stringify(r.extractionMeta)) : null
      };
    });
    (Array.isArray(extractableFields) ? extractableFields : []).forEach((f) => {
      if(!f || !f.fieldKey || byKey[f.fieldKey]) return;
      byKey[f.fieldKey] = { value: '', raw: '', confidence: 0, tokens: [] };
    });
    return byKey;
  }

  function applyTotalsConsistency(byKey, clampFn){
    const sub = parseFloat(byKey['subtotal_amount']?.value);
    const tax = parseFloat(byKey['tax_amount']?.value);
    const tot = parseFloat(byKey['invoice_total']?.value);
    if(!(Number.isFinite(sub) && Number.isFinite(tax) && Number.isFinite(tot))) return;
    const diff = Math.abs(sub + tax - tot);
    const adj = diff < 1 ? 0.05 : -0.2;
    ['subtotal_amount', 'tax_amount', 'invoice_total'].forEach((k) => {
      if(byKey[k]) byKey[k].confidence = clampFn((byKey[k].confidence || 0) + adj, 0, 1);
    });
  }

  function enrichLineItems(lineItems){
    const items = Array.isArray(lineItems) ? lineItems : [];
    return items.map((it, i) => {
      let amount = it?.amount;
      if(!amount && it?.quantity && it?.unit_price){
        const q = parseFloat(it.quantity);
        const u = parseFloat(it.unit_price);
        if(!Number.isNaN(q) && !Number.isNaN(u)) amount = (q * u).toFixed(2);
      }
      return { line_no: i + 1, ...it, amount };
    });
  }

  function compileRecord(input){
    const {
      fileId,
      fileName,
      rawEntries,
      areaFieldKeys,
      extractableFields,
      lineItems,
      processedAtISO,
      masterDbConfig,
      areaOccurrences,
      areaRows,
      templateKey,
      snapshotManifestId,
      clamp = (v) => v,
      cleanScalar = defaultCleanScalar,
      isChartable = null
    } = input || {};

    const byKey = toFieldMap(rawEntries, areaFieldKeys || new Set(), extractableFields);
    applyTotalsConsistency(byKey, clamp);
    const invoiceNumber = cleanScalar(byKey['invoice_number']?.value);
    const enrichedLineItems = enrichLineItems(lineItems);
    let lineSum = 0;
    let allHave = true;
    enrichedLineItems.forEach((it) => {
      if(it.amount){
        lineSum += parseFloat(it.amount);
      } else {
        allHave = false;
      }
    });

    const compiled = {
      fileId,
      fileHash: fileId,
      fileName: fileName || 'unnamed',
      processedAtISO: processedAtISO || new Date().toISOString(),
      fields: byKey,
      invoice: {
        number: invoiceNumber,
        salesDateISO: cleanScalar(byKey['invoice_date']?.value),
        salesperson: cleanScalar(byKey['salesperson_rep']?.value),
        store: cleanScalar(byKey['store_name']?.value)
      },
      totals: {
        subtotal: byKey['subtotal_amount']?.value || '',
        tax: byKey['tax_amount']?.value || '',
        total: byKey['invoice_total']?.value || '',
        discount: byKey['discounts_amount']?.value || ''
      },
      masterDbConfig,
      lineItems: enrichedLineItems,
      areaOccurrences: Array.isArray(areaOccurrences) ? areaOccurrences : [],
      areaRows: Array.isArray(areaRows) ? areaRows : [],
      templateKey,
      warnings: []
    };

    const sub = parseFloat(byKey['subtotal_amount']?.value);
    if(allHave && Number.isFinite(sub) && Math.abs(lineSum - sub) > 0.02){
      compiled.warnings.push('line_totals_vs_subtotal');
      if(byKey['subtotal_amount']){
        byKey['subtotal_amount'].confidence = clamp((byKey['subtotal_amount'].confidence || 0) * 0.8, 0, 1);
      }
    }
    if(snapshotManifestId){
      compiled.snapshotManifestId = snapshotManifestId;
    }
    if(typeof isChartable === 'function'){
      const chartable = isChartable(compiled);
      compiled.isChartable = !!chartable?.ok;
      if(!chartable?.ok){
        compiled.chartableReason = chartable?.reason || 'not_chartable';
      }
    }

    return compiled;
  }

  return {
    compileRecord,
    toFieldMap,
    enrichLineItems
  };
});
