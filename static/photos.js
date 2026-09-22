import { createPhotoQueue } from './photo-queue.js?v=2.06';

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp)$/i;

export async function setupPhotoSession({document: doc = document, createQueue = createPhotoQueue,
    mediaDevices = doc.defaultView.navigator.mediaDevices} = {}) {
    const section = doc.getElementById('photo-session');
    if (!section) return null;
    const win = doc.defaultView;
    const $ = id => doc.getElementById(id);
    const dialog = $('camera-session');
    const video = $('camera-video');
    const shutter = $('camera-shutter');
    const previewUrls = new Map();
    const rows = new Map();
    const cameraRows = new Map();
    const savedNames = new Set([...$('saved-photos').querySelectorAll('[data-photo-filename]')].map(link => link.dataset.photoFilename));
    let queue;
    let items = [];
    let stream = null;
    let cameraGeneration = 0;
    let capturing = false;
    let processingFiles = 0;
    let cameraReadyTimer;
    let disposed = false;
    const listeners = [];
    function listen(target, type, handler) {
        target.addEventListener(type, handler);
        listeners.push(() => target.removeEventListener(type, handler));
    }
    function setText(element, text) {
        if (element.textContent !== text) element.textContent = text;
    }
    function preview(item) {
        if (item.status === 'saved' && item.photo) return item.photo.thumbnail_url;
        if (!previewUrls.has(item.id)) previewUrls.set(item.id, win.URL.createObjectURL(item.blob));
        return previewUrls.get(item.id);
    }
    function statusText(item) {
        if (item.status === 'saved') return 'Saved';
        if (item.status === 'failed') return item.error || 'Couldn’t upload. Try again.';
        if (item.status === 'uploading') return item.progress >= 100 ? 'Finishing upload…' : `Uploading ${Math.round(item.progress)}%`;
        return item.error || 'Waiting to upload';
    }
    function addSavedPhoto(item) {
        const photo = item.photo;
        if (!photo || savedNames.has(photo.filename)) return;
        savedNames.add(photo.filename);
        const link = doc.createElement('a');
        link.className = 'photo-link';
        link.dataset.photoFilename = photo.filename;
        link.href = photo.view_url;
        link.setAttribute('aria-label', `Open photo of box ${section.dataset.boxNumber} at full size`);
        const image = doc.createElement('img');
        image.src = photo.thumbnail_url;
        image.alt = `Photo of box ${section.dataset.boxNumber}`;
        image.loading = 'lazy';
        link.append(image);
        $('saved-photos').append(link);
        $('saved-photos').hidden = false;
        $('photo-empty').hidden = true;
        setText($('photo-count'), String(savedNames.size));
    }
    function render(nextItems) {
        if (disposed) return;
        items = nextItems;
        const pending = items.filter(item => item.status !== 'saved');
        const saved = items.length - pending.length;
        const failed = items.filter(item => item.status === 'failed').length;
        const uploading = items.filter(item => item.status === 'uploading').length;
        const waiting = pending.length - failed - uploading;
        let summary = 'Photos upload as you go.';
        if (items.length && !pending.length) summary = saved === 1 ? 'Photo saved' : `All ${saved} photos saved`;
        else if (items.length) summary = [saved && `${saved} saved`, uploading && `${uploading} uploading`, waiting && `${waiting} waiting`, failed && `${failed} ${failed === 1 ? 'needs' : 'need'} retry`].filter(Boolean).join(' · ');
        setText($('upload-summary'), summary);
        setText($('camera-upload-summary'), summary);
        $('upload-summary').setAttribute('aria-live', dialog.open ? 'off' : 'polite');
        $('upload-session').hidden = !items.length;
        const memoryOnly = pending.some(item => !item.persisted);
        $('upload-storage-hint').hidden = !pending.length;
        setText($('upload-storage-hint'), memoryOnly
            ? 'Keep this page open until every photo is saved. This browser couldn’t keep a recovery copy.'
            : 'Keep the app open to finish uploading. If interrupted, reopen this box on this device to resume.');
        $('camera-storage-hint').hidden = !pending.length;
        setText($('camera-storage-hint'), memoryOnly
            ? 'Keep this page open until all photos are saved. A recovery copy isn’t available yet.'
            : 'Keep the app open until all photos are saved.');
        for (const item of items) {
            let row = rows.get(item.id);
            if (!row) {
                row = doc.createElement('li');
                row.className = 'upload-item';
                const image = doc.createElement('img');
                image.src = preview(item);
                image.alt = '';
                const copy = doc.createElement('div');
                copy.className = 'upload-copy';
                const name = doc.createElement('span');
                name.className = 'upload-name';
                name.textContent = item.name;
                const state = doc.createElement('span');
                state.className = 'upload-state';
                const download = doc.createElement('a');
                download.href = preview(item);
                download.download = item.name;
                download.textContent = 'Keep a copy';
                download.hidden = true;
                const retry = doc.createElement('button');
                retry.type = 'button';
                retry.className = 'button button-secondary';
                retry.textContent = 'Retry';
                retry.setAttribute('aria-label', `Retry uploading ${item.name}`);
                retry.addEventListener('click', () => queue.retry(item.id));
                copy.append(name, state, download);
                row.append(image, copy, retry);
                rows.set(item.id, row);
                $('upload-list').append(row);
                const cameraRow = doc.createElement('li');
                cameraRow.className = 'camera-thumbnail';
                const cameraImage = image.cloneNode();
                cameraImage.alt = item.name;
                cameraRow.append(cameraImage, doc.createElement('span'));
                cameraRows.set(item.id, cameraRow);
                $('camera-uploads').append(cameraRow);
                $('camera-uploads').scrollLeft = $('camera-uploads').scrollWidth;
            }
            row.dataset.status = item.status;
            setText(row.querySelector('.upload-state'), statusText(item));
            row.querySelector('button').hidden = item.status !== 'failed';
            row.querySelector('a').hidden = item.status !== 'failed' && (item.persisted || item.status === 'saved');
            const cameraRow = cameraRows.get(item.id);
            cameraRow.dataset.status = item.status;
            setText(cameraRow.querySelector('span'), item.status === 'failed' ? 'Retry on box' : item.status === 'uploading' ? `${Math.round(item.progress)}%` : item.status === 'saved' ? 'Saved' : 'Waiting');
            if (item.status === 'saved') {
                addSavedPhoto(item);
                row.querySelector('img').src = item.photo.thumbnail_url;
                cameraRow.querySelector('img').src = item.photo.thumbnail_url;
                row.querySelector('a').href = item.photo.url;
                if (previewUrls.has(item.id)) {
                    win.URL.revokeObjectURL(previewUrls.get(item.id));
                    previewUrls.delete(item.id);
                }
                queue?.releaseSavedBlob(item.id);
            }
        }
    }
    queue = await createQueue({boxId: section.dataset.boxId, uploadUrl: section.dataset.uploadUrl, onChange: render});
    render(queue.items);
    $('photo-actions').hidden = false;
    $('photo-fallback').hidden = true;

    async function addFiles(fileList) {
        const files = [...fileList];
        if (!files.length) return;
        processingFiles++;
        const errors = [];
        for (const file of files) {
            if (!IMAGE_EXTENSION.test(file.name)) errors.push(`${file.name}: choose a JPG, PNG, WebP or GIF. You can also use Take photos.`);
            else if (!file.size || file.size > MAX_PHOTO_BYTES) errors.push(`${file.name}: choose a photo smaller than 15 MB.`);
            else {
                try { await queue.add(file, file.name); }
                catch { errors.push(`${file.name}: couldn’t queue this photo. Please choose it again.`); }
            }
        }
        processingFiles--;
        $('photo-input-error').hidden = !errors.length;
        setText($('photo-input-error'), errors.join('\n'));
        if (errors.length) $('photo-input-error').scrollIntoView({block: 'nearest'});
    }
    listen($('library-input'), 'change', event => {
        const files = [...event.target.files];
        event.target.value = '';
        void addFiles(files);
    });
    listen($('camera-input'), 'change', event => {
        const files = [...event.target.files];
        event.target.value = '';
        closeCamera();
        void addFiles(files);
    });
    listen($('choose-photos'), 'click', () => $('library-input').click());
    listen($('camera-library'), 'click', () => { closeCamera(); $('library-input').click(); });
    listen($('native-camera'), 'click', () => { closeCamera(); $('camera-input').click(); });

    function stopCamera() {
        cameraGeneration++;
        win.clearTimeout(cameraReadyTimer);
        if (stream) stream.getTracks().forEach(track => track.stop());
        stream = null;
        video.srcObject = null;
        shutter.disabled = true;
    }
    function showCameraMessage(message, {resume = false, fallback = false} = {}) {
        $('camera-message').hidden = false;
        setText($('camera-status'), message);
        $('resume-camera').hidden = !resume;
        $('native-camera').hidden = !fallback;
        $('camera-library').hidden = !fallback;
    }
    function ready() {
        if (!stream || !dialog.open || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
        win.clearTimeout(cameraReadyTimer);
        $('camera-message').hidden = true;
        shutter.disabled = capturing;
    }
    async function startCamera() {
        stopCamera();
        const generation = cameraGeneration;
        showCameraMessage('Opening camera…');
        if (!mediaDevices?.getUserMedia) {
            showCameraMessage('Use your phone camera, or choose photos from your library.', {fallback: true});
            return;
        }
        try {
            const nextStream = await mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 2560}, height: {ideal: 1920}}});
            if (generation !== cameraGeneration || !dialog.open || disposed) {
                nextStream.getTracks().forEach(track => track.stop());
                return;
            }
            stream = nextStream;
            for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
                if (stream === nextStream && dialog.open) {
                    stopCamera();
                    showCameraMessage('Camera paused.', {resume: true, fallback: true});
                }
            }, {once: true});
            video.srcObject = stream;
            video.muted = true;
            cameraReadyTimer = win.setTimeout(() => {
                if (generation !== cameraGeneration) return;
                stopCamera();
                showCameraMessage('The camera couldn’t start. Try again, or use your phone camera.', {resume: true, fallback: true});
            }, 15000);
            await video.play();
            ready();
        } catch (error) {
            if (generation !== cameraGeneration || !dialog.open) return;
            stopCamera();
            showCameraMessage(error.name === 'NotAllowedError'
                ? 'Camera access wasn’t allowed. You can still use your phone camera or choose photos.'
                : 'The camera isn’t available. Use your phone camera or choose photos.', {fallback: true});
        }
    }
    function closeCamera() {
        if (capturing) return;
        stopCamera();
        if (dialog.open) dialog.close();
        doc.body.classList.remove('camera-open');
        render(items);
    }
    listen($('take-photos'), 'click', () => {
        if (typeof dialog.showModal !== 'function') { $('camera-input').click(); return; }
        dialog.showModal();
        doc.body.classList.add('camera-open');
        render(items);
        void startCamera();
    });
    listen($('camera-done'), 'click', closeCamera);
    listen(dialog, 'cancel', event => { event.preventDefault(); closeCamera(); });
    listen(dialog, 'close', () => { stopCamera(); doc.body.classList.remove('camera-open'); render(items); });
    listen($('resume-camera'), 'click', () => { void startCamera(); });
    listen(video, 'loadeddata', ready);
    listen(video, 'canplay', ready);
    listen(shutter, 'click', async () => {
        if (capturing || shutter.disabled || !stream) return;
        capturing = true;
        shutter.disabled = true;
        $('camera-done').disabled = true;
        setText($('camera-capture-status'), 'Keeping this shot…');
        const canvas = doc.createElement('canvas');
        try {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('No image')), 'image/jpeg', .94));
            if (blob.size > MAX_PHOTO_BYTES) throw new Error('Photo too large');
            await queue.add(blob, `${section.dataset.boxId}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
            setText($('camera-capture-status'), 'Photo captured. Ready for the next.');
        } catch {
            setText($('camera-capture-status'), 'Couldn’t keep that shot. Please take it again.');
        } finally {
            canvas.width = canvas.height = 0;
            capturing = false;
            $('camera-done').disabled = false;
            if (stream && dialog.open) ready();
        }
    });
    listen(doc, 'visibilitychange', () => {
        if (doc.hidden && dialog.open) {
            stopCamera();
            showCameraMessage('Camera paused while the app was away.', {resume: true, fallback: true});
        }
    });
    listen(win, 'pagehide', () => {
        stopCamera();
        if (dialog.open) showCameraMessage('Camera paused.', {resume: true, fallback: true});
    });
    listen(win, 'beforeunload', event => {
        if (capturing || processingFiles || items.some(item => item.status !== 'saved')) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    listen(doc, 'click', event => {
        const link = event.target.closest?.('a[href]');
        if (!link || link.hasAttribute('download') || link.target === '_blank' || link.getAttribute('href').startsWith('#')) return;
        if (capturing || processingFiles) {
            event.preventDefault();
            setText($('upload-summary'), 'Please wait while your photos are queued.');
        } else if (items.some(item => item.status !== 'saved' && !item.persisted)) {
            if (!win.confirm('Some photos haven’t uploaded and this browser couldn’t keep a recovery copy. Leaving now may lose them. Leave this page?')) event.preventDefault();
        }
    });
    return {queue, dispose() {
        disposed = true;
        stopCamera();
        if (dialog.open) dialog.close();
        doc.body.classList.remove('camera-open');
        listeners.forEach(remove => remove());
        queue.destroy();
        previewUrls.forEach(url => win.URL.revokeObjectURL(url));
    }};
}

if (typeof document !== 'undefined') {
    setupPhotoSession().catch(() => {
        // The original upload form remains usable if enhancement cannot start.
        const fallback = document.getElementById('photo-fallback');
        if (fallback) fallback.hidden = false;
    });
}
