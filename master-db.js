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

  const ITEM_FIELD_ALIASES = {
    sku: ['sku', 'SKU', 'item_code', 'itemCode', 'code', 'Code', 'product_code', 'productCode', 'item_sku', 'itemSku'],
    description: ['description', 'Description', 'item_description', 'itemDescription', 'product_description', 'productDescription', 'desc', 'Desc', 'name', 'Name', 'item_name', 'itemName'],
    quantity: ['quantity', 'Quantity', 'qty', 'Qty', 'qty_sold', 'qtySold', 'units', 'Units', 'unit_qty', 'unitQty', 'count', 'Count'],
    unit_price: ['unit_price', 'unitPrice', 'price', 'Price', 'unit_cost', 'unitCost', 'cost', 'Cost', 'unit', 'Unit'],
    amount: ['amount', 'Amount', 'line_total', 'lineTotal', 'total', 'Total', 'extended_price', 'extendedPrice', 'extension', 'Extension', 'line_amount', 'lineAmount'],
    discount: ['discount', 'Discount', 'line_discount', 'lineDiscount', 'disc', 'Disc', 'item_discount', 'itemDiscount'],
    line_no: ['line_no', 'lineNo', 'line_number', 'lineNumber', 'lineno', 'LineNo', 'line', 'Line', 'seq', 'Seq', 'position', 'Position']
  };

  const COLUMN_ALIASES = {
    sku: ['item_code', 'itemCode', 'sku', 'SKU', 'sku_col', 'skuCol', 'code', 'Code', 'product_code', 'productCode'],
    description: ['item_description', 'itemDescription', 'product_description', 'productDescription', 'description', 'Description', 'desc', 'Desc', 'item_desc', 'itemDesc'],
    quantity: ['qty', 'Qty', 'quantity', 'Quantity', 'qty_col', 'qtyCol', 'quantity_col', 'quantityCol', 'units', 'Units'],
    unit_price: ['unit_price', 'unitPrice', 'price', 'Price', 'unit_price_col', 'unitPriceCol', 'unit_cost', 'unitCost', 'cost', 'Cost'],
    amount: ['line_total', 'lineTotal', 'amount', 'Amount', 'line_amount', 'lineAmount', 'extended_price', 'extendedPrice', 'extension', 'Extension'],
    discount: ['discount', 'Discount', 'line_discount', 'lineDiscount', 'item_discount', 'itemDiscount'],
    line_no: ['line_number', 'lineNumber', 'line_no', 'lineNo', 'lineno', 'LineNo', 'seq', 'Seq']
  };

  function cleanNumber(val, opts={}){
    if(val === undefined || val === null || val === '') return '';
    const num = parseFloat(String(val).replace(/,/g,''));
    if(!isFinite(num)) return '';
    if(opts.fixed === undefined) return String(num);
    return num.toFixed(opts.fixed);
  }

  function cleanCell(val){
    if(val === undefined || val === null) return '';
    return String(val).replace(/\s+/g,' ').trim();
  }

  function csvEscape(val){
    if(val === undefined || val === null) return '';
    const s = String(val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }

  function normalizeArray(val){
    if(Array.isArray(val)){
      if(val.length === 1 && typeof val[0] === 'string' && /\n/.test(val[0])){
        return val[0].split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      }
      return val;
    }
    if(typeof val === 'string'){
      return val.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    }
    if(typeof val === 'number'){
      return [val];
    }
    return [];
  }

  function pickField(obj, aliases){
    if(!obj || typeof obj !== 'object') return undefined;
    for(const key of aliases){
      if(!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      let val = obj[key];
      if(val && typeof val === 'object' && !Array.isArray(val) && 'value' in val){
        val = val.value;
      }
      if(val === undefined || val === null) continue;
      if(typeof val === 'number'){
        if(!isFinite(val)) continue;
        return val;
      }
      if(typeof val === 'string'){
        const trimmed = val.trim();
        if(trimmed === '') continue;
        return trimmed;
      }
      const str = String(val).trim();
      if(str !== '') return val;
    }
    return undefined;
  }

  function hasItemData(row){
    return ['sku','description','quantity','unit_price','amount'].some(key => {
      const val = row[key];
      if(val === undefined || val === null) return false;
      if(typeof val === 'number') return isFinite(val);
      return String(val).trim() !== '';
    });
  }

  function normalizeItemObject(raw, idx){
    if(raw === undefined || raw === null) return null;
    let obj = raw;
    if(typeof obj !== 'object' || Array.isArray(obj)){
      obj = { description: obj };
    }
    const row = {
      sku: pickField(obj, ITEM_FIELD_ALIASES.sku),
      description: pickField(obj, ITEM_FIELD_ALIASES.description),
      quantity: pickField(obj, ITEM_FIELD_ALIASES.quantity),
      unit_price: pickField(obj, ITEM_FIELD_ALIASES.unit_price),
      amount: pickField(obj, ITEM_FIELD_ALIASES.amount)
    };
    const disc = pickField(obj, ITEM_FIELD_ALIASES.discount);
    if(disc !== undefined) row.discount = disc;
    const providedLine = pickField(obj, ITEM_FIELD_ALIASES.line_no);
    row.line_no = providedLine !== undefined ? providedLine : (idx + 1);
    if(!hasItemData(row)) return null;
    return row;
  }

  function itemsFromArray(src){
    if(!Array.isArray(src)) return [];
    return src.map((it, idx) => normalizeItemObject(it, idx)).filter(Boolean);
  }

  function columnValues(source, aliases){
    if(!source || typeof source !== 'object') return [];
    for(const key of aliases){
      if(!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const arr = normalizeArray(source[key]);
      if(arr.length) return arr;
    }
    return [];
  }

  function itemsFromColumns(source){
    if(!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const cols = {
      sku: columnValues(source, COLUMN_ALIASES.sku),
      description: columnValues(source, COLUMN_ALIASES.description),
      quantity: columnValues(source, COLUMN_ALIASES.quantity),
      unit_price: columnValues(source, COLUMN_ALIASES.unit_price),
      amount: columnValues(source, COLUMN_ALIASES.amount),
      discount: columnValues(source, COLUMN_ALIASES.discount),
      line_no: columnValues(source, COLUMN_ALIASES.line_no)
    };
    const lengths = Object.values(cols).map(list => list.length).filter(len => len > 0);
    const N = lengths.length ? Math.max(...lengths) : 0;
    if(!N) return [];
    const rows = [];
    for(let i=0;i<N;i++){
      const candidate = {};
      if(i < cols.sku.length) candidate.sku = cols.sku[i];
      if(i < cols.description.length) candidate.description = cols.description[i];
      if(i < cols.quantity.length) candidate.quantity = cols.quantity[i];
      if(i < cols.unit_price.length) candidate.unit_price = cols.unit_price[i];
      if(i < cols.amount.length) candidate.amount = cols.amount[i];
      if(i < cols.discount.length) candidate.discount = cols.discount[i];
      if(i < cols.line_no.length) candidate.line_no = cols.line_no[i];
      const norm = normalizeItemObject(candidate, rows.length);
      if(norm) rows.push(norm);
    }
    return rows;
  }

  function flatten(db){
    const rows = [HEADERS];
    (db||[]).forEach(inv => {
      const f = inv.fields || {};
      const invoice = inv.invoice || {};
      const totals = inv.totals || {};
      const base = {
        store: cleanCell(invoice.store || f.store_name?.value || ''),
        dept: cleanCell(f.department_division?.value || ''),
        number: cleanCell(invoice.number || ''),
        date: cleanCell(invoice.salesDateISO || ''),
        salesperson: cleanCell(invoice.salesperson || f.salesperson_rep?.value || ''),
        customer: cleanCell(f.customer_name?.value || ''),
        address: cleanCell(f.customer_address?.value || ''),
        subtotal: cleanNumber(totals.subtotal, {fixed:2}),
        discount: cleanNumber(totals.discount, {fixed:2}),
        tax: cleanNumber(totals.tax, {fixed:2}),
        total: cleanNumber(totals.total, {fixed:2}),
        payMethod: cleanCell(f.payment_method?.value || ''),
        payStatus: cleanCell(f.payment_status?.value || '')
      };
      let items = [];
      const arraySources = [inv.lineItems, inv.line_items, inv.items, inv.products];
      for(const src of arraySources){
        items = itemsFromArray(src);
        if(items.length) break;
      }
      if(!items.length){
        const columnSources = [inv, inv.lineItems, inv.line_items];
        for(const src of columnSources){
          items = itemsFromColumns(src);
          if(items.length) break;
        }
      }
      if(!items.length){
        const codes = normalizeArray(inv.item_code || inv.sku);
        const descs = normalizeArray(inv.item_description || inv.product_description);
        const qtys = normalizeArray(inv.qty || inv.quantity);
        const units = normalizeArray(inv.unit_price);
        const totals = normalizeArray(inv.line_total);
        const lineNos = normalizeArray(inv.line_number || inv.line_no);
        const discounts = normalizeArray(inv.line_discount || inv.discount);
        const lengths = [codes.length, descs.length, qtys.length, units.length, totals.length, lineNos.length, discounts.length].filter(len => len > 0);
        const N = lengths.length ? Math.max(...lengths) : 0;
        if(N){
          items = Array.from({length:N}).map((_,i)=>{
            const candidate = {
              sku: codes[i],
              description: descs[i],
              quantity: qtys[i],
              unit_price: units[i],
              amount: totals[i],
              line_no: lineNos[i],
              discount: discounts[i]
            };
            return normalizeItemObject(candidate, i);
          }).filter(Boolean);
        }
      }
      items = items.map((it, idx) => ({ ...it, line_no: it.line_no !== undefined ? it.line_no : (idx + 1) }));
      items.forEach((it, idx) => {
        const qty = cleanNumber(it.quantity, {});
        const unit = cleanNumber(it.unit_price, {fixed:2});
        let lineTotal = cleanNumber(it.amount, {fixed:2});
        if(!lineTotal && qty && unit){
          const q = parseFloat(qty);
          const u = parseFloat(unit);
          if(!isNaN(q) && !isNaN(u)) lineTotal = (q*u).toFixed(2);
        }
        const discount = it.discount !== undefined ? cleanNumber(it.discount,{fixed:2}) : base.discount;
        rows.push([
          base.store,
          base.dept,
          base.number,
          base.date,
          base.salesperson,
          base.customer,
          base.address,
          cleanCell(it.sku || ''),
          cleanCell(it.description || ''),
          qty,
          unit,
          lineTotal || '',
          base.subtotal,
          discount || '',
          base.tax,
          base.total,
          base.payMethod,
          base.payStatus,
          String(it.line_no !== undefined ? it.line_no : (idx+1))
        ]);
      });
    });
    return rows;
  }

  function toCsv(db){
    return flatten(db).map(r => r.map(csvEscape).join(',')).join('\n');
  }

  return { HEADERS, flatten, toCsv };
});
