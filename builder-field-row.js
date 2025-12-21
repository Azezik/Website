(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BuilderFieldRow = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function createSelect(options = [], selectedValue = '', className = '') {
    const sel = document.createElement('select');
    if (className) sel.className = className;
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    sel.value = selectedValue;
    return sel;
  }

  function createFieldRow({
    field,
    index = 0,
    magicTypeOptions = {},
    onDelete,
    onChange,
    isSubordinate = false,
    allowAreaType = true
  } = {}) {
    const normalizedMagic = magicTypeOptions || {};
    const row = document.createElement('div');
    row.className = 'custom-field-row';
    if ((field?.fieldType || '').toLowerCase() === 'areabox') row.classList.add('area-row');
    if (isSubordinate) row.classList.add('sub-field-row');

    const idxBadge = document.createElement('span');
    idxBadge.className = 'field-index';
    idxBadge.textContent = `Field ${index + 1}`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-field-btn';
    deleteBtn.title = 'Delete field';
    deleteBtn.textContent = 'Delete';
    if (typeof onDelete === 'function') {
      deleteBtn.addEventListener('click', () => onDelete(field, index));
    }

    const typeOptions = [
      { value: 'static', label: 'Static' },
      { value: 'dynamic', label: 'Dynamic' }
    ];
    if (allowAreaType) typeOptions.unshift({ value: 'areabox', label: 'Areabox' });
    const typeSel = createSelect(
      typeOptions,
      field.fieldType || 'static',
      'field-type'
    );
    typeSel.addEventListener('change', (e) => {
      const previousType = field.fieldType;
      field.fieldType = e.target.value;
      if (typeof onChange === 'function') onChange(field, index, 'fieldType', { previousType });
    });

    const magicOpts = [
      { value: normalizedMagic.ANY || 'any', label: 'ANY' },
      { value: normalizedMagic.TEXT || 'text', label: 'TEXT ONLY' },
      { value: normalizedMagic.NUMERIC || 'numeric', label: 'NUMERIC ONLY' }
    ];
    const magicSel = createSelect(
      magicOpts,
      field.magicType || field.magicDataType || magicOpts[0].value,
      'field-magic-type'
    );
    magicSel.addEventListener('change', (e) => {
      field.magicType = e.target.value;
      field.magicDataType = e.target.value;
      if (typeof onChange === 'function') onChange(field, index, 'magicType');
    });

    const nameInput = document.createElement('input');
    nameInput.className = 'field-name';
    nameInput.placeholder = field.fieldType === 'areabox' ? 'Area name' : 'Field name';
    nameInput.value = field.name || '';
    nameInput.addEventListener('input', (e) => {
      field.name = e.target.value;
      if (typeof onChange === 'function') onChange(field, index, 'name');
    });

    row.appendChild(idxBadge);
    row.appendChild(typeSel);
    row.appendChild(magicSel);
    row.appendChild(nameInput);
    row.appendChild(deleteBtn);
    return row;
  }

  return { createFieldRow };
});
