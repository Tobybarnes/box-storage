(() => {
    'use strict';
    const form = document.getElementById('labels-form');
    if (!form) return;
    const boxes = Array.from(form.querySelectorAll('input[name="box"]'));
    const selectAll = document.getElementById('select-all');
    const copies = document.getElementById('copies');
    const count = document.getElementById('selection-count');
    const total = document.getElementById('label-total');
    const button = document.getElementById('preview-labels-button');

    function updateSelection() {
        const selected = boxes.filter(box => box.checked).length;
        const labels = selected * Number(copies.value);
        const pages = Math.ceil(labels / 6);
        selectAll.checked = selected === boxes.length;
        selectAll.indeterminate = selected > 0 && selected < boxes.length;
        count.textContent = selected + ' selected';
        total.textContent = labels ? labels + ' label' + (labels === 1 ? '' : 's') + ' on ' + pages + ' sheet' + (pages === 1 ? '' : 's') : 'Select at least one box.';
        button.disabled = selected === 0;
    }
    selectAll.addEventListener('change', () => {
        boxes.forEach(box => { box.checked = selectAll.checked; });
        updateSelection();
    });
    boxes.forEach(box => box.addEventListener('change', updateSelection));
    copies.addEventListener('change', updateSelection);
    window.addEventListener('pageshow', updateSelection);
    updateSelection();
})();
