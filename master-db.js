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

  function cleanNumber(val, opts={}){
    if(val === undefined || val === null || val === '') return '';
    const num = parseFloat(String(val).replace(/,/g,''));
    if(!isFinite(num)) return '';
    if(opts.fixed === undefined) return String(num);
    return num.toFixed(opts.fixed);
  }

  function csvEscape(val){
    if(val === undefined || val === null) return '';
    const s = String(val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }

  function flatten(db){
    const rows = [HEADERS];
    (db||[]).forEach(inv => {
      const f = inv.fields || {};
      const invoice = inv.invoice || {};
      const totals = inv.totals || {};
      const base = {
        store: invoice.store || f.store_name?.value || '',
        dept: f.department_division?.value || '',
        number: invoice.number || '',
        date: invoice.salesDateISO || '',
        salesperson: invoice.salesperson || f.salesperson_rep?.value || '',
        customer: f.customer_name?.value || '',
        address: f.customer_address?.value || '',
        subtotal: cleanNumber(totals.subtotal, {fixed:2}),
        discount: cleanNumber(totals.discount, {fixed:2}),
        tax: cleanNumber(totals.tax, {fixed:2}),
        total: cleanNumber(totals.total, {fixed:2}),
        payMethod: f.payment_method?.value || '',
        payStatus: f.payment_status?.value || ''
      };
      let items = inv.lineItems && inv.lineItems.length ? inv.lineItems : null;
      if(!items){
        const codes = inv.item_code || [];
        const descs = inv.item_description || [];
        const qtys = inv.qty || inv.quantity || [];
        const units = inv.unit_price || [];
        const totals = inv.line_total || [];
        const lens = [codes,descs,qtys,units,totals].filter(a=>a.length).map(a=>a.length);
        const uniqueLens = Array.from(new Set(lens));
        if(uniqueLens.length > 1){
          throw new Error('Line-item columns misaligned (codes/descriptions/qty/prices). Please re-check Column Engine selection.');
        }
        const N = uniqueLens[0] || 0;
        items = Array.from({length:N}).map((_,i)=>({
          sku: codes[i] || '',
          description: descs[i] || '',
          quantity: qtys[i] || '',
          unit_price: units[i] || '',
          amount: totals[i] || ''
        }));
      }
      if(!items.length) items = [{}];
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
          it.sku || '',
          it.description || '',
          qty,
          unit,
          lineTotal || '',
          base.subtotal,
          discount || '',
          base.tax,
          base.total,
          base.payMethod,
          base.payStatus,
          String(it.line_no || (idx+1))
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
