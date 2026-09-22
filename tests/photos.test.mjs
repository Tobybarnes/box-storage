import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {setupPhotoSession} from '../static/photos.js';

const template = readFileSync(new URL('../templates/box.html', import.meta.url), 'utf8');
// Keep the shipping controls and structure. Only server-populated values/loops
// are replaced; no test-only copy of the camera interface can drift from it.
const section = template.match(/<section class="photos-section"[\s\S]*?<\/section>/)[0]
    .replace(/{% for photo in photos %}[\s\S]*?{% endfor %}/g, '')
    .replace(/{{ box_id }}/g, 'box-004').replace(/{{ box.number }}/g, '004')
    .replace(/{{ box.display_title }}/g, 'Australia photos')
    .replace(/{{ url_for\('upload_photo', box_id=box_id\) }}/g, '/box/box-004/photos')
    .replace(/{{ photos\|length }}/g, '0')
    .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
const settle = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };

async function setup(t, options = {}) {
    const dom = new JSDOM(`<!doctype html><body>${section}</body>`, {url: 'https://box-storage.test/box/box-004'});
    const {window} = dom;
    const {document} = window;
    const $ = id => document.getElementById(id);
    window.HTMLElement.prototype.scrollIntoView = () => {};
    let urlId = 0;
    const revoked = [];
    window.URL.createObjectURL = () => `blob:photo-${++urlId}`;
    window.URL.revokeObjectURL = url => revoked.push(url);
    const dialog = $('camera-session');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
    let hidden = false;
    Object.defineProperty(document, 'hidden', {get: () => hidden});
    const video = $('camera-video');
    Object.defineProperties(video, {videoWidth: {value: 1280}, videoHeight: {value: 720}, readyState: {value: 4}});
    video.play = async () => {};
    const drawings = [], blobCallbacks = [];
    let captureId = 0;
    window.HTMLCanvasElement.prototype.getContext = () => ({drawImage: (...args) => drawings.push(args)});
    window.HTMLCanvasElement.prototype.toBlob = function (callback) {
        const captured = new window.Blob([`shot-${++captureId}`], {type: 'image/jpeg'});
        if (options.delayCapture) blobCallbacks.push(() => callback(captured));
        else callback(captured);
    };
    const cameraRequests = [], streams = [];
    function newStream() {
        const track = new window.EventTarget();
        track.stops = 0;
        track.stop = () => { track.stops++; };
        const stream = {track, getTracks: () => [track], getVideoTracks: () => [track]};
        streams.push(stream);
        return stream;
    }
    const mediaDevices = options.noCamera ? {} : {getUserMedia: constraints => {
        if (options.cameraError) { cameraRequests.push({constraints}); return Promise.reject(options.cameraError); }
        if (options.delayPermission) return new Promise((resolve, reject) => cameraRequests.push({constraints, resolve, reject}));
        const stream = newStream();
        cameraRequests.push({constraints, stream});
        return Promise.resolve(stream);
    }};
    const libraryClicks = [], nativeClicks = [];
    $('library-input').addEventListener('click', () => libraryClicks.push(true));
    $('camera-input').addEventListener('click', () => nativeClicks.push(true));
    $('photo-empty').hidden = false;
    if (options.existingFilename) {
        const link = document.createElement('a');
        link.className = 'photo-link';
        link.dataset.photoFilename = options.existingFilename;
        $('saved-photos').append(link);
        $('saved-photos').hidden = false;
        $('photo-count').textContent = '1';
    }
    let onChange, queueId = 0;
    const adds = [], retries = [], pendingAdds = [], released = [];
    const queue = {items: [], destroyed: false, storageError: null,
        async add(blob, name) {
            const item = {id: `upload-${++queueId}`, blob, name, status: 'queued', progress: 0, persisted: true, error: null, photo: null};
            adds.push(item); queue.items.push(item); onChange(queue.items);
            if (options.delayAdd) await new Promise(resolve => pendingAdds.push(resolve));
            return item;
        },
        retry(id) { retries.push(id); const item = queue.items.find(item => item.id === id); item.status = 'queued'; onChange(queue.items); },
        releaseSavedBlob(id) {
            const item = queue.items.find(item => item.id === id);
            if (!item || item.status !== 'saved') return false;
            released.push(id); item.blob = null; return true;
        },
        destroy() { queue.destroyed = true; },
    };
    const session = await setupPhotoSession({document, mediaDevices, createQueue: async settings => {
        assert.equal(settings.boxId, 'box-004');
        assert.equal(settings.uploadUrl, '/box/box-004/photos');
        onChange = settings.onChange;
        onChange(queue.items);
        return queue;
    }});
    t.after(() => { session.dispose(); window.close(); });
    function update(item, changes) { Object.assign(item, changes); onChange(queue.items); }
    function unload() { const event = new window.Event('beforeunload', {cancelable: true}); window.dispatchEvent(event); return event.defaultPrevented; }
    return {window, document, $, dialog, video, queue, session, adds, retries, pendingAdds, revoked,
        cameraRequests, streams, newStream, drawings, blobCallbacks, libraryClicks, nativeClicks, update, unload, released,
        async click(id) { $(id).click(); await settle(); },
        async choose(files, inputId = 'library-input') {
            Object.defineProperty($(inputId), 'files', {configurable: true, value: files});
            $(inputId).dispatchEvent(new window.Event('change')); await settle();
        },
        visibility(value) { hidden = value; document.dispatchEvent(new window.Event('visibilitychange')); },
        file(name, content = 'photo', type = 'image/jpeg') { return new window.File([content], name, {type}); },
        saved(item, filename = `${item.id}.jpg`) { update(item, {status: 'saved', progress: 100,
            photo: {filename, url: `/photos/${filename}`, thumbnail_url: `/photos/${filename}?thumbnail=1`, view_url: `/photos/${filename}/view`}}); },
    };
}

test('one camera permission supports repeated shots that enter independent upload items immediately', async t => {
    const h = await setup(t);
    await h.click('take-photos');
    assert.equal(h.dialog.open, true);
    assert.equal(h.cameraRequests.length, 1);
    assert.equal(h.cameraRequests[0].constraints.audio, false);
    assert.equal(h.cameraRequests[0].constraints.video.facingMode.ideal, 'environment');
    assert.equal(h.$('camera-shutter').disabled, false);
    await h.click('camera-shutter');
    await h.click('camera-shutter');
    assert.equal(h.adds.length, 2);
    assert.notEqual(h.adds[0].id, h.adds[1].id);
    assert.notEqual(h.adds[0].blob, h.adds[1].blob);
    assert.equal(h.adds[0].blob.type, 'image/jpeg');
    assert.ok(h.adds.every(item => item.blob.size > 0));
    assert.equal(h.cameraRequests.length, 1);
    assert.equal(h.streams[0].track.stops, 0);
    assert.equal(h.dialog.open, true);
    assert.equal(h.$('camera-shutter').disabled, false);
    assert.equal(h.$('camera-uploads').children.length, 2);
    assert.equal(h.$('upload-list').children.length, 2);
});

test('Done closes and stops the camera while pending uploads remain active', async t => {
    const h = await setup(t);
    await h.click('take-photos'); await h.click('camera-shutter');
    await h.click('camera-done');
    assert.equal(h.dialog.open, false);
    assert.equal(h.streams[0].track.stops, 1);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.queue.destroyed, false);
    assert.equal(h.adds[0].status, 'queued');
    h.saved(h.adds[0]);
    assert.match(h.$('upload-summary').textContent, /Photo saved/);
    assert.equal(h.$('saved-photos').children.length, 1);
});

test('Escape closes the camera and stops its tracks without cancelling uploads', async t => {
    const h = await setup(t);
    await h.click('take-photos'); await h.click('camera-shutter');
    const event = new h.window.Event('cancel', {cancelable: true});
    h.dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.dialog.open, false);
    assert.equal(h.streams[0].track.stops, 1);
    assert.equal(h.queue.destroyed, false);
});

test('a camera permission response arriving after Done cannot reactivate the camera', async t => {
    const h = await setup(t, {delayPermission: true});
    await h.click('take-photos');
    await h.click('camera-done');
    const lateStream = h.newStream();
    h.cameraRequests[0].resolve(lateStream);
    await settle();
    assert.equal(lateStream.track.stops, 1);
    assert.equal(h.video.srcObject, null);
    assert.equal(h.dialog.open, false);
    assert.equal(h.$('camera-shutter').disabled, true);
});

test('denied camera permission exposes working phone-camera and library fallbacks', async t => {
    const h = await setup(t, {cameraError: Object.assign(new Error('denied'), {name: 'NotAllowedError'})});
    await h.click('take-photos');
    assert.equal(h.$('native-camera').hidden, false);
    assert.equal(h.$('camera-library').hidden, false);
    assert.match(h.$('camera-status').textContent, /wasn’t allowed/);
    await h.click('native-camera');
    assert.equal(h.nativeClicks.length, 1);
    assert.equal(h.dialog.open, false);
    await h.click('take-photos'); await h.click('camera-library');
    assert.equal(h.libraryClicks.length, 1);
    assert.equal(h.dialog.open, false);
});

test('browsers without a camera stream retain the phone-camera fallback', async t => {
    const h = await setup(t, {noCamera: true});
    await h.click('take-photos');
    assert.equal(h.$('native-camera').hidden, false);
    assert.equal(h.$('camera-library').hidden, false);
    assert.equal(h.$('camera-shutter').disabled, true);
    await h.click('native-camera');
    assert.equal(h.nativeClicks.length, 1);
});

test('backgrounding stops the camera and returning allows an explicit fresh camera session', async t => {
    const h = await setup(t);
    await h.click('take-photos');
    h.visibility(true);
    assert.equal(h.streams[0].track.stops, 1);
    assert.equal(h.$('resume-camera').hidden, false);
    assert.equal(h.$('camera-shutter').disabled, true);
    assert.equal(h.queue.destroyed, false);
    h.visibility(false);
    assert.equal(h.cameraRequests.length, 1);
    await h.click('resume-camera');
    assert.equal(h.cameraRequests.length, 2);
    assert.equal(h.video.srcObject, h.streams[1]);
    assert.equal(h.$('camera-shutter').disabled, false);
});

test('choosing several library photos queues each file separately without a submit action', async t => {
    const h = await setup(t);
    const first = h.file('one.jpg'), second = h.file('two.png', 'second', 'image/png');
    await h.choose([first, second]);
    assert.equal(h.adds.length, 2);
    assert.equal(h.adds[0].blob, first);
    assert.equal(h.adds[1].blob, second);
    assert.deepEqual(h.adds.map(item => item.name), ['one.jpg', 'two.png']);
    assert.notEqual(h.adds[0].id, h.adds[1].id);
    assert.equal(h.$('library-input').multiple, true);
    assert.equal(h.$('photo-fallback').hidden, true);
});

test('pending and fully transmitted photos are never announced as saved before server confirmation', async t => {
    const h = await setup(t);
    await h.choose([h.file('one.jpg')]);
    assert.doesNotMatch(h.$('upload-summary').textContent, /saved/i);
    assert.equal(h.$('saved-photos').children.length, 0);
    h.update(h.adds[0], {status: 'uploading', progress: 100});
    assert.doesNotMatch(h.$('upload-summary').textContent, /saved/i);
    assert.match(h.$('upload-list').textContent, /Finishing upload/);
    assert.equal(h.$('saved-photos').children.length, 0);
    h.saved(h.adds[0]);
    assert.match(h.$('upload-summary').textContent, /Photo saved/);
    assert.equal(h.$('saved-photos').children.length, 1);
    assert.equal(h.$('photo-count').textContent, '1');
});

test('failed uploads expose a retry for the same queue item and a way to keep the captured file', async t => {
    const h = await setup(t);
    await h.choose([h.file('one.jpg')]);
    h.update(h.adds[0], {status: 'failed', error: 'Connection lost'});
    const row = h.$('upload-list').firstElementChild;
    assert.equal(row.querySelector('button').hidden, false);
    assert.equal(row.querySelector('a').hidden, false);
    assert.match(row.querySelector('.upload-state').textContent, /Connection lost/);
    row.querySelector('button').click();
    assert.deepEqual(h.retries, [h.adds[0].id]);
    assert.equal(h.adds.length, 1);
    assert.equal(row.dataset.status, 'queued');
});

test('a recovered confirmed filename does not duplicate an existing gallery photo or count', async t => {
    const h = await setup(t, {existingFilename: 'already-saved.jpg'});
    await h.choose([h.file('one.jpg')]);
    h.saved(h.adds[0], 'already-saved.jpg');
    h.saved(h.adds[0], 'already-saved.jpg');
    assert.equal(h.$('saved-photos').children.length, 1);
    assert.equal(h.$('photo-count').textContent, '1');
});

test('leaving is guarded while capture encoding or an upload is pending, then released after confirmation', async t => {
    const h = await setup(t, {delayCapture: true});
    assert.equal(h.unload(), false);
    await h.click('take-photos'); await h.click('camera-shutter');
    assert.equal(h.adds.length, 0);
    assert.equal(h.unload(), true);
    h.blobCallbacks[0](); await settle();
    assert.equal(h.adds.length, 1);
    assert.equal(h.unload(), true);
    h.saved(h.adds[0]);
    assert.equal(h.unload(), false);
});

test('leaving is guarded while a library photo is still being added to durable storage', async t => {
    const h = await setup(t, {delayAdd: true});
    await h.choose([h.file('one.jpg'), h.file('two.jpg')]);
    assert.equal(h.unload(), true);
    h.pendingAdds[0](); await settle();
    assert.equal(h.adds.length, 2);
    h.saved(h.adds[0]); h.saved(h.adds[1]);
    assert.equal(h.unload(), true);
    h.pendingAdds[1](); await settle();
    assert.equal(h.unload(), false);
});

test('unsupported or empty library files do not prevent valid photos from being queued', async t => {
    const h = await setup(t);
    await h.choose([h.file('phone.heic'), h.file('empty.jpg', ''), h.file('good.jpg')]);
    assert.deepEqual(h.adds.map(item => item.name), ['good.jpg']);
    assert.equal(h.$('photo-input-error').hidden, false);
    assert.match(h.$('photo-input-error').textContent, /phone.heic/);
    assert.match(h.$('photo-input-error').textContent, /empty.jpg/);
});

test('memory-only captures clearly ask the user to keep the page open', async t => {
    const h = await setup(t);
    await h.choose([h.file('one.jpg')]);
    h.update(h.adds[0], {persisted: false});
    assert.match(h.$('upload-storage-hint').textContent, /couldn’t keep a recovery copy/);
    assert.equal(h.$('upload-list').querySelector('a').hidden, false);
    h.saved(h.adds[0]);
    assert.equal(h.$('upload-storage-hint').hidden, true);
});

test('confirmed uploads switch every preview to the server and release the captured blob URL and data', async t => {
    const h = await setup(t);
    await h.choose([h.file('one.jpg')]);
    const item = h.adds[0];
    const localUrl = h.$('upload-list').querySelector('img').src;
    assert.match(localUrl, /^blob:/);
    assert.ok(item.blob);
    h.saved(item, 'server-photo.jpg');
    assert.equal(item.blob, null);
    assert.deepEqual(h.released, [item.id]);
    assert.deepEqual(h.revoked, [localUrl]);
    assert.match(h.$('upload-list').querySelector('img').src, /server-photo.jpg\?thumbnail=1$/);
    assert.match(h.$('camera-uploads').querySelector('img').src, /server-photo.jpg\?thumbnail=1$/);
    assert.match(h.$('upload-list').querySelector('a').href, /server-photo.jpg$/);
    h.saved(item, 'server-photo.jpg');
    assert.deepEqual(h.revoked, [localUrl]);
});

test('the camera keeps the pending-upload and memory-only recovery warning visible', async t => {
    const h = await setup(t);
    await h.click('take-photos'); await h.click('camera-shutter');
    assert.equal(h.$('camera-storage-hint').hidden, false);
    assert.match(h.$('camera-storage-hint').textContent, /Keep the app open/);
    h.update(h.adds[0], {persisted: false});
    assert.match(h.$('camera-storage-hint').textContent, /recovery copy isn’t available/);
    h.saved(h.adds[0]);
    assert.equal(h.$('camera-storage-hint').hidden, true);
});

test('Done and Escape wait until the shot finishes encoding and entering the upload queue', async t => {
    const h = await setup(t, {delayCapture: true, delayAdd: true});
    await h.click('take-photos'); await h.click('camera-shutter');
    assert.equal(h.$('camera-done').disabled, true);
    await h.click('camera-done');
    h.dialog.dispatchEvent(new h.window.Event('cancel', {cancelable: true}));
    assert.equal(h.dialog.open, true);
    assert.equal(h.streams[0].track.stops, 0);
    h.blobCallbacks[0](); await settle();
    assert.equal(h.adds.length, 1);
    assert.equal(h.$('camera-done').disabled, true);
    await h.click('camera-done');
    h.dialog.dispatchEvent(new h.window.Event('cancel', {cancelable: true}));
    assert.equal(h.dialog.open, true);
    h.pendingAdds[0](); await settle();
    assert.equal(h.$('camera-done').disabled, false);
    await h.click('camera-done');
    assert.equal(h.dialog.open, false);
    assert.equal(h.streams[0].track.stops, 1);
    assert.equal(h.queue.destroyed, false);
});

test('navigation requests confirmation for memory-only files and respects staying on the page', async t => {
    const h = await setup(t);
    await h.choose([h.file('one.jpg')]);
    h.update(h.adds[0], {persisted: false});
    const link = h.document.createElement('a');
    link.href = '/box/box-005'; h.document.body.append(link);
    let confirmations = 0;
    h.window.confirm = () => { confirmations++; return false; };
    const attempt = new h.window.Event('click', {bubbles: true, cancelable: true});
    link.dispatchEvent(attempt);
    assert.equal(confirmations, 1);
    assert.equal(attempt.defaultPrevented, true);
    h.update(h.adds[0], {persisted: true});
    const protectedAttempt = new h.window.Event('click', {bubbles: true, cancelable: true});
    link.dispatchEvent(protectedAttempt);
    assert.equal(confirmations, 1);
    assert.equal(protectedAttempt.defaultPrevented, false);
});

test('navigation is held while a captured shot is being encoded without interrupting a recovery download', async t => {
    const h = await setup(t, {delayCapture: true});
    await h.click('take-photos'); await h.click('camera-shutter');
    const link = h.document.createElement('a');
    link.href = '/box/box-005'; h.document.body.append(link);
    const attempt = new h.window.Event('click', {bubbles: true, cancelable: true});
    link.dispatchEvent(attempt);
    assert.equal(attempt.defaultPrevented, true);
    assert.match(h.$('upload-summary').textContent, /wait while your photos are queued/);
    link.download = 'photo.jpg';
    const download = new h.window.Event('click', {bubbles: true, cancelable: true});
    link.dispatchEvent(download);
    assert.equal(download.defaultPrevented, false);
    h.blobCallbacks[0](); await settle();
});
