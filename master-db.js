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

  function csvEscape(val){
    if(val === undefined || val === null) return '';
    const s = String(val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }

  function flatten(ssot){
    const records = Array.isArray(ssot) ? ssot.filter(Boolean) : ssot ? [ssot] : [];
    const prepared = records.map(record => ({
      record,
      invoice: buildInvoiceCells(record),
      items: prepareItems(record)
    }));

    const allItems = prepared.flatMap(r => r.items);

    const counts = {
      sku_count: allItems.filter(it => it.sku !== '').length,
      qty_count: allItems.filter(it => it.quantity !== '').length,
      price_count: allItems.filter(it => it.unitPrice !== '').length,
      line_no_count: allItems.filter(it => it.lineNo !== '').length
    };

    const firstItem = allItems[0]?.original || null;
    const lastItem = allItems.length ? allItems[allItems.length-1].original : null;
    console.log('[MasterDB] integrity', { ...counts, first_item: firstItem, last_item: lastItem });

    if(counts.sku_count === 0){
      throw new Error('Exporter input empty—SSOT not wired.');
    }

    const missing = { sku: [], quantity: [], unit_price: [], line_no: [] };
    allItems.forEach((item, idx) => {
      const rowIdx = item.rowNumber || (idx + 1);
      const miss = item.missing || {};
      if(item.sku === '' || miss.sku) missing.sku.push(rowIdx);
      if(item.quantity === '' || miss.quantity) missing.quantity.push(rowIdx);
      if(item.unitPrice === '' || miss.unit_price) missing.unit_price.push(rowIdx);
      if(item.lineNo === '' || miss.line_no) missing.line_no.push(rowIdx);
    });
    if(missing.sku.length || missing.quantity.length || missing.unit_price.length || missing.line_no.length){
      console.warn('[MasterDB] count mismatch', { counts, missing });
    }

    const rows = [HEADERS];
    prepared.forEach(({ invoice, items }) => {
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

    return rows;
  }

  function toCsv(ssot){
    return flatten(ssot).map(r => r.map(csvEscape).join(',')).join('\n');
  }

  return { HEADERS, flatten, toCsv };
});
