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

  const COLUMN_FIELD_ALIASES = {
    sku: ['sku_col', 'item_code', 'itemCode', 'product_code', 'productCode', 'sku'],
    description: ['product_description', 'item_description', 'itemDescription', 'description'],
    quantity: ['quantity_col', 'qty_col', 'qty', 'quantity'],
    unit_price: ['unit_price_col', 'unit_cost_col', 'unit_cost', 'unitPrice', 'unit_price', 'price'],
    amount: ['line_total_col', 'line_amount_col', 'line_total', 'line_amount', 'amount'],
    line_no: ['line_number_col', 'line_no_col', 'line_number', 'line_no']
  };

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

  function unwrapFieldValue(entry){
    if(entry === undefined || entry === null) return undefined;
    if(Array.isArray(entry)) return entry;
    if(typeof entry === 'object'){
      if(Object.prototype.hasOwnProperty.call(entry, 'value')) return entry.value;
      if(Object.prototype.hasOwnProperty.call(entry, 'raw')) return entry.raw;
    }
    return entry;
  }

  function extractFieldValue(record, key){
    const fields = record?.fields;
    if(fields && Object.prototype.hasOwnProperty.call(fields, key)){
      const value = unwrapFieldValue(fields[key]);
      if(Array.isArray(value)) return value.map(v => v === undefined || v === null ? '' : String(v)).join(' ');
      return value ?? '';
    }
    const direct = record?.[key];
    if(direct && typeof direct === 'object' && 'value' in direct) return direct.value;
    return direct ?? '';
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

  function normalizeColumnArray(value){
    const raw = unwrapFieldValue(value);
    if(raw === undefined || raw === null) return [];
    if(Array.isArray(raw)){
      const arr = raw.map(v => {
        if(v === undefined || v === null) return '';
        return String(v).replace(/\r/g, '').trim();
      });
      return arr.every(v => v === '') ? [] : arr;
    }
    if(typeof raw === 'string'){
      const normalized = raw.replace(/\r/g, '\n');
      const parts = normalized.split(/\n/).map(s => s.trim());
      return parts.every(p => p === '') ? [] : parts;
    }
    const str = String(raw).trim();
    return str ? [str] : [];
  }

  function extractColumnValues(record, aliases){
    if(!record || !record.fields) return [];
    for(const key of aliases){
      if(!Object.prototype.hasOwnProperty.call(record.fields, key)) continue;
      const arr = normalizeColumnArray(record.fields[key]);
      if(arr.length) return arr;
    }
    return [];
  }

  function prepareItems(record){
    if(!record) return [];

    const columnData = {
      sku: extractColumnValues(record, COLUMN_FIELD_ALIASES.sku),
      description: extractColumnValues(record, COLUMN_FIELD_ALIASES.description),
      quantity: extractColumnValues(record, COLUMN_FIELD_ALIASES.quantity),
      unit_price: extractColumnValues(record, COLUMN_FIELD_ALIASES.unit_price),
      amount: extractColumnValues(record, COLUMN_FIELD_ALIASES.amount),
      line_no: extractColumnValues(record, COLUMN_FIELD_ALIASES.line_no)
    };

    const lengths = Object.values(columnData).map(arr => arr.length).filter(len => len > 0);
    let maxLen = lengths.length ? Math.max(...lengths) : 0;

    if(maxLen === 0 && Array.isArray(record.lineItems)){
      maxLen = record.lineItems.length;
      return record.lineItems.map((item, idx) => {
        const original = item || {};
        return {
          original,
          sku: cleanSku(original.sku ?? original.SKU ?? ''),
          description: cleanDescription(original.description ?? original.desc ?? ''),
          quantity: cleanNumeric(original.quantity ?? original.qty ?? ''),
          unitPrice: cleanNumeric(original.unit_price ?? original.unitPrice ?? original.price ?? ''),
          amount: cleanNumeric(original.amount ?? original.line_total ?? ''),
          lineNo: cleanLineNo(original.line_no ?? original.lineNo ?? '')
        };
      });
    }

    return Array.from({ length: maxLen }, (_, idx) => {
      const original = {
        sku: columnData.sku[idx] ?? '',
        description: columnData.description[idx] ?? '',
        quantity: columnData.quantity[idx] ?? '',
        unit_price: columnData.unit_price[idx] ?? '',
        amount: columnData.amount[idx] ?? '',
        line_no: columnData.line_no[idx] ?? ''
      };
      return {
        original,
        sku: cleanSku(original.sku),
        description: cleanDescription(original.description),
        quantity: cleanNumeric(original.quantity),
        unitPrice: cleanNumeric(original.unit_price),
        amount: cleanNumeric(original.amount),
        lineNo: cleanLineNo(original.line_no)
      };
    });
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
      if(item.sku === '') missing.sku.push(idx + 1);
      if(item.quantity === '') missing.quantity.push(idx + 1);
      if(item.unitPrice === '') missing.unit_price.push(idx + 1);
      if(item.lineNo === '') missing.line_no.push(idx + 1);
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
        const lineNo = item.lineNo || String(idx + 1);
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
