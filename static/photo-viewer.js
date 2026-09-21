(() => {
    'use strict';
    const figure = document.querySelector('.photo-viewer-figure');
    const image = document.querySelector('.photo-viewer-image');
    const controls = document.querySelector('.photo-viewer-controls');
    if (!figure || !image || !controls) return;
    const reset = controls.querySelector('[data-photo-reset]');
    const status = document.getElementById('photo-rotation-status');
    let quarterTurns = 0;
    let ready = false;

    function fitImage() {
        const width = figure.clientWidth;
        const height = figure.clientHeight;
        if (!ready || !width || !height) return;
        const sideways = quarterTurns % 2 !== 0;
        const scale = Math.min(
            width / (sideways ? image.naturalHeight : image.naturalWidth),
            height / (sideways ? image.naturalWidth : image.naturalHeight),
        );
        image.style.width = `${image.naturalWidth * scale}px`;
        image.style.height = `${image.naturalHeight * scale}px`;
        image.style.transform = `translate(-50%, -50%) rotate(${quarterTurns * 90}deg)`;
    }

    function rotate(turns) {
        quarterTurns = (turns + 4) % 4;
        fitImage();
        reset.disabled = quarterTurns === 0;
        status.textContent = quarterTurns ? `Photo rotation: ${quarterTurns * 90} degrees.` : 'Original orientation.';
    }

    function enableRotation() {
        if (ready || !image.naturalWidth || !image.naturalHeight) return;
        ready = true;
        image.removeEventListener('load', enableRotation);
        controls.hidden = false;
        figure.classList.add('is-ready');
        reset.disabled = true;
        fitImage();
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(fitImage);
            observer.observe(figure);
        } else {
            window.addEventListener('resize', fitImage);
        }
        window.addEventListener('pageshow', fitImage);
    }

    controls.querySelectorAll('[data-photo-rotate]').forEach(button => {
        button.addEventListener('click', () => rotate(quarterTurns + Number(button.dataset.photoRotate)));
    });
    reset.addEventListener('click', () => rotate(0));
    image.addEventListener('load', enableRotation);
    if (image.complete) enableRotation();
})();
