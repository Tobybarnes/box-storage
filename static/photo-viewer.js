(() => {
    'use strict';
    const figure = document.querySelector('.photo-viewer-figure');
    const image = document.querySelector('.photo-viewer-image');
    const controls = document.querySelector('.photo-viewer-controls');
    if (!figure || !image || !controls) return;
    const reset = controls.querySelector('[data-photo-reset]');
    const status = document.getElementById('photo-rotation-status');
    const close = document.querySelector('.photo-close');
    const rotateButtons = [...controls.querySelectorAll('[data-photo-rotate]')];
    let savedRotation = Number(controls.dataset.photoRotation) || 0;
    let quarterTurns = savedRotation;
    let imageRotation = savedRotation;
    let sourceWidth = 0;
    let sourceHeight = 0;
    let ready = false;
    let saving = false;
    let awaitingSave = false;

    function fitImage() {
        const width = figure.clientWidth;
        const height = figure.clientHeight;
        if (!ready || !width || !height || !sourceWidth || !sourceHeight) return;
        const relativeTurns = (quarterTurns - imageRotation + 4) % 4;
        const sideways = relativeTurns % 2 !== 0;
        const scale = Math.min(
            width / (sideways ? sourceHeight : sourceWidth),
            height / (sideways ? sourceWidth : sourceHeight),
        );
        image.style.width = `${sourceWidth * scale}px`;
        image.style.height = `${sourceHeight * scale}px`;
        image.style.transform = `translate(-50%, -50%) rotate(${relativeTurns * 90}deg)`;
    }

    function updateControls() {
        rotateButtons.forEach(button => { button.disabled = !ready || saving; });
        reset.disabled = !ready || saving || quarterTurns === 0;
        controls.setAttribute('aria-busy', String(saving));
        if (awaitingSave) close?.setAttribute('aria-disabled', 'true');
        else close?.removeAttribute('aria-disabled');
    }

    function loadSavedImage(url) {
        return new Promise((resolve, reject) => {
            const preview = new Image();
            const timeout = window.setTimeout(() => finish(false), 15000);
            function finish(loaded) {
                window.clearTimeout(timeout);
                preview.onload = null;
                preview.onerror = null;
                if (loaded && preview.naturalWidth && preview.naturalHeight) resolve(preview);
                else reject(new Error('The saved photo could not be loaded.'));
            }
            preview.onload = () => finish(true);
            preview.onerror = () => finish(false);
            preview.src = url;
        });
    }

    async function rotate(turns) {
        if (!ready || saving) return;
        const desired = (turns + 4) % 4;
        if (desired === savedRotation) return;
        quarterTurns = desired;
        saving = true;
        awaitingSave = true;
        fitImage();
        updateControls();
        status.textContent = 'Saving rotation…';
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(controls.dataset.rotationUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({rotation: desired, expected_rotation: savedRotation}),
                signal: controller.signal,
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(response.status === 409
                    ? 'This photo changed elsewhere. Reopen it before rotating again.'
                    : 'Couldn’t save rotation. ' + (typeof result?.error === 'string' ? result.error : 'Try again.'));
            }
            if (result.rotation !== desired || typeof result.photo_url !== 'string' || !result.photo_url.trim()) {
                throw new Error('Couldn’t confirm the save. Reopen the photo and try again.');
            }
            const url = new URL(result.photo_url, window.location.href);
            if (url.origin !== window.location.origin) {
                throw new Error('Couldn’t confirm the save. Reopen the photo and try again.');
            }
            window.clearTimeout(timeout);
            savedRotation = desired;
            controls.dataset.photoRotation = String(savedRotation);
            awaitingSave = false;
            status.textContent = 'Rotation saved.';
            updateControls();
            try {
                const loaded = await loadSavedImage(url.href);
                sourceWidth = loaded.naturalWidth;
                sourceHeight = loaded.naturalHeight;
                imageRotation = desired;
                image.src = result.photo_url;
                fitImage();
                status.textContent = 'Rotation saved.';
            } catch {
                status.textContent = 'Rotation saved. Reopen the photo to refresh the image.';
            }
        } catch (error) {
            quarterTurns = savedRotation;
            fitImage();
            const message = typeof error?.message === 'string' ? error.message : '';
            status.textContent = message.startsWith('Couldn’t') || message.startsWith('This photo')
                ? message : 'Couldn’t confirm the save. Reopen the photo and try again.';
        } finally {
            window.clearTimeout(timeout);
            saving = false;
            awaitingSave = false;
            updateControls();
        }
    }

    function enableRotation() {
        if (ready || !image.naturalWidth || !image.naturalHeight) return;
        ready = true;
        sourceWidth = image.naturalWidth;
        sourceHeight = image.naturalHeight;
        image.removeEventListener('load', enableRotation);
        controls.hidden = false;
        figure.classList.add('is-ready');
        updateControls();
        fitImage();
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(fitImage);
            observer.observe(figure);
        } else {
            window.addEventListener('resize', fitImage);
        }
        window.addEventListener('pageshow', fitImage);
    }

    rotateButtons.forEach(button => {
        button.addEventListener('click', () => rotate(quarterTurns + Number(button.dataset.photoRotate)));
    });
    reset.addEventListener('click', () => rotate(0));
    close?.addEventListener('click', event => { if (awaitingSave) event.preventDefault(); });
    window.addEventListener('beforeunload', event => {
        if (!awaitingSave) return;
        event.preventDefault();
        event.returnValue = '';
    });
    image.addEventListener('load', enableRotation);
    if (image.complete) enableRotation();
})();
