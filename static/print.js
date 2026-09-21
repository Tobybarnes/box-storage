(() => {
    'use strict';
    const button = document.getElementById('print-button');
    if (!button) return;
    const warning = document.getElementById('print-warning');
    const titles = Array.from(document.querySelectorAll('.label-title'));
    const sheets = document.querySelector('.print-sheets');
    const frames = Array.from(document.querySelectorAll('.print-sheet-frame'));
    let printing = false;

    function fitPaperPreview() {
        if (printing) return;
        const availableWidth = Math.max(1, sheets.clientWidth - 2);
        frames.forEach(frame => {
            const page = frame.querySelector('.print-page');
            // Offset dimensions stay at the original paper size; the transform
            // only changes how the complete sheet appears on a small screen.
            const scale = Math.min(1, availableWidth / page.offsetWidth);
            frame.style.width = page.offsetWidth * scale + 'px';
            frame.style.height = page.offsetHeight * scale + 'px';
            frame.style.setProperty('--preview-scale', String(scale));
        });
    }

    function resetPaperPreview() {
        frames.forEach(frame => {
            frame.style.removeProperty('width');
            frame.style.removeProperty('height');
            frame.style.removeProperty('--preview-scale');
        });
    }

    function fitTitles() {
        let overflow = 0;
        titles.forEach(title => {
            let points = 13;
            title.style.fontSize = points + 'pt';
            while (title.scrollHeight > title.clientHeight + 1 && points > 8) {
                points -= .25;
                title.style.fontSize = points + 'pt';
            }
            if (title.scrollHeight > title.clientHeight + 1) overflow++;
        });
        warning.hidden = overflow === 0;
        warning.textContent = overflow ? 'A box title is too long to fit legibly on these labels. All of its text is shown in the preview; shorten that title before printing.' : '';
        button.disabled = overflow > 0;
    }

    button.addEventListener('click', () => { fitTitles(); if (!button.disabled) window.print(); });
    window.addEventListener('beforeprint', () => {
        printing = true;
        resetPaperPreview();
        fitTitles();
    });
    window.addEventListener('afterprint', () => {
        printing = false;
        fitPaperPreview();
    });
    window.addEventListener('resize', () => { fitTitles(); fitPaperPreview(); });
    function preparePreview() { fitTitles(); fitPaperPreview(); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(preparePreview);
    else preparePreview();
})();
