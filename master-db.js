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
    'Line No',
    'File ID'
  ];

  const TEMPLATE_FIELD_ALIASES = {
    order_number: 'invoice_number',
    sales_date: 'invoice_date',
    salesperson: 'salesperson_rep',
    customer: 'customer_name',
    sold_to_block: 'customer_address',
    store: 'store_name',
    subtotal: 'subtotal_amount',
    hst: 'tax_amount',
    qst: 'tax_amount',
    total: 'invoice_total'
  };

  const TEMPLATE_FIELD_TO_HEADER_INDEX = {
    store_name: HEADERS.indexOf('Store / Business Name'),
    department_division: HEADERS.indexOf('Department / Division'),
    invoice_number: HEADERS.indexOf('Invoice #'),
    invoice_date: HEADERS.indexOf('Invoice Date'),
    salesperson_rep: HEADERS.indexOf('Salesperson'),
    customer_name: HEADERS.indexOf('Customer Name'),
    customer_address: HEADERS.indexOf('Customer Address'),
    sku_col: HEADERS.indexOf('Item Code (SKU)'),
    product_description: HEADERS.indexOf('Item Description'),
    quantity_col: HEADERS.indexOf('Quantity'),
    unit_price_col: HEADERS.indexOf('Unit Price'),
    line_total_col: HEADERS.indexOf('Line Total'),
    subtotal_amount: HEADERS.indexOf('Subtotal'),
    discounts_amount: HEADERS.indexOf('Discount'),
    tax_amount: HEADERS.indexOf('Tax Amount'),
    invoice_total: HEADERS.indexOf('Invoice Total'),
    payment_method: HEADERS.indexOf('Payment Method'),
    payment_status: HEADERS.indexOf('Payment Status'),
    line_number_col: HEADERS.indexOf('Line No'),
    file_id: HEADERS.indexOf('File ID')
  };

  function getHeaderTemplateForRecord(recordOrTemplate){
    if(Array.isArray(recordOrTemplate)) return recordOrTemplate;
    if(recordOrTemplate && typeof recordOrTemplate === 'object'){
      const candidate = recordOrTemplate.dbTemplate || recordOrTemplate.DBTEMPLATE;
      if(Array.isArray(candidate)) return candidate;
    }
    return HEADERS;
  }

  function buildDbTemplateFromCustomWizardConfig(config){
    if(!config) return null;
    const fields = Array.isArray(config.fields) ? config.fields : [];
    if(!fields.length) return null;

    const resolved = HEADERS.slice();

    fields.forEach(field => {
      const rawKey = (field?.fieldKey || '').trim();
      if(!rawKey) return;
      const canonicalKey = TEMPLATE_FIELD_ALIASES[rawKey] || rawKey;
      const idx = TEMPLATE_FIELD_TO_HEADER_INDEX[canonicalKey];
      if(idx === undefined || idx < 0) return;
      const label = (field?.name || field?.label || '').trim();
      if(label) resolved[idx] = label;
    });

    return resolved;
  }

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

  function markSyntheticZeroItems(items){
    const isNumericFilled = item => {
      return ['quantity', 'unitPrice', 'amount'].some(key => {
        const value = item[key];
        if(value === '') return false;
        const parsed = parseFloat(value);
        return !isNaN(parsed) && isFinite(parsed);
      });
    };

    const looksLikeHeader = description => {
      const trimmed = description.trim();
      if(!trimmed) return true;
      const normalized = trimmed.toLowerCase();
      const headerWords = new Set(['item', 'description', 'qty', 'quantity', 'unit', 'price', 'amount', 'total']);
      if(headerWords.has(normalized)) return true;
      if(normalized.length <= 2) return true;
      return false;
    };

    const hasNumericFlags = items.map(isNumericFilled);

    items.forEach((item, idx) => {
      if(item.synthetic_zero) return;
      const hasDescription = item.description !== '';
      if(!hasDescription || looksLikeHeader(item.description)) return;
      const hasNumeric = hasNumericFlags[idx];
      if(hasNumeric) return;

      const neighbors = [idx - 1, idx + 1]
        .filter(i => i >= 0 && i < items.length)
        .map(i => ({ idx: i, item: items[i], hasNumeric: hasNumericFlags[i] }));
      const candidateNeighbors = neighbors.filter(entry => entry.hasNumeric);
      if(!candidateNeighbors.length) return;

      const thisRow = typeof item.rowNumber === 'number' ? item.rowNumber : (idx + 1);
      const closeNeighbor = candidateNeighbors.some(({ item: neighbor, idx: neighborIdx }) => {
        const neighborRow = typeof neighbor.rowNumber === 'number' ? neighbor.rowNumber : (neighborIdx + 1);
        return Math.abs(thisRow - neighborRow) <= 1;
      });
      if(!closeNeighbor) return;

      if(item.quantity === '') item.quantity = '1.00';
      if(item.unitPrice === '') item.unitPrice = '0.00';
      if(item.amount === '') item.amount = '0.00';
      item.synthetic_zero = true;
    });

    return items;
  }

  function summarizeDynamicCounts(items){
    const counts = {};
    DYNAMIC_ITEM_KEYS.forEach(key => {
      counts[key] = items.reduce((acc, item) => acc + (item[key] !== '' ? 1 : 0), 0);
    });
    return counts;
  }

  function inferLineCalculations(items){
    items.forEach(item => {
      const quantityNum = item.quantity !== '' ? parseFloat(item.quantity) : null;
      const unitPriceNum = item.unitPrice !== '' ? parseFloat(item.unitPrice) : null;
      const amountNum = item.amount !== '' ? parseFloat(item.amount) : null;

      if(item.quantity === '' && unitPriceNum !== null && amountNum !== null){
        const inferredQty = amountNum / unitPriceNum;
        if(isFinite(inferredQty)){
          const rounded = Math.round(inferredQty);
          if(Math.abs(inferredQty - rounded) < 1e-2){
            item.quantity = rounded.toFixed(2);
          }
        }
      }

      if(item.quantity === '' && item.amount === '' && unitPriceNum !== null){
        item.quantity = '1.00';
        item.amount = item.unitPrice;
        item.__assumedQuantity = true;
      }

      if(item.amount === '' && item.quantity !== '' && unitPriceNum !== null){
        const q = parseFloat(item.quantity);
        if(!isNaN(q)){
          item.amount = (q * unitPriceNum).toFixed(2);
        }
      }
    });
  }

  function computeUsableRows(items){
    return items.reduce((acc, item) => {
      const hasDescription = item.description !== '';
      const hasNumericField = item.quantity !== '' || item.unitPrice !== '' || item.amount !== '';
      return acc + (hasDescription && hasNumericField ? 1 : 0);
    }, 0);
  }

  function synthesizeLineNumbers(items){
    const hasRealLineNo = items.some(item => {
      if(item.lineNo === '') return false;
      const parsed = parseFloat(item.lineNo);
      return !isNaN(parsed) && isFinite(parsed);
    });

    if(hasRealLineNo) return { synthetic: false, usableAssigned: 0 };

    let counter = 1;
    let assigned = 0;
    items.forEach(item => {
      const hasDescription = item.description !== '';
      const hasNumericField = item.quantity !== '' || item.unitPrice !== '' || item.amount !== '';
      if(hasDescription && hasNumericField){
        if(!item.lineNo){
          item.lineNo = String(counter++);
          item.__virtualLineNo = true;
          assigned += 1;
        }
      }
    });

    return { synthetic: assigned > 0, usableAssigned: assigned };
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
    const majoritySeed = computeMajorityRowCount(dynamicCounts, items.length);
    if(!majoritySeed || majoritySeed >= items.length){
      return { items, majorityCount: majoritySeed || items.length, dynamicCounts, majoritySeed: majoritySeed ?? null };
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
      if(chosenIndices.size >= majoritySeed) return;
      if(entry.filledCount === 0) return;
      chosenIndices.add(entry.idx);
    });

    if(chosenIndices.size < majoritySeed){
      byRowOrder.forEach(entry => {
        if(chosenIndices.size >= majoritySeed) return;
        chosenIndices.add(entry.idx);
      });
    }

    const selected = annotated
      .filter(entry => chosenIndices.has(entry.idx))
      .sort((a, b) => a.idx - b.idx)
      .map(entry => entry.item);

    return { items: selected, majorityCount: majoritySeed, dynamicCounts, majoritySeed };
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
    const headerTemplate = getHeaderTemplateForRecord(records[0] || ssot);
    const prepared = records.map(record => ({
      record,
      invoice: buildInvoiceCells(record),
      items: markSyntheticZeroItems(prepareItems(record))
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

    inferLineCalculations(allItems);
    let usableRowCount = computeUsableRows(allItems);
    let syntheticLineNo = synthesizeLineNumbers(allItems);

    const totalsInfo = selected.map(entry => {
      const recordTotals = entry.record?.totals || {};
      const subtotal = entry.invoice.subtotal || cleanNumeric(recordTotals.subtotal);
      const total = entry.invoice.total || cleanNumeric(recordTotals.total);
      return { entry, subtotal, total };
    });

    const hasStaticTotals = totalsInfo.some(info => info.subtotal || info.total);
    let singleItemFallback = false;

    if(usableRowCount === 0 && hasStaticTotals){
      const sourceTotals = totalsInfo.find(info => info.subtotal || info.total);
      const amountValue = sourceTotals?.subtotal || sourceTotals?.total;
      if(amountValue){
        const syntheticItem = {
          original: null,
          sku: '',
          description: 'Primary Item (single-item contract)',
          quantity: '1.00',
          unitPrice: amountValue,
          amount: amountValue,
          lineNo: '1',
          missing: {},
          rowNumber: 1,
          _synthetic: 'single_item_total'
        };
        sourceTotals.entry.items.push(syntheticItem);
        allItems.push(syntheticItem);
        singleItemFallback = true;
        console.log('[MasterDB] synthetic single-item row generated from static totals');

        inferLineCalculations(allItems);
        usableRowCount = computeUsableRows(allItems);
        syntheticLineNo = synthesizeLineNumbers(allItems);
      }
    }

    const majoritySeeds = selected.map(({ selection }) => selection?.majoritySeed ?? null);
    const dbSeedIsZero = selected.length > 0 && majoritySeeds.every(seed => seed === null);

    if(usableRowCount === 0 && !singleItemFallback && dbSeedIsZero){
      const target = selected[0];
      if(target){
        const syntheticItem = {
          original: null,
          sku: '',
          description: 'Static-only line item',
          quantity: '1.00',
          unitPrice: '0.00',
          amount: '0.00',
          lineNo: '1',
          missing: {},
          rowNumber: 1,
          _synthetic: 'static_only_fallback'
        };
        target.items.push(syntheticItem);
        allItems.push(syntheticItem);
        console.log('[MasterDB] synthetic static-only row generated (DBSEED=0)');

        inferLineCalculations(allItems);
        usableRowCount = computeUsableRows(allItems);
        syntheticLineNo = synthesizeLineNumbers(allItems);
      }
    }

    const syntheticZeroCount = allItems.filter(it => it.synthetic_zero).length;
    const zeroPriceCount = allItems.filter(it => it.unitPrice === '0.00' && it.amount === '0.00').length;

    const counts = {
      sku_count: allItems.filter(it => it.sku !== '').length,
      qty_count: allItems.filter(it => it.quantity !== '').length,
      price_count: allItems.filter(it => it.unitPrice !== '').length,
      line_no_count: allItems.filter(it => it.lineNo !== '').length,
      usable_row_count: usableRowCount,
      synthetic_line_no: syntheticLineNo.synthetic,
      synthetic_zero_count: syntheticZeroCount,
      zero_price_row_count: zeroPriceCount,
      static_totals_present: hasStaticTotals,
      single_item_fallback: singleItemFallback
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

    if(usableRowCount === 0){
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

    const rows = [headerTemplate];
    selected.forEach(({ invoice, items, record }) => {
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
          lineNo,
          record?.fileId || record?.fileHash || ''
        ]);
      });
    });

    return { rows, missingMap };
  }

  function normalizeRowInput(row){
    if(!row) return null;
    if(Array.isArray(row)) return row;
    if(Array.isArray(row.cells)) return row.cells;
    return null;
  }

  function flattenRows(rows, headerTemplate){
    const dataRows = Array.isArray(rows) ? rows.map(normalizeRowInput).filter(Boolean) : [];
    const resolvedHeaders = getHeaderTemplateForRecord(headerTemplate);
    return { rows: [resolvedHeaders, ...dataRows] };
  }

  function toCsv(ssot){
    const { rows } = flatten(ssot);
    return rows.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  function toCsvRows(rows, headerTemplate){
    const table = flattenRows(rows, headerTemplate).rows;
    return table.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  return { HEADERS, flatten, flattenRows, toCsv, toCsvRows, buildDbTemplateFromCustomWizardConfig };
});
