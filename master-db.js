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

  const DEFAULT_LINE_ITEM_COLUMNS = [
    { key: 'sku', label: 'Item Code (SKU)', cleaner: cleanSku },
    { key: 'description', label: 'Item Description', cleaner: cleanDescription },
    { key: 'quantity', label: 'Quantity', cleaner: cleanNumeric },
    { key: 'unit_price', label: 'Unit Price', cleaner: cleanNumeric, keys: ['unitPrice'] },
    { key: 'amount', label: 'Line Total', cleaner: cleanNumeric },
    { key: 'line_no', label: 'Line No', cleaner: cleanLineNo, keys: ['lineNo'] }
  ];

  const DYNAMIC_ITEM_KEYS = ['sku', 'description', 'quantity', 'unitPrice', 'amount'];
  const CORE_DYNAMIC_KEYS = ['sku', 'description', 'quantity'];

  function extractFieldValue(record, key){
    const field = record?.fields?.[key];
    if(field && typeof field === 'object' && 'value' in field) return field.value;
    return field ?? '';
  }

  function normalizeMasterConfig(record){
    const cfg = record?.masterDbConfig || {};
    const staticFieldsRaw = Array.isArray(cfg.staticFields) ? cfg.staticFields : [];
    const staticFields = staticFieldsRaw
      .map(f => ({
        ...f,
        fieldKey: f?.fieldKey || f?.key || f?.name,
        label: f?.label || f?.fieldKey || f?.key || f?.name,
        isArea: !!f?.isArea,
        isSubordinate: !!f?.isSubordinate
      }))
      .filter(f => !!f.fieldKey);
    const areaFieldKeysFromConfig = Array.isArray(cfg.areaFieldKeys) ? cfg.areaFieldKeys : [];
    const areaFieldKeysFromStatic = staticFields
      .filter(f => f.isArea || f.isSubordinate)
      .map(f => f.fieldKey);
    const areaFieldKeys = Array.from(new Set([...areaFieldKeysFromConfig, ...areaFieldKeysFromStatic])).filter(Boolean);
    const documentFieldKeysOverride = Array.isArray(cfg.documentFieldKeys) ? cfg.documentFieldKeys.filter(Boolean) : null;
    const documentFieldKeys = documentFieldKeysOverride || staticFields
      .filter(f => !areaFieldKeys.includes(f.fieldKey))
      .map(f => f.fieldKey);
    const includeLineItems = !!cfg.includeLineItems;
    const lineItemFields = Array.isArray(cfg.lineItemFields) ? cfg.lineItemFields : [];
    const isCustomMasterDb = !!cfg.isCustomMasterDb;
    const globalFields = Array.isArray(cfg.globalFields) ? cfg.globalFields : [];
    const hasNonAreaFields = documentFieldKeys.length > 0 || (!areaFieldKeys.length && documentFieldKeysOverride === null);
    return {
      isCustomMasterDb,
      includeLineItems,
      staticFields,
      lineItemFields,
      globalFields,
      areaFieldKeys,
      documentFieldKeys,
      hasNonAreaFields
    };
  }

  function resolveLineItemColumns(config){
    if(!config.includeLineItems) return [];
    const defaultCleanerByKey = Object.fromEntries(DEFAULT_LINE_ITEM_COLUMNS.map(col => [col.key, col.cleaner]));
    const configured = (config.lineItemFields || [])
      .map(f => ({ key: f.fieldKey || f.key, label: f.label || f.fieldKey || f.key }))
      .filter(f => f.key);
    const base = configured.length ? configured : DEFAULT_LINE_ITEM_COLUMNS;
    return base.map(col => ({
      key: col.key,
      label: col.label || col.key,
      cleaner: col.cleaner || defaultCleanerByKey[col.key] || cleanText,
      keys: Array.isArray(col.keys) ? col.keys : []
    }));
  }

  function normalizeLineItemValue(item, column){
    const candidates = [item?.[column.key], ...column.keys.map(k => item?.[k])];
    const value = candidates.find(v => v !== undefined && v !== null && String(v).trim() !== '') ?? '';
    if(column.cleaner === cleanNumeric) return cleanNumeric(value);
    if(column.cleaner === cleanLineNo) return cleanLineNo(value);
    if(column.cleaner === cleanDescription) return cleanDescription(value);
    if(column.cleaner === cleanSku) return cleanSku(value);
    if(typeof column.cleaner === 'function') return column.cleaner(value);
    return cleanText(value);
  }

  function emptyMissingMap(){
    return {
      summary: {
        sku: [],
        quantity: [],
        unit_price: [],
        line_no: []
      },
      columns: {
        sku: { rows: [], details: {} },
        quantity: { rows: [], details: {} },
        unit_price: { rows: [], details: {} },
        line_no: { rows: [], details: {} }
      },
      rows: {}
    };
  }

  function buildStaticValues(record, staticFields){
    const fields = Array.isArray(staticFields) ? staticFields : [];
    if(!fields.length) return [];
    return fields.map(f => cleanText(extractFieldValue(record, f.fieldKey)));
  }

  function buildNamedValues(record, fields){
    const fieldList = Array.isArray(fields) ? fields : [];
    if(!fieldList.length) return {};
    const labels = fieldList.map(f => f.label || f.fieldKey);
    const values = buildStaticValues(record, fieldList);
    const map = {};
    labels.forEach((label, idx) => {
      map[label] = values[idx];
    });
    return map;
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

  function flattenCustom(records, config){
    const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
    const staticFields = Array.isArray(config.staticFields) ? config.staticFields : [];
    const staticHeader = staticFields.map(f => f.label || f.fieldKey);
    const lineItemColumns = resolveLineItemColumns(config);
    const header = [...staticHeader, ...lineItemColumns.map(c => c.label), 'File ID'];
    const rows = [];

    safeRecords.forEach(record => {
      const baseValues = buildStaticValues(record, staticFields);
      const fileId = record?.fileId || record?.fileHash || '';
      if(config.includeLineItems && Array.isArray(record?.lineItems) && record.lineItems.length){
        record.lineItems.forEach((item, idx) => {
          const lined = col => (col.key === 'line_no' ? (item?.line_no || item?.lineNo || String(idx + 1)) : null);
          const enhancedLineValues = lineItemColumns.map(col => {
            const raw = lined(col);
            return raw !== null ? cleanLineNo(raw) : normalizeLineItemValue(item, col);
          });
          rows.push([...baseValues, ...enhancedLineValues, fileId]);
        });
      } else {
        rows.push([...baseValues, fileId]);
      }
    });

    return { header, rows, missingMap: {} };
  }

  const ROOT_SHEET_NAME = 'MasterDB';

  function flattenRoot(records, config){
    const configRef = config || normalizeMasterConfig(records[0]);
    if(configRef.isCustomMasterDb){
      return flattenCustom(records, configRef);
    }
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

    const rows = [HEADERS];
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

    return { header: HEADERS, rows, missingMap, hasNonAreaFields: configRef.hasNonAreaFields };
  }

  function normalizeAreaFieldValue(cell){
    if(cell && typeof cell === 'object' && 'value' in cell) return cleanText(cell.value);
    if(cell && typeof cell === 'object' && 'raw' in cell) return cleanText(cell.raw);
    return cleanText(cell);
  }

  function ensureFileIdLast(header){
    const fileHeader = HEADERS[HEADERS.length - 1] || 'File ID';
    const withoutFileId = header.filter(h => h !== fileHeader);
    return [...withoutFileId, fileHeader];
  }

  function upsertHeaderColumns(existing, incoming){
    const fileHeader = HEADERS[HEADERS.length - 1] || 'File ID';
    const next = existing.slice();
    incoming.forEach(col => {
      if(col === fileHeader) return;
      if(!next.includes(col)){
        const insertAt = Math.max(0, next.indexOf(fileHeader));
        if(insertAt >= 0 && insertAt < next.length){
          next.splice(insertAt, 0, col);
        } else {
          next.push(col);
        }
      }
    });
    return ensureFileIdLast(next);
  }

  function normalizeAreaSheetRow(header, fields, fileId){
    const normalizedFields = fields || {};
    const values = header
      .filter(col => col !== (HEADERS[HEADERS.length - 1] || 'File ID'))
      .map(col => normalizeAreaFieldValue(normalizedFields[col]));
    values.push(fileId);
    return values;
  }

  function buildAreaSheets(records, config){
    const sheets = new Map();
    const fileHeader = HEADERS[HEADERS.length - 1] || 'File ID';
    const { globalFields = [] } = config || normalizeMasterConfig(records[0] || {});
    const globalColumns = Array.isArray(globalFields) ? globalFields.map(f => f.label || f.fieldKey) : [];

    const addRowToSheet = (areaId, areaName, rowFields, fileId, globalFieldMap) => {
      const key = areaId || areaName || 'Area';
      const label = areaName || areaId || 'Area';
      const combinedFields = { ...(globalFieldMap || {}), ...(rowFields || {}) };
      const incomingCols = Object.keys(combinedFields);
      const existing = sheets.get(key) || {
        name: label,
        areaId: areaId || label,
        header: ensureFileIdLast(incomingCols.concat(fileHeader)),
        rows: []
      };
      existing.header = upsertHeaderColumns(existing.header, incomingCols);
      existing.rows.push(normalizeAreaSheetRow(existing.header, combinedFields, fileId));
      sheets.set(key, existing);
    };

    records.forEach(record => {
      const fileId = record?.fileId || record?.fileHash || '';
      const areaRows = Array.isArray(record?.areaRows) ? record.areaRows : [];
      const globalFieldMap = globalColumns.length ? buildNamedValues(record, globalFields) : {};
      areaRows.forEach(row => {
        const areaId = row?.areaId || row?.id || row?.name;
        const areaName = row?.areaName || row?.name || areaId;
        const nestedRows = Array.isArray(row?.rows) && row.rows.length ? row.rows : [row];
        nestedRows.forEach(nested => {
          const rowFields = nested?.fields || row?.fields || {};
          addRowToSheet(areaId, areaName, rowFields, fileId, globalFieldMap);
        });
      });
    });

    return Array.from(sheets.values()).map(sheet => ({
      name: sheet.name,
      areaId: sheet.areaId,
      header: sheet.header,
      rows: [sheet.header, ...sheet.rows]
    }));
  }

  function flatten(ssot){
    const records = Array.isArray(ssot) ? ssot.filter(Boolean) : ssot ? [ssot] : [];
    const normalizedConfig = normalizeMasterConfig(records[0]);
    const areaRowsPresent = records.some(r => Array.isArray(r?.areaRows) && r.areaRows.length);
    let root;
    try {
      root = flattenRoot(records, normalizedConfig);
    } catch(err){
      const emptyRootOk = areaRowsPresent && /Exporter input empty/.test(err?.message || '');
      if(!emptyRootOk) throw err;
      root = {
        header: HEADERS,
        rows: [HEADERS],
        missingMap: emptyMissingMap(),
        hasNonAreaFields: normalizedConfig.hasNonAreaFields
      };
    }
    const areaSheets = buildAreaSheets(records, normalizedConfig);
    const rootHasRows = root.rows && root.rows.length > 1;
    const hasNonAreaFields = root.hasNonAreaFields ?? normalizedConfig.hasNonAreaFields;
    const sheets = [];
    if((hasNonAreaFields && rootHasRows) || (!areaSheets.length && hasNonAreaFields)){
      sheets.push({ name: ROOT_SHEET_NAME, header: root.header, rows: root.rows });
    }
    sheets.push(...areaSheets);
    return { header: root.header, rows: root.rows, missingMap: root.missingMap, sheets };
  }

  function normalizeRowInput(row){
    if(!row) return null;
    if(Array.isArray(row)) return row;
    if(Array.isArray(row.cells)) return row.cells;
    return null;
  }

  function flattenRows(rows){
    const payload = Array.isArray(rows) || (rows && rows.header !== undefined)
      ? (Array.isArray(rows) ? { header: null, rows } : rows)
      : { header: null, rows: [] };
    const header = Array.isArray(payload.header) ? payload.header : HEADERS;
    const dataRows = Array.isArray(payload.rows) ? payload.rows.map(normalizeRowInput).filter(Boolean) : [];
    return { header, rows: [header, ...dataRows] };
  }

  function toCsv(ssot){
    const { header, rows } = flatten(ssot);
    const table = (rows && rows.length) ? rows : [header || HEADERS];
    return table.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  function toCsvRows(rows){
    const table = flattenRows(rows).rows;
    return table.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  return { HEADERS, flatten, flattenRows, toCsv, toCsvRows };
});
