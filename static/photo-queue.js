// A captured file stays in IndexedDB until the server confirms its upload ID.
// Retrying that ID also makes a lost response safe to recover after a reload.
const DATABASE = 'box-storage-photo-queue';
const STORE = 'pending-photos';

async function openPhotoStore() {
    if (!globalThis.indexedDB) throw new Error('Local photo storage is unavailable.');
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        let finished = false;
        const timeout = setTimeout(() => finish(new Error('Local photo storage could not be opened.')), 5000);
        function finish(error, database) {
            if (finished) { database?.close(); return; }
            finished = true;
            clearTimeout(timeout);
            if (error) reject(error); else resolve(database);
        }
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(STORE, {keyPath: 'id'});
            store.createIndex('boxId', 'boxId');
        };
        request.onsuccess = () => finish(null, request.result);
        request.onerror = () => finish(request.error || new Error('Local photo storage could not be opened.'));
        request.onblocked = () => finish(new Error('Another open window is blocking local photo storage.'));
    });
    db.onversionchange = () => db.close();
    function transaction(mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const request = operation(tx.objectStore(STORE));
            let finished = false;
            const timeout = setTimeout(() => {
                finish(new Error('Local photo storage took too long.'));
                try { tx.abort(); } catch { /* A completed transaction is already safe. */ }
            }, 5000);
            function finish(error, result) {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                if (error) reject(error); else resolve(result);
            }
            tx.oncomplete = () => finish(null, request.result);
            tx.onabort = () => finish(tx.error || new Error('Local photo storage was interrupted.'));
            tx.onerror = () => finish(tx.error || new Error('Local photo storage failed.'));
        });
    }
    return {
        list: boxId => transaction('readonly', store => store.index('boxId').getAll(boxId)),
        put: record => transaction('readwrite', store => store.put(record)),
        remove: id => transaction('readwrite', store => store.delete(id)),
        close: () => db.close(),
    };
}

function uploadError(message, status = 0) {
    return Object.assign(new Error(message), {status,
        retryable: !status || status >= 500 || status === 408 || status === 429});
}

export function uploadPhoto({url, blob, name, id, onProgress, signal}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let finished = false;
        const abort = () => xhr.abort();
        function finish(error, response) {
            if (finished) return;
            finished = true;
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(response);
        }
        if (signal?.aborted) { finish(uploadError('Upload paused.')); return; }
        xhr.open('POST', url);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.responseType = 'json';
        xhr.timeout = 90000;
        xhr.upload.onprogress = event => {
            if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) finish(null, xhr.response);
            else finish(uploadError(xhr.response?.error || 'The photo could not be uploaded.', xhr.status));
        };
        xhr.onerror = () => finish(uploadError('Connection lost. Your photo is waiting to retry.'));
        xhr.ontimeout = () => finish(uploadError('The upload timed out. Your photo is waiting to retry.'));
        xhr.onabort = () => finish(uploadError('Upload paused.'));
        signal?.addEventListener('abort', abort, {once: true});
        const form = new FormData();
        form.append('photo', blob, name);
        form.append('upload_id', id);
        try { xhr.send(form); } catch (error) { finish(error); }
    });
}

function newId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createPhotoQueue({boxId, uploadUrl, onChange = () => {},
    store: suppliedStore, transport = uploadPhoto, makeId = newId,
    setTimer = setTimeout, clearTimer = clearTimeout,
    onlineTarget = globalThis.window, retryDelays = [1500, 5000]}) {
    const items = [];
    const ready = new Set();
    const releaseReady = new Set();
    const attempts = new Map();
    const timers = new Map();
    let store = suppliedStore;
    let storageError = null;
    let destroyed = false;
    let active = null;
    let running = false;

    function publish() {
        if (destroyed) return;
        // Rendering must not turn a successfully retained photo into a failed add.
        try { onChange(items); } catch { /* The queue can continue without the view. */ }
    }
    function record(item) {
        return {id: item.id, boxId, name: item.name, blob: item.blob, createdAt: item.createdAt,
            status: item.status, retryable: item.retryable, error: item.error};
    }
    async function persist(item) {
        if (!store) return false;
        try { await store.put(record(item)); return true; }
        catch (error) { storageError = error; return false; }
    }
    function cancelRetry(id) {
        if (timers.has(id)) clearTimer(timers.get(id));
        timers.delete(id);
    }
    function enqueue(item, resetAttempts = false) {
        if (destroyed || item.status === 'saved' || item.status === 'uploading' || !ready.has(item.id)) return;
        cancelRetry(item.id);
        if (resetAttempts) attempts.set(item.id, 0);
        item.status = 'queued';
        item.progress = 0;
        item.error = null;
        item.autoRetry = false;
        publish();
        void pump();
    }
    async function pump() {
        if (running || destroyed) return;
        running = true;
        try {
            while (!destroyed) {
                const item = items.find(candidate => candidate.status === 'queued' && ready.has(candidate.id));
                if (!item) break;
                active = new AbortController();
                item.status = 'uploading';
                item.error = null;
                const attempt = (attempts.get(item.id) || 0) + 1;
                attempts.set(item.id, attempt);
                publish();
                try {
                    const response = await transport({url: uploadUrl, blob: item.blob, name: item.name,
                        id: item.id, signal: active.signal, onProgress: progress => {
                            if (destroyed || item.status !== 'uploading') return;
                            item.progress = Math.min(99, Math.max(0, Number(progress) || 0));
                            publish();
                        }});
                    if (destroyed) break;
                    if (!response?.ok || !response.photo?.filename || !response.photo?.url) {
                        throw uploadError('The server did not confirm this photo. It is waiting to retry.');
                    }
                    item.photo = response.photo;
                    item.status = 'saved';
                    item.progress = 100;
                    item.autoRetry = false;
                    // Removal errors are safe: a restored record retries the same upload ID.
                    if (item.persisted && store) {
                        try { await store.remove(item.id); } catch (error) { storageError = error; }
                    }
                    releaseReady.add(item.id);
                } catch (error) {
                    if (destroyed) break;
                    item.status = 'failed';
                    item.error = error?.message || 'The photo could not be uploaded.';
                    item.retryable = error?.retryable ?? (!error?.status || error.status >= 500 || error.status === 408 || error.status === 429);
                    item.autoRetry = item.retryable && attempt <= retryDelays.length;
                    // Remember permanent rejection so a reload does not repeatedly send it.
                    if (item.persisted) await persist(item);
                    if (destroyed) break;
                    if (item.autoRetry) timers.set(item.id, setTimer(() => enqueue(item), retryDelays[attempt - 1]));
                } finally {
                    active = null;
                }
                publish();
            }
        } finally {
            running = false;
        }
    }
    function online() {
        for (const item of items) if (item.status === 'failed' && item.retryable) enqueue(item, true);
    }
    const queue = {
        items,
        get storageError() { return storageError; },
        async add(blob, name = 'photo.jpg') {
            if (destroyed) throw new Error('This photo session has ended.');
            if (!blob || !blob.size) throw new Error('The photo is empty. Please take it again.');
            const item = {id: makeId(), boxId, name, blob, createdAt: Date.now(),
                status: 'queued', progress: 0, persisted: false, error: null, photo: null,
                retryable: true, autoRetry: false};
            items.push(item);
            publish();
            item.persisted = await persist(item);
            ready.add(item.id);
            publish();
            void pump();
            return item;
        },
        retry(id) { const item = items.find(candidate => candidate.id === id); if (item) enqueue(item, true); },
        releaseSavedBlob(id) {
            const item = items.find(candidate => candidate.id === id);
            if (!item || item.status !== 'saved' || !releaseReady.has(id)) return false;
            item.blob = null;
            return true;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const id of timers.keys()) cancelRetry(id);
            onlineTarget?.removeEventListener('online', online);
            active?.abort();
            if (suppliedStore === undefined) store?.close?.();
        },
    };
    if (store === undefined) {
        try { store = await openPhotoStore(); } catch (error) { storageError = error; store = null; }
    }
    if (store) {
        try {
            const restored = await store.list(boxId);
            for (const entry of restored.sort((a, b) => a.createdAt - b.createdAt)) {
                if (entry.boxId !== boxId || !entry.blob?.size) continue;
                const permanentFailure = entry.status === 'failed' && entry.retryable === false;
                items.push({...entry, status: permanentFailure ? 'failed' : 'queued', progress: 0,
                    persisted: true, error: permanentFailure ? entry.error : null, photo: null,
                    retryable: !permanentFailure, autoRetry: false});
                ready.add(entry.id);
            }
        } catch (error) { storageError = error; }
    }
    onlineTarget?.addEventListener('online', online);
    publish();
    void pump();
    return queue;
}
