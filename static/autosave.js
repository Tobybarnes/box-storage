// One write at a time: a response only acknowledges the snapshot it received.
export function createAutosave({readContent, save, onState, delay = 700,
    setTimer = setTimeout, clearTimer = clearTimeout, initialContent = readContent()}) {
    let saved = initialContent;
    let timer;
    let active;
    let uncertain = false;
    let destroyed = false;
    const publish = (state, error) => { if (!destroyed) onState({state, error}); };
    const cancel = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
    function needsSave() { return uncertain || readContent() !== saved; }
    function isDirty() { return Boolean(active) || needsSave(); }
    function flush() {
        cancel();
        if (destroyed) return Promise.resolve(false);
        if (active) return active;
        if (!needsSave()) { publish('saved'); return Promise.resolve(true); }
        active = Promise.resolve().then(async () => {
            try {
                while (!destroyed && needsSave()) {
                    const snapshot = readContent();
                    publish('saving');
                    await save(snapshot);
                    saved = snapshot;
                    uncertain = false;
                }
                active = undefined;
                publish('saved');
                return !destroyed;
            } catch (error) {
                // A failed response does not prove that the server rejected the write.
                uncertain = true;
                active = undefined;
                publish('error', error);
                return false;
            }
        });
        return active;
    }
    function changed() {
        cancel();
        if (destroyed) return;
        if (active) return;
        if (!needsSave()) { publish('saved'); return; }
        publish('pending');
        timer = setTimer(flush, delay);
    }
    publish(readContent() === saved ? 'saved' : 'pending');
    return {changed, flush, retry: flush, isDirty, destroy() {destroyed = true; cancel();}};
}
