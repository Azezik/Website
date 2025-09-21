(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MasterDB = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  const HEADERS = [
    'Store / Business Name',
    'Department / Division',
    'Invoice #',
    'Invoice Date',
    'Salesperson',
    'Customer Name',
    'Customer Address',
    'Item Code (SKU)',
    'Item Description',
    'Quantity',
    'Unit Price',
    'Line Total',
    'Subtotal',
    'Discount',
    'Tax Amount',
    'Invoice Total',
    'Payment Method',
    'Payment Status',
    'Line No'
  ];

  function cleanText(value){
    if(value === undefined || value === null) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function cleanNumeric(value){
    if(value === undefined || value === null) return '';
    const compact = String(value).replace(/\s+/g, '').replace(/,/g, '');
    if(!compact) return '';
    const normalized = compact.replace(/[^0-9.-]/g, '');
    if(!normalized || /^-?\.?$/.test(normalized)) return '';
    const num = Number(normalized);
    if(!isFinite(num)) return '';
    return num.toFixed(2);
  }

  const cleanSku = cleanText;
  const cleanDescription = cleanText;
  const cleanLineNo = cleanText;

  const DYNAMIC_ITEM_KEYS = ['sku', 'description', 'quantity', 'unitPrice', 'amount'];
  const CORE_DYNAMIC_KEYS = ['sku', 'description', 'quantity'];

  function extractFieldValue(record, key){
    const field = record?.fields?.[key];
    if(field && typeof field === 'object' && 'value' in field) return field.value;
    return field ?? '';
  }

  function buildInvoiceCells(record){
    return {
      store: cleanText(extractFieldValue(record, 'store_name')),
      dept: cleanText(extractFieldValue(record, 'department_division')),
      number: cleanText(extractFieldValue(record, 'invoice_number')),
      date: cleanText(extractFieldValue(record, 'invoice_date')),
      salesperson: cleanText(extractFieldValue(record, 'salesperson_rep')),
      customer: cleanText(extractFieldValue(record, 'customer_name')),
      address: cleanText(extractFieldValue(record, 'customer_address')),
      subtotal: cleanNumeric(extractFieldValue(record, 'subtotal_amount')),
      discount: cleanNumeric(extractFieldValue(record, 'discounts_amount')),
      tax: cleanNumeric(extractFieldValue(record, 'tax_amount')),
      total: cleanNumeric(extractFieldValue(record, 'invoice_total')),
      paymentMethod: cleanText(extractFieldValue(record, 'payment_method')),
      paymentStatus: cleanText(extractFieldValue(record, 'payment_status'))
    };
  }

  function prepareItems(record){
    if(!record || !Array.isArray(record.lineItems)) return [];
    return record.lineItems.map(item => ({
      original: item,
      sku: cleanSku(item?.sku),
      description: cleanDescription(item?.description),
      quantity: cleanNumeric(item?.quantity),
      unitPrice: cleanNumeric(item?.unit_price),
      amount: cleanNumeric(item?.amount),
      lineNo: cleanLineNo(item?.line_no),
      missing: item?.__missing || {},
      rowNumber: typeof item?.__rowNumber === 'number' ? item.__rowNumber : null
    }));
  }

  function summarizeDynamicCounts(items){
    const counts = {};
    DYNAMIC_ITEM_KEYS.forEach(key => {
      counts[key] = items.reduce((acc, item) => acc + (item[key] !== '' ? 1 : 0), 0);
    });
    return counts;
  }

  function collectPositiveCounts(counts, keys){
    return keys
      .map(key => counts[key])
      .filter(count => typeof count === 'number' && count > 0);
  }

  function pickMajorityCount(values){
    if(!Array.isArray(values) || !values.length) return null;
    const frequency = new Map();
    values.forEach(count => {
      frequency.set(count, (frequency.get(count) || 0) + 1);
    });
    let bestCount = null;
    let bestFrequency = 0;
    frequency.forEach((freq, count) => {
      if(freq > bestFrequency){
        bestFrequency = freq;
        bestCount = count;
        return;
      }
      if(freq === bestFrequency){
        if(bestCount === null || count < bestCount){
          bestCount = count;
        }
      }
    });
    return bestCount;
  }

  function computeMajorityRowCount(counts, totalItems){
    const coreCounts = collectPositiveCounts(counts, CORE_DYNAMIC_KEYS);
    const allCounts = collectPositiveCounts(counts, DYNAMIC_ITEM_KEYS);
    if(!allCounts.length) return null;

    const coreMajority = pickMajorityCount(coreCounts);
    const overallMajority = pickMajorityCount(allCounts);
    const chosen = coreMajority !== null ? coreMajority : overallMajority;
    if(chosen === null) return null;
    return Math.min(chosen, totalItems);
  }

  function selectMajorityRows(items){
    const dynamicCounts = summarizeDynamicCounts(items);
    const majorityCount = computeMajorityRowCount(dynamicCounts, items.length);
    if(!majorityCount || majorityCount >= items.length){
      return { items, majorityCount: majorityCount || items.length, dynamicCounts };
    }

    const annotated = items.map((item, idx) => {
      const rowIdx = typeof item.rowNumber === 'number' ? item.rowNumber : (idx + 1);
      const filledCount = DYNAMIC_ITEM_KEYS.reduce((acc, key) => acc + (item[key] !== '' ? 1 : 0), 0);
      return { item, idx, rowIdx, filledCount };
    });

    const byDensity = annotated.slice().sort((a, b) => {
      if(a.filledCount !== b.filledCount) return b.filledCount - a.filledCount;
      if(a.rowIdx !== b.rowIdx) return a.rowIdx - b.rowIdx;
      return a.idx - b.idx;
    });

    const byRowOrder = annotated.slice().sort((a, b) => {
      if(a.rowIdx !== b.rowIdx) return a.rowIdx - b.rowIdx;
      return a.idx - b.idx;
    });

    const chosenIndices = new Set();

    byDensity.forEach(entry => {
      if(chosenIndices.size >= majorityCount) return;
      if(entry.filledCount === 0) return;
      chosenIndices.add(entry.idx);
    });

    if(chosenIndices.size < majorityCount){
      byRowOrder.forEach(entry => {
        if(chosenIndices.size >= majorityCount) return;
        chosenIndices.add(entry.idx);
      });
    }

    const selected = annotated
      .filter(entry => chosenIndices.has(entry.idx))
      .sort((a, b) => a.idx - b.idx)
      .map(entry => entry.item);

    return { items: selected, majorityCount, dynamicCounts };
  }

  function csvEscape(val){
    if(val === undefined || val === null) return '';
    const s = String(val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }

  function normalizeMissingFlags(flag){
    if(flag === undefined || flag === null || flag === false) return [];
    const values = Array.isArray(flag) ? flag : [flag];
    const unique = new Set();
    values.forEach(val => {
      if(val === undefined || val === null || val === false) return;
      if(val === true){
        unique.add('flagged');
        return;
      }
      if(typeof val === 'string'){
        const trimmed = val.trim();
        unique.add(trimmed || 'flagged');
        return;
      }
      try {
        unique.add(String(val));
      } catch(err){
        unique.add('flagged');
      }
    });
    return Array.from(unique);
  }

  function flatten(ssot){
    const records = Array.isArray(ssot) ? ssot.filter(Boolean) : ssot ? [ssot] : [];
    const prepared = records.map(record => ({
      record,
      invoice: buildInvoiceCells(record),
      items: prepareItems(record)
    }));

    const selected = prepared.map(entry => {
      const selection = selectMajorityRows(entry.items);
      return {
        record: entry.record,
        invoice: entry.invoice,
        items: selection.items,
        selection
      };
    });

    const allItems = selected.flatMap(r => r.items);

    const counts = {
      sku_count: allItems.filter(it => it.sku !== '').length,
      qty_count: allItems.filter(it => it.quantity !== '').length,
      price_count: allItems.filter(it => it.unitPrice !== '').length,
      line_no_count: allItems.filter(it => it.lineNo !== '').length
    };

    const firstItem = allItems[0]?.original || null;
    const lastItem = allItems.length ? allItems[allItems.length-1].original : null;
    const rowMajority = selected.map(({ selection }, idx) => ({
      index: idx,
      original_rows: prepared[idx].items.length,
      selected_rows: selection.items.length,
      majority: selection.majorityCount,
      dynamic_counts: selection.dynamicCounts
    }));
    console.log('[MasterDB] integrity', { ...counts, first_item: firstItem, last_item: lastItem, row_majority: rowMajority });

    if(counts.sku_count === 0){
      throw new Error('Exporter input empty—SSOT not wired.');
    }

    const missingSummarySets = {
      sku: new Set(),
      quantity: new Set(),
      unit_price: new Set(),
      line_no: new Set()
    };
    const missingDetailsByRow = {};
    const noteMissing = (columnKey, rowIdx, reasons, flagged) => {
      if(!reasons || !reasons.length) return;
      missingSummarySets[columnKey].add(rowIdx);
      const rowDetails = missingDetailsByRow[rowIdx] || (missingDetailsByRow[rowIdx] = {});
      const uniqueReasons = Array.from(new Set(reasons)).sort();
      const detail = flagged ? { reasons: uniqueReasons, flagged: true } : { reasons: uniqueReasons };
      rowDetails[columnKey] = detail;
    };

    allItems.forEach((item, idx) => {
      const rowIdx = item.rowNumber || (idx + 1);
      const miss = item.missing || {};

      const inspect = (columnKey, value, missKey) => {
        const missFlag = miss[missKey];
        const reasons = normalizeMissingFlags(missFlag);
        const isBlank = value === '';
        if(isBlank && !reasons.includes('empty')) reasons.push('empty');
        if(!reasons.length) return;
        const flagged = missFlag !== undefined && missFlag !== null && missFlag !== false;
        noteMissing(columnKey, rowIdx, reasons, flagged);
      };

      inspect('sku', item.sku, 'sku');
      inspect('quantity', item.quantity, 'quantity');
      inspect('unit_price', item.unitPrice, 'unit_price');
      inspect('line_no', item.lineNo, 'line_no');
    });

    const missingSummary = Object.fromEntries(Object.entries(missingSummarySets).map(([key, set]) => [key, Array.from(set).sort((a,b) => a - b)]));
    const missingColumns = {};
    Object.entries(missingSummarySets).forEach(([columnKey, set]) => {
      const rowsWithMissing = Array.from(set).sort((a,b) => a - b);
      const details = {};
      rowsWithMissing.forEach(rowIdx => {
        const rowDetails = missingDetailsByRow[rowIdx];
        if(rowDetails && rowDetails[columnKey]){
          details[rowIdx] = rowDetails[columnKey];
        }
      });
      missingColumns[columnKey] = { rows: rowsWithMissing, details };
    });

    const missingRows = Object.fromEntries(
      Object.entries(missingDetailsByRow)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
    );

    const missingMap = { columns: missingColumns, rows: missingRows, summary: missingSummary };

    if(
      missingSummary.sku.length ||
      missingSummary.quantity.length ||
      missingSummary.unit_price.length ||
      missingSummary.line_no.length
    ){
      console.warn('[MasterDB] count mismatch', { counts, missing: missingSummary, missingMap });
    }

    const rows = [HEADERS];
    selected.forEach(({ invoice, items }) => {
      items.forEach((item, idx) => {
        let lineTotal = item.amount;
        if(lineTotal === '' && item.quantity && item.unitPrice){
          const q = parseFloat(item.quantity);
          const u = parseFloat(item.unitPrice);
          if(!isNaN(q) && !isNaN(u)) lineTotal = (q * u).toFixed(2);
        }
        const fallbackRow = item.rowNumber || (idx + 1);
        const lineNo = item.lineNo || String(fallbackRow);
        rows.push([
          invoice.store,
          invoice.dept,
          invoice.number,
          invoice.date,
          invoice.salesperson,
          invoice.customer,
          invoice.address,
          item.sku,
          item.description,
          item.quantity,
          item.unitPrice,
          lineTotal,
          invoice.subtotal,
          invoice.discount,
          invoice.tax,
          invoice.total,
          invoice.paymentMethod,
          invoice.paymentStatus,
          lineNo
        ]);
      });
    });

    return { rows, missingMap };
  }

  function toCsv(ssot){
    const { rows } = flatten(ssot);
    return rows.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  return { HEADERS, flatten, toCsv };
});
