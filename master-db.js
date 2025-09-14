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
    'Payment Status'
  ];

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
        subtotal: totals.subtotal || '',
        discount: totals.discount || '',
        tax: totals.tax || '',
        total: totals.total || '',
        payMethod: f.payment_method?.value || '',
        payStatus: f.payment_status?.value || ''
      };
      const items = inv.lineItems && inv.lineItems.length ? inv.lineItems : [{}];
      items.forEach(it => {
        const qty = it.quantity || '';
        const unit = it.unit_price || '';
        let lineTotal = it.amount || '';
        if(!lineTotal && qty && unit){
          const q = parseFloat(qty);
          const u = parseFloat(unit);
          if(!isNaN(q) && !isNaN(u)) lineTotal = (q*u).toFixed(2);
        }
        const discount = it.discount !== undefined ? it.discount : base.discount;
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
          base.payStatus
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
