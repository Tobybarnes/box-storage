import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../static/autosave.js';

const original = '# Box 13 Photos\r\n\r\n- Original notes  \r\n';
const firstEdit = '# Box 13 Photos\r\n\r\n- Original notes  \r\n- Negatives\r\n';
const laterEdit = '# Box 13 Photos\r\n\r\n- Original notes  \r\n- Negatives & family albums\r\n';

async function settle() {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

function setup(t, initial = original) {
    let content = initial;
    let clock = 0;
    let nextTimer = 0;
    const timers = new Map();
    const requests = [];
    const states = [];
    const autosave = createAutosave({
        readContent: () => content,
        save: snapshot => new Promise((resolve, reject) => {
            requests.push({snapshot, resolve, reject});
        }),
        onState: state => states.push(state),
        delay: 100,
        setTimer: (callback, delay) => {
            timers.set(++nextTimer, {callback, deadline: clock + delay});
            return nextTimer;
        },
        clearTimer: id => timers.delete(id),
    });
    t.after(() => autosave.destroy());
    return {
        autosave, requests, states,
        edit(value) { content = value; autosave.changed(); },
        lastState: () => states.at(-1)?.state,
        async elapse(milliseconds) {
            clock += milliseconds;
            for (let turn = 0; turn < 20; turn++) {
                const due = [...timers].filter(([, timer]) => timer.deadline <= clock);
                if (!due.length) return;
                for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
                await settle();
            }
            assert.fail('autosave timer did not settle');
        },
        async succeed(index) {
            assert.ok(requests[index], `save ${index + 1} must have started`);
            requests[index].resolve();
            await settle();
        },
        async fail(index, error = new Error('Connection lost')) {
            assert.ok(requests[index], `save ${index + 1} must have started`);
            requests[index].reject(error);
            await settle();
        },
    };
}

test('unchanged text is already saved and does not generate writes', async t => {
    const h = setup(t);
    assert.equal(h.autosave.isDirty(), false);
    h.autosave.changed();
    await h.elapse(1_000);
    assert.equal(await h.autosave.flush(), true);
    assert.equal(h.requests.length, 0);
});

test('restored unsaved text is not announced as saved during initialization', t => {
    const states = [];
    const autosave = createAutosave({
        initialContent: original,
        readContent: () => laterEdit,
        save: async () => {},
        onState: update => states.push(update.state),
    });
    t.after(() => autosave.destroy());
    assert.equal(autosave.isDirty(), true);
    assert.equal(states.includes('saved'), false, 'a false saved event could clear the recovered local draft');
    assert.equal(states.at(-1), 'pending');
});

test('debounce saves the latest exact text after typing pauses', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    assert.equal(h.autosave.isDirty(), true);
    assert.equal(h.lastState(), 'pending');
    await h.elapse(99);
    assert.equal(h.requests.length, 0);
    h.edit(laterEdit);
    await h.elapse(99);
    assert.equal(h.requests.length, 0);
    await h.elapse(1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].snapshot, laterEdit);
    assert.equal(h.lastState(), 'saving');
    assert.equal(h.autosave.isDirty(), true);
    await h.succeed(0);
    assert.equal(h.autosave.isDirty(), false);
    assert.equal(h.lastState(), 'saved');
});

test('flush skips the debounce and waits until the request is confirmed', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    let completed = false;
    const result = h.autosave.flush().then(value => { completed = true; return value; });
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].snapshot, firstEdit);
    assert.equal(completed, false);
    await h.elapse(1_000);
    assert.equal(h.requests.length, 1, 'the cancelled debounce cannot start a second request');
    await h.succeed(0);
    assert.equal(await result, true);
    assert.equal(h.autosave.isDirty(), false);
});

test('edits made during a save are serialized and included before flush finishes', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    let completed = false;
    const result = h.autosave.flush().then(value => { completed = true; return value; });
    await settle();
    h.edit(laterEdit);
    await h.elapse(1_000);
    assert.equal(h.requests.length, 1, 'the first request must finish before another write starts');
    assert.equal(h.requests[0].snapshot, firstEdit, 'later typing cannot mutate an in-flight snapshot');
    await h.succeed(0);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].snapshot, laterEdit);
    assert.equal(h.autosave.isDirty(), true);
    assert.equal(h.lastState(), 'saving');
    assert.equal(completed, false, 'navigation must wait for text entered during the first save');
    await h.succeed(1);
    assert.equal(await result, true);
    assert.equal(h.autosave.isDirty(), false);
    assert.equal(h.lastState(), 'saved');
});

test('multiple flush callers share one write and wait for the same confirmed text', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    const first = h.autosave.flush();
    const second = h.autosave.flush();
    await settle();
    assert.equal(h.requests.length, 1);
    await h.succeed(0);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(h.autosave.isDirty(), false);
});

test('a failure keeps the latest text dirty and retry saves that current text', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    const result = h.autosave.flush();
    await settle();
    h.edit(laterEdit);
    await h.fail(0);
    assert.equal(await result, false);
    assert.equal(h.autosave.isDirty(), true);
    assert.equal(h.lastState(), 'error');
    assert.ok(h.states.at(-1).error, 'the UI must receive the save failure');
    const retry = h.autosave.retry();
    await settle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].snapshot, laterEdit);
    await h.succeed(1);
    assert.equal(await retry, true);
    assert.equal(h.autosave.isDirty(), false);
    assert.equal(h.lastState(), 'saved');
});

test('reverting after an unconfirmed write still resends the original before claiming saved', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    const first = h.autosave.flush();
    await settle();
    // The server may already hold firstEdit even though its response was lost.
    await h.fail(0, new TypeError('The save response was lost'));
    assert.equal(await first, false);
    h.edit(original);
    assert.equal(h.autosave.isDirty(), true, 'the last acknowledged baseline may no longer match the server');
    assert.notEqual(h.lastState(), 'saved');
    const retry = h.autosave.flush();
    await settle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].snapshot, original);
    assert.equal(h.autosave.isDirty(), true);
    await h.succeed(1);
    assert.equal(await retry, true);
    assert.equal(h.autosave.isDirty(), false);
    assert.equal(h.lastState(), 'saved');
});

test('undoing to the original while an older edit is saving queues the reversal', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    const result = h.autosave.flush();
    await settle();
    h.edit(original);
    assert.equal(h.autosave.isDirty(), true, 'the in-flight edit can still overwrite the original on the server');
    await h.succeed(0);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].snapshot, original);
    assert.equal(h.autosave.isDirty(), true);
    await h.succeed(1);
    assert.equal(await result, true);
    assert.equal(h.autosave.isDirty(), false);
});

test('undoing a pending edit before its debounce needs no write', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    h.edit(original);
    await h.elapse(1_000);
    assert.equal(h.requests.length, 0);
    assert.equal(h.autosave.isDirty(), false);
    assert.equal(await h.autosave.flush(), true);
});

test('clearing the note saves the empty string as an intentional edit', async t => {
    const h = setup(t);
    h.edit('');
    const result = h.autosave.flush();
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].snapshot, '');
    await h.succeed(0);
    assert.equal(await result, true);
    assert.equal(h.autosave.isDirty(), false);
});

test('destroy cancels a pending debounce without writing data', async t => {
    const h = setup(t);
    h.edit(firstEdit);
    h.autosave.destroy();
    await h.elapse(1_000);
    assert.equal(h.requests.length, 0);
});
