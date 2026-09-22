import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoQueue } from '../static/photo-queue.js';

const photo = {filename: 'box-004-test.jpg', url: '/photos/box-004-test.jpg',
    thumbnail_url: '/photos/box-004-test.jpg', view_url: '/photos/box-004-test.jpg'};
const success = {ok: true, photo};
const blob = new Blob(['a captured photo'], {type: 'image/jpeg'});
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function memoryStore(records = []) {
    const data = new Map(records.map(record => [record.id, record]));
    return {data, async list(boxId) { return [...data.values()].filter(record => record.boxId === boxId); },
        async put(record) { data.set(record.id, structuredClone(record)); }, async remove(id) { data.delete(id); }};
}
async function setup(t, options = {}) {
    const requests = [], changes = [], timers = new Map();
    const store = options.store || memoryStore();
    const onlineTarget = new EventTarget();
    let counter = 0;
    const queue = await createPhotoQueue({boxId: 'box-004', uploadUrl: '/box/box-004/photos',
        store, onlineTarget, makeId: () => `photo-${++counter}`,
        transport: request => new Promise((resolve, reject) => requests.push({...request, resolve, reject})),
        setTimer: callback => { const id = ++counter; timers.set(id, callback); return id; },
        clearTimer: id => timers.delete(id), onChange: items => changes.push(items.map(item => ({...item}))),
        ...options});
    t.after(() => queue.destroy());
    await settle();
    return {queue, requests, changes, store, timers, onlineTarget,
        async resolve(index) { requests[index].resolve(success); await settle(); },
        async reject(index, error = new Error('Connection lost')) { requests[index].reject(error); await settle(); },
        async tick() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); }};
}

test('captures are stored before upload, sent serially, and removed only on server confirmation', async t => {
    const h = await setup(t);
    const a = await h.queue.add(blob, 'one.jpg');
    const b = await h.queue.add(blob, 'two.jpg');
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(a.status, 'uploading');
    assert.equal(b.status, 'queued');
    assert.equal(h.store.data.size, 2);
    assert.equal(a.persisted, true);
    h.requests[0].onProgress(64);
    assert.equal(a.progress, 64);
    await h.resolve(0);
    assert.equal(a.status, 'saved');
    assert.deepEqual(a.photo, photo);
    assert.equal(h.store.data.has(a.id), false);
    assert.equal(h.store.data.has(b.id), true);
    assert.equal(h.requests.length, 2);
    await h.resolve(1);
    assert.equal(h.store.data.size, 0);
    assert.equal(b.status, 'saved');
});

test('restoration uploads only the current box and keeps the original retry identity', async t => {
    const store = memoryStore([
        {id: 'existing-id', boxId: 'box-004', blob, name: 'old.jpg', createdAt: 10},
        {id: 'other-box-id', boxId: 'box-005', blob, name: 'other.jpg', createdAt: 20},
    ]);
    const h = await setup(t, {store});
    assert.equal(h.queue.items.length, 1);
    assert.equal(h.requests[0].id, 'existing-id');
    assert.equal(h.requests[0].name, 'old.jpg');
    await h.resolve(0);
    assert.equal(store.data.has('other-box-id'), true);
});

test('lost response retains the original file and retries the same id without duplication', async t => {
    const h = await setup(t);
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    await h.reject(0);
    assert.equal(h.store.data.has(item.id), true);
    assert.equal(item.status, 'failed');
    await h.tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].id, h.requests[0].id);
    assert.equal(h.requests[1].blob, blob);
    await h.resolve(1);
    assert.equal(item.status, 'saved');
    assert.equal(h.store.data.size, 0);
});

test('transient failures have bounded retries and reconnecting retries pending files', async t => {
    const h = await setup(t);
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    for (let attempt = 0; attempt < 3; attempt++) { await h.reject(attempt); await h.tick(); }
    assert.equal(h.requests.length, 3);
    assert.equal(h.timers.size, 0);
    assert.equal(item.status, 'failed');
    h.onlineTarget.dispatchEvent(new Event('online'));
    await settle();
    assert.equal(h.requests.length, 4);
    assert.equal(h.requests[3].id, item.id);
    await h.resolve(3);
    assert.equal(item.status, 'saved');
});

test('server validation rejection is recoverable but does not retry automatically', async t => {
    const h = await setup(t);
    const item = await h.queue.add(blob, 'invalid.jpg');
    await settle();
    await h.reject(0, Object.assign(new Error('Unsupported image'), {status: 400}));
    await h.tick();
    h.onlineTarget.dispatchEvent(new Event('online'));
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(item.status, 'failed');
    assert.equal(h.store.data.has(item.id), true);
    assert.match(item.error, /Unsupported/);
    h.queue.retry(item.id);
    await settle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].id, item.id);
});

test('quota failure still uploads from memory and surfaces the lack of local protection', async t => {
    const store = memoryStore();
    store.put = async () => { throw new Error('Quota exceeded'); };
    const h = await setup(t, {store});
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    assert.equal(item.persisted, false);
    assert.ok(h.queue.storageError);
    assert.equal(item.blob, blob);
    assert.equal(h.requests.length, 1);
    assert.ok(h.changes.some(items => items.some(current => !current.persisted)));
    await h.resolve(0);
    assert.equal(item.status, 'saved');
});

test('an unconfirmed response never discards the captured file or claims it is saved', async t => {
    const h = await setup(t);
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    h.requests[0].resolve({ok: true});
    await settle();
    assert.equal(item.status, 'failed');
    assert.equal(h.store.data.has(item.id), true);
    assert.equal(item.photo, null);
});

test('destroy aborts an active request and leaves the captured file available for restoration', async t => {
    const h = await setup(t);
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    h.queue.destroy();
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.store.data.has(item.id), true);
    await h.reject(0);
    assert.equal(h.timers.size, 0);
    const restored = await setup(t, {store: h.store});
    assert.equal(restored.requests[0].id, item.id);
});

test('upload waits for the pending file transaction to finish before contacting the server', async t => {
    const store = memoryStore();
    let finishWrite;
    store.put = record => new Promise(resolve => {
        finishWrite = () => { store.data.set(record.id, structuredClone(record)); resolve(); };
    });
    const h = await setup(t, {store});
    const adding = h.queue.add(blob, 'one.jpg');
    await settle();
    assert.equal(h.requests.length, 0);
    assert.equal(h.queue.items[0].status, 'queued');
    finishWrite();
    const item = await adding;
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(item.persisted, true);
    assert.equal(h.store.data.has(item.id), true);
});

test('permanently rejected photos remain recoverable after reload without automatic resubmission', async t => {
    const store = memoryStore([{id: 'rejected-id', boxId: 'box-004', blob, name: 'bad.jpg',
        createdAt: 10, status: 'failed', retryable: false, error: 'Unsupported image'}]);
    const h = await setup(t, {store});
    assert.equal(h.queue.items[0].status, 'failed');
    assert.equal(h.queue.items[0].persisted, true);
    assert.equal(h.requests.length, 0);
    assert.match(h.queue.items[0].error, /Unsupported/);
    h.queue.retry('rejected-id');
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].id, 'rejected-id');
});

test('blocked local storage is reported without preventing a new memory-only upload', async t => {
    const store = memoryStore();
    store.list = async () => { throw new Error('Database unavailable'); };
    store.put = async () => { throw new Error('Database unavailable'); };
    const h = await setup(t, {store});
    assert.ok(h.queue.storageError);
    const item = await h.queue.add(blob, 'new.jpg');
    await settle();
    assert.equal(item.persisted, false);
    assert.equal(h.requests.length, 1);
});

test('a failure to remove a confirmed upload is safe to recover using the same server identity', async t => {
    const store = memoryStore();
    store.remove = async () => { throw new Error('Database closed'); };
    const h = await setup(t, {store});
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    await h.resolve(0);
    assert.equal(item.status, 'saved');
    assert.equal(store.data.has(item.id), true);
    h.queue.destroy();
    const restored = await setup(t, {store});
    assert.equal(restored.requests[0].id, item.id);
    assert.equal(restored.requests[0].name, 'one.jpg');
});

test('confirmed photos can release their in-memory file only after pending-store cleanup finishes', async t => {
    const store = memoryStore();
    let finishRemoval;
    store.remove = id => new Promise(resolve => { finishRemoval = () => { store.data.delete(id); resolve(); }; });
    const h = await setup(t, {store});
    const item = await h.queue.add(blob, 'one.jpg');
    await settle();
    assert.equal(h.queue.releaseSavedBlob(item.id), false);
    assert.equal(item.blob, blob);
    h.requests[0].resolve(success);
    await settle();
    assert.equal(item.status, 'saved');
    assert.equal(h.queue.releaseSavedBlob(item.id), false);
    assert.equal(item.blob, blob);
    finishRemoval(); await settle();
    assert.equal(h.queue.releaseSavedBlob(item.id), true);
    assert.equal(item.blob, null);
    assert.deepEqual(item.photo, photo);
    assert.equal(store.data.size, 0);
});

test('a stalled IndexedDB write is aborted so the captured file can still upload from memory', async t => {
    const originalIndexedDB = globalThis.indexedDB;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timeouts = new Map();
    let timerId = 0, aborted = 0;
    globalThis.setTimeout = (callback, delay) => { timeouts.set(++timerId, {callback, delay}); return timerId; };
    globalThis.clearTimeout = id => timeouts.delete(id);
    globalThis.indexedDB = {open() {
        const request = {result: {
            close() {},
            transaction(_store, mode) {
                const tx = {abort() { aborted++; tx.onabort?.(); },
                    objectStore() { return {index() { return {getAll() {
                        const result = {result: []}; queueMicrotask(() => tx.oncomplete()); return result;
                    }}; }, put() { return {}; }}; }};
                return tx;
            },
        }};
        queueMicrotask(() => request.onsuccess());
        return request;
    }};
    t.after(() => {
        globalThis.indexedDB = originalIndexedDB;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    });
    const h = await setup(t, {store: undefined});
    const adding = h.queue.add(blob, 'one.jpg');
    await settle();
    assert.equal(h.requests.length, 0);
    const writeTimeout = [...timeouts.values()].find(timeout => timeout.delay === 5000);
    assert.ok(writeTimeout, 'pending IndexedDB write must have a bounded wait');
    writeTimeout.callback();
    const item = await adding;
    await settle();
    assert.equal(aborted, 1);
    assert.equal(item.persisted, false);
    assert.ok(h.queue.storageError);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].blob, blob);
});
