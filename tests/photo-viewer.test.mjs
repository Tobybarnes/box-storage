import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const scriptPath = new URL('../static/photo-viewer.js', import.meta.url);
const viewerScript = readFileSync(scriptPath, 'utf8');

function openPhoto(t, { loaded = true, photoWidth = 400, photoHeight = 300,
    stageWidth = 300, stageHeight = 600 } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <a href="/box/box-001" class="photo-close">Close</a>
        <figure class="photo-viewer-figure">
            <img class="photo-viewer-image" src="/box/box-001/photos/original.jpg" alt="Box photo">
        </figure>
        <div class="photo-viewer-controls" hidden>
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
        naturalWidth: {get: () => loaded ? photoWidth : 0},
        naturalHeight: {get: () => loaded ? photoHeight : 0},
    });
    Object.defineProperties(figure, {
        clientWidth: {get: () => stageWidth},
        clientHeight: {get: () => stageHeight},
    });
    window.eval(viewerScript);
    flushFrames();
    return {
        window, figure, image, controls,
        status: window.document.querySelector('#photo-rotation-status'),
        load() { loaded = true; image.dispatchEvent(new window.Event('load')); flushFrames(); },
        signalLoad() { image.dispatchEvent(new window.Event('load')); flushFrames(); },
        click(selector) { window.document.querySelector(selector).click(); flushFrames(); },
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

test('cached photos support both rotation directions, wraparound, and reset', t => {
    const viewer = openPhoto(t);
    assert.equal(viewer.controls.hidden, false);
    assertPhotoLayout(viewer, 300, 225, 0);
    viewer.click('[data-photo-rotate="-1"]');
    assertPhotoLayout(viewer, 400, 300, 270);
    assert.match(viewer.status.textContent, /270/);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 300, 225, 0);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 400, 300, 90);
    assert.match(viewer.status.textContent, /90/);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 300, 225, 180);
    viewer.click('[data-photo-reset]');
    assertPhotoLayout(viewer, 300, 225, 0);
    for (let turn = 0; turn < 4; turn++) viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 300, 225, 0);
    assert.equal(viewer.image.getAttribute('src'), '/box/box-001/photos/original.jpg');
    assert.equal(viewer.window.document.querySelector('.photo-close').getAttribute('href'), '/box/box-001');
});

test('portrait photos remain fully fitted when turned sideways', t => {
    const viewer = openPhoto(t, {photoWidth: 300, photoHeight: 400});
    assertPhotoLayout(viewer, 300, 400, 0);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 225, 300, 90);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 300, 400, 180);
});

test('a rotated photo refits after the phone changes orientation', t => {
    const viewer = openPhoto(t);
    viewer.click('[data-photo-rotate="1"]');
    assertPhotoLayout(viewer, 400, 300, 90);
    viewer.resize(600, 300);
    assertPhotoLayout(viewer, 300, 225, 90);
    viewer.click('[data-photo-reset]');
    assertPhotoLayout(viewer, 400, 300, 0);
    viewer.resize(300, 600);
    assertPhotoLayout(viewer, 300, 225, 0);
});
