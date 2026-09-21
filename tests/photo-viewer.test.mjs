import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const scriptPath = new URL('../static/photo-viewer.js', import.meta.url);
const viewerScript = readFileSync(scriptPath, 'utf8');

function openPhoto(t, { loaded = true, savedRotation = 0, photoWidth = 400, photoHeight = 300,
    stageWidth = 300, stageHeight = 600 } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <a href="/box/box-001" class="photo-close">Close</a>
        <figure class="photo-viewer-figure">
            <img class="photo-viewer-image" src="/box/box-001/photos/original.jpg" alt="Box photo">
        </figure>
        <div class="photo-viewer-controls" data-rotation-url="/box/box-001/photos/original.jpg/rotate" data-photo-rotation="${savedRotation}" hidden>
            <button type="button" data-photo-rotate="-1">Rotate left</button>
            <button type="button" data-photo-rotate="1">Rotate right</button>
            <button type="button" data-photo-reset>Reset</button>
            <span id="photo-rotation-status" role="status"></span>
        </div>
    </body></html>`, {url: 'https://box-storage.test/box/box-001/photos/original.jpg/view', runScripts: 'outside-only'});
    t.after(() => dom.window.close());
    const { window } = dom;
    const figure = window.document.querySelector('.photo-viewer-figure');
    const image = window.document.querySelector('.photo-viewer-image');
    const controls = window.document.querySelector('.photo-viewer-controls');
    const close = window.document.querySelector('.photo-close');
    const initialSource = image.src;
    const cachedImages = new Map([[initialSource, {width: photoWidth, height: photoHeight}]]);
    let clock = 0;
    let nextTimer = 0;
    const timers = new Map();
    window.setTimeout = (callback, delay = 0) => {
        timers.set(++nextTimer, {callback, deadline: clock + delay});
        return nextTimer;
    };
    window.clearTimeout = id => timers.delete(id);
    const requests = [];
    window.fetch = (url, options) => new Promise((resolve, reject) => {
        requests.push({url, options, resolve, reject});
        options.signal?.addEventListener('abort', () => reject(new window.DOMException('Request aborted', 'AbortError')), {once: true});
    });
    const preloads = [];
    const NativeImage = window.Image;
    window.Image = function () {
        const preload = new NativeImage();
        let dimensions = {width: 0, height: 0};
        Object.defineProperties(preload, {
            complete: {get: () => dimensions.width > 0},
            naturalWidth: {get: () => dimensions.width},
            naturalHeight: {get: () => dimensions.height},
        });
        preloads.push({
            image: preload,
            load(width, height) {
                dimensions = {width, height};
                cachedImages.set(preload.src, dimensions);
                preload.dispatchEvent(new window.Event('load'));
            },
            fail() { preload.dispatchEvent(new window.Event('error')); },
        });
        return preload;
    };
    const frames = new Map();
    let nextFrame = 0;
    window.requestAnimationFrame = callback => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    };
    window.cancelAnimationFrame = id => frames.delete(id);
    const flushFrames = () => {
        for (let iteration = 0; frames.size && iteration < 10; iteration++) {
            const pending = [...frames.values()];
            frames.clear();
            for (const callback of pending) callback(0);
        }
        assert.equal(frames.size, 0, 'photo layout must settle');
    };
    const observers = [];
    window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
    };
    Object.defineProperties(image, {
        complete: {get: () => loaded},
        naturalWidth: {get: () => loaded ? (cachedImages.get(image.src)?.width || 0) : 0},
        naturalHeight: {get: () => loaded ? (cachedImages.get(image.src)?.height || 0) : 0},
    });
    Object.defineProperties(figure, {
        clientWidth: {get: () => stageWidth},
        clientHeight: {get: () => stageHeight},
    });
    window.eval(viewerScript);
    flushFrames();
    const settle = async () => {
        for (let iteration = 0; iteration < 8; iteration++) {
            await Promise.resolve();
            flushFrames();
        }
    };
    return {
        window, figure, image, controls, close, requests, preloads, initialSource, settle,
        status: window.document.querySelector('#photo-rotation-status'),
        buttons: [...controls.querySelectorAll('button')],
        reset: controls.querySelector('[data-photo-reset]'),
        load() { loaded = true; image.dispatchEvent(new window.Event('load')); flushFrames(); },
        signalLoad() { image.dispatchEvent(new window.Event('load')); flushFrames(); },
        click(selector) { window.document.querySelector(selector).click(); flushFrames(); },
        async respond(body, {status = 200, jsonError = false} = {}) {
            assert.ok(requests.length, 'rotation must make a request');
            requests.at(-1).resolve({ok: status >= 200 && status < 300, status,
                json: async () => { if (jsonError) throw new SyntaxError('Invalid JSON'); return body; }});
            await settle();
        },
        async rejectRequest() {
            assert.ok(requests.length, 'rotation must make a request');
            requests.at(-1).reject(new TypeError('Network request failed'));
            await settle();
        },
        async loadSavedImage(width, height) {
            assert.ok(preloads.length, 'saved photo must be loaded before replacing the displayed image');
            preloads.at(-1).load(width, height);
            await settle();
            image.dispatchEvent(new window.Event('load'));
            await settle();
        },
        async failSavedImage() {
            assert.ok(preloads.length, 'saved photo must be preloaded');
            preloads.at(-1).fail();
            await settle();
        },
        async elapse(milliseconds) {
            clock += milliseconds;
            for (const [id, timer] of timers) {
                if (timer.deadline <= clock) { timers.delete(id); timer.callback(); }
            }
            await settle();
        },
        closeIsGuarded() {
            const event = new window.MouseEvent('click', {bubbles: true, cancelable: true});
            let guarded;
            // Inspect the app's guard, then suppress jsdom's unsupported navigation.
            close.addEventListener('click', dispatched => {
                guarded = dispatched.defaultPrevented;
                dispatched.preventDefault();
            }, {once: true});
            close.dispatchEvent(event);
            return guarded;
        },
        unloadIsGuarded() {
            const event = new window.Event('beforeunload', {cancelable: true});
            window.dispatchEvent(event);
            return event.defaultPrevented;
        },
        resize(width, height) {
            stageWidth = width;
            stageHeight = height;
            for (const observer of observers) {
                if (observer.targets.has(figure)) {
                    observer.callback([{target: figure, contentRect: {width, height}}], observer);
                }
            }
            flushFrames();
        },
    };
}

function assertPhotoLayout(viewer, width, height, degrees) {
    assert.equal(viewer.image.style.width, `${width}px`);
    assert.equal(viewer.image.style.height, `${height}px`);
    assert.equal(viewer.image.style.transform, `translate(-50%, -50%) rotate(${degrees}deg)`);
}

function assertRotationRequest(viewer, rotation, previousRotation) {
    const request = viewer.requests.at(-1);
    assert.ok(request, 'rotation must be persisted');
    assert.equal(new URL(request.url, viewer.window.location.href).pathname,
        '/box/box-001/photos/original.jpg/rotate');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {rotation, expected_rotation: previousRotation});
}

function savedPhoto(rotation) {
    return {rotation, photo_url: `/box/box-001/photos/original.jpg?rotation=${rotation}&v=test`};
}

test('rotation becomes available only after a usable photo loads', t => {
    const viewer = openPhoto(t, {loaded: false});
    assert.equal(viewer.controls.hidden, true);
    viewer.signalLoad();
    assert.equal(viewer.controls.hidden, true, 'a load event with no image dimensions cannot enable rotation');
    assert.equal(viewer.figure.classList.contains('is-ready'), false);
    viewer.load();
    assert.equal(viewer.controls.hidden, false);
    assert.equal(viewer.figure.classList.contains('is-ready'), true);
    assertPhotoLayout(viewer, 300, 225, 0);
});

test('reopened rotated photos reset their absolute saved orientation', async t => {
    const viewer = openPhoto(t, {savedRotation: 1, photoWidth: 300, photoHeight: 400});
    assertPhotoLayout(viewer, 300, 400, 0);
    assert.equal(viewer.reset.disabled, false);
    viewer.click('[data-photo-reset]');
    assertPhotoLayout(viewer, 225, 300, 270);
    assertRotationRequest(viewer, 0, 1);
    await viewer.respond(savedPhoto(0));
    await viewer.loadSavedImage(400, 300);
    assertPhotoLayout(viewer, 300, 225, 0);
    assert.equal(viewer.reset.disabled, true);
    assert.match(viewer.status.textContent, /rotation saved/i);
});

test('rotation previews immediately and guards navigation only until the save is confirmed', async t => {
    const viewer = openPhoto(t);
    assert.equal(viewer.controls.hidden, false);
    assertPhotoLayout(viewer, 300, 225, 0);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 400, 300, 90);
    assertRotationRequest(viewer, 1, 0);
    assert.ok(viewer.buttons.every(button => button.disabled));
    assert.equal(viewer.closeIsGuarded(), true);
    assert.equal(viewer.unloadIsGuarded(), true);
    viewer.click('[data-photo-rotate="1"]');
    viewer.window.document.querySelector('[data-photo-rotate="-1"]')
        .dispatchEvent(new viewer.window.MouseEvent('click', {bubbles: true}));
    assert.equal(viewer.requests.length, 1, 'repeat taps cannot send competing writes');
    await viewer.respond(savedPhoto(1));
    assert.equal(viewer.image.src, viewer.initialSource, 'keep the visible photo while its saved variant loads');
    assert.ok(viewer.buttons.every(button => button.disabled));
    assert.equal(viewer.closeIsGuarded(), false, 'a saved rotation must not trap someone waiting for a large image');
    assert.equal(viewer.unloadIsGuarded(), false);
    await viewer.loadSavedImage(300, 400);
    assert.equal(viewer.image.src, new URL(savedPhoto(1).photo_url, viewer.window.location.href).href);
    assertPhotoLayout(viewer, 300, 400, 0);
    assert.match(viewer.status.textContent, /rotation saved/i);
    assert.ok(viewer.buttons.every(button => !button.disabled));
    assert.equal(viewer.closeIsGuarded(), false);
    assert.equal(viewer.unloadIsGuarded(), false);
});

test('both rotation directions wrap and use the most recently saved orientation', async t => {
    const viewer = openPhoto(t);
    viewer.click('[data-photo-rotate="-1"]');
    assertPhotoLayout(viewer, 400, 300, 270);
    assertRotationRequest(viewer, 3, 0);
    await viewer.respond(savedPhoto(3));
    await viewer.loadSavedImage(300, 400);
    viewer.click('[data-photo-rotate="1"]');
    assertRotationRequest(viewer, 0, 3);
    assertPhotoLayout(viewer, 225, 300, 90);
    await viewer.respond(savedPhoto(0));
    await viewer.loadSavedImage(400, 300);
    assertPhotoLayout(viewer, 300, 225, 0);
});

test('portrait previews and rollback refit after the phone changes orientation', async t => {
    const viewer = openPhoto(t, {photoWidth: 300, photoHeight: 400});
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 225, 300, 90);
    viewer.resize(600, 300);
    assertPhotoLayout(viewer, 300, 400, 90);
    await viewer.respond({error: 'Could not save rotation'}, {status: 500});
    assertPhotoLayout(viewer, 225, 300, 0);
    viewer.resize(300, 600);
    assertPhotoLayout(viewer, 300, 400, 0);
});

for (const failure of ['server', 'network', 'invalid JSON', 'missing photo URL', 'empty photo URL', 'wrong rotation', 'conflict']) {
    test(`${failure} failure restores the saved photo and leaves it usable`, async t => {
        const viewer = openPhoto(t, {savedRotation: 1, photoWidth: 300, photoHeight: 400});
        viewer.click('[data-photo-rotate="1"]');
        assertPhotoLayout(viewer, 225, 300, 90);
        if (failure === 'network') await viewer.rejectRequest();
        else if (failure === 'invalid JSON') await viewer.respond(null, {jsonError: true});
        else if (failure === 'missing photo URL') await viewer.respond({rotation: 2});
        else if (failure === 'empty photo URL') await viewer.respond({rotation: 2, photo_url: ''});
        else if (failure === 'wrong rotation') await viewer.respond(savedPhoto(3));
        else await viewer.respond({error: failure === 'conflict' ? 'Photo changed. Reopen it to continue.' : 'Unable to save rotation'},
            {status: failure === 'conflict' ? 409 : 500});
        assertPhotoLayout(viewer, 300, 400, 0);
        assert.equal(viewer.image.src, viewer.initialSource);
        assert.ok(viewer.status.textContent.trim(), 'save failures must be visible');
        assert.doesNotMatch(viewer.status.textContent, /^rotation saved[.!]/i);
        if (failure === 'conflict') assert.match(viewer.status.textContent, /reopen|reload|open.*again/i);
        assert.ok(viewer.buttons.every(button => !button.disabled));
        assert.equal(viewer.closeIsGuarded(), false);
        assert.equal(viewer.unloadIsGuarded(), false);
        viewer.click('[data-photo-rotate="1"]');
        assertRotationRequest(viewer, 2, 1);
    });
}

test('a saved rotation with a failed image reload retains the preview and saved revision', async t => {
    const viewer = openPhoto(t);
    viewer.click('[data-photo-rotate="1"]');
    await viewer.respond(savedPhoto(1));
    await viewer.failSavedImage();
    assert.equal(viewer.image.src, viewer.initialSource);
    assertPhotoLayout(viewer, 400, 300, 90);
    assert.match(viewer.status.textContent, /saved/i);
    assert.match(viewer.status.textContent, /reload|reopen/i);
    assert.ok(viewer.buttons.every(button => !button.disabled));
    assert.equal(viewer.closeIsGuarded(), false);
    viewer.click('[data-photo-rotate="1"]');
    assertRotationRequest(viewer, 2, 1);
    assertPhotoLayout(viewer, 300, 225, 180);
    await viewer.respond(savedPhoto(2));
    await viewer.loadSavedImage(400, 300);
    assertPhotoLayout(viewer, 300, 225, 0);
});

test('a stalled save releases navigation and restores the prior orientation', async t => {
    const viewer = openPhoto(t);
    viewer.click('[data-photo-rotate="1"]');
    assert.equal(viewer.closeIsGuarded(), true);
    await viewer.elapse(60_000);
    assertPhotoLayout(viewer, 300, 225, 0);
    assert.equal(viewer.closeIsGuarded(), false);
    assert.equal(viewer.unloadIsGuarded(), false);
    assert.equal(viewer.buttons[0].disabled, false);
    assert.doesNotMatch(viewer.status.textContent, /^rotation saved[.!]/i);
    viewer.click('[data-photo-rotate="1"]');
    assertRotationRequest(viewer, 1, 0);
});

test('a stalled image reload keeps the saved preview without blocking navigation', async t => {
    const viewer = openPhoto(t);
    viewer.click('[data-photo-rotate="1"]');
    await viewer.respond(savedPhoto(1));
    assert.equal(viewer.closeIsGuarded(), false);
    assert.equal(viewer.unloadIsGuarded(), false);
    await viewer.elapse(60_000);
    assertPhotoLayout(viewer, 400, 300, 90);
    assert.equal(viewer.image.src, viewer.initialSource);
    assert.equal(viewer.closeIsGuarded(), false);
    assert.equal(viewer.unloadIsGuarded(), false);
    assert.ok(viewer.buttons.every(button => !button.disabled));
    assert.match(viewer.status.textContent, /saved/i);
    assert.match(viewer.status.textContent, /reload|reopen/i);
    viewer.click('[data-photo-rotate="1"]');
    assertRotationRequest(viewer, 2, 1);
});
