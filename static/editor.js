import { Editor } from '@tiptap/core';
import { composeNote, editorExtensions } from './richtext.js';
import { createAutosave } from './autosave.js';

const form = document.getElementById('editor-form');
if (form) initialiseEditor(form);

function initialiseEditor(form) {
    const source = document.getElementById('content');
    const fallback = document.getElementById('source-fallback');
    const visual = document.getElementById('visual-editor');
    const title = document.getElementById('box-title');
    const saveButton = document.getElementById('save-button');
    const status = document.getElementById('editor-status');
    const saveError = document.getElementById('save-error');
    const retry = document.getElementById('retry-save');
    const conflict = document.getElementById('save-conflict');
    let conflictRevision;
    const server = JSON.parse(document.getElementById('editor-data').textContent);
    const isNew = form.querySelector('[name="is_new"]')?.value === '1';
    const buttons = [...form.querySelectorAll('[data-command]')];
    const draftKey = 'box-storage:draft:' + new URL(form.action).pathname + (isNew ? ':new' : '');
    let config = server;
    let revision = server.revision;
    let editor;
    let initialDocument;
    let autosave;
    let creating = false;
    let leaving = false;
    let composing = false;
    let storageAvailable = true;
    let draft;
    try {
        draft = JSON.parse(localStorage.getItem(draftKey));
        if (draft?.content === server.source) { localStorage.removeItem(draftKey); draft = null; }
        if (draft && (typeof draft.content !== 'string' || !draft.config || typeof draft.config.source !== 'string')) draft = null;
        if (draft) { config = draft.config; revision = draft.revision; }
    } catch { draft = null; storageAvailable = false; }

    function bodyChanged() { return JSON.stringify(editor.getJSON()) !== initialDocument; }
    function readContent() {
        if (!editor) return source.value;
        const changed = bodyChanged();
        return composeNote(config, title.value, changed, changed ? editor.getMarkdown() : '');
    }
    function keepDraft(clear = false) {
        try {
            if (clear) localStorage.removeItem(draftKey);
            else localStorage.setItem(draftKey, JSON.stringify({
                content: readContent(), revision, config, title: title.value,
                document: editor?.getJSON(), initialDocument,
            }));
        } catch { storageAvailable = false; }
    }
    function showError(error) {
        saveError.hidden = false;
        saveError.textContent = error.message || 'Could not save. Keep this page open and try again.';
        if (!storageAvailable) saveError.textContent += ' Keep this page open until it saves.';
        retry.hidden = conflictRevision !== undefined;
    }
    function updateToolbar() {
        if (!editor) return;
        for (const button of buttons) {
            const command = button.dataset.command;
            if (command === 'undo' || command === 'redo') button.disabled = !editor.can()[command]();
            else button.setAttribute('aria-pressed', String(command === 'heading' ? editor.isActive('heading', {level: 2}) : editor.isActive(command)));
        }
    }
    function changed() {
        updateToolbar();
        keepDraft();
        if (!isNew && !composing) autosave?.changed();
        else if (isNew) status.textContent = storageAvailable ? 'Draft kept on this device. Create the box when ready.' : 'Create the box when ready.';
    }
    try {
        editor = new Editor({
            element: document.getElementById('rich-body'), extensions: editorExtensions(),
            content: config.html, contentType: 'html', enableInputRules: false, enablePasteRules: false,
            editorProps: {attributes: {
                role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': 'notes-label',
                'aria-describedby': 'editor-status', spellcheck: 'true', autocapitalize: 'sentences',
                class: 'rich-document markdown-content',
            }},
        });
        const rendered = document.createElement('div');
        rendered.innerHTML = config.html;
        const compact = text => text.replace(/\s/g, '');
        if (compact(rendered.textContent) !== compact(editor.getText())) throw new Error('Incomplete document');
        initialDocument = JSON.stringify(editor.getJSON());
        if (draft) {
            if (!draft.document || typeof draft.initialDocument !== 'string') throw new Error('Source draft');
            initialDocument = draft.initialDocument;
            editor.commands.setContent(draft.document, {emitUpdate: false});
            title.value = draft.title;
        }
        fallback.hidden = true;
        visual.hidden = false;
        editor.on('update', changed);
        editor.on('selectionUpdate', updateToolbar);
        title.addEventListener('input', changed);
        updateToolbar();
    } catch {
        if (editor) editor.destroy();
        editor = null;
        if (draft) source.value = draft.content;
    }
    source.addEventListener('input', changed);
    form.addEventListener('compositionstart', () => {composing = true;});
    form.addEventListener('compositionend', () => {composing = false; changed();});
    buttons.forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => {
            if (!editor) return;
            const command = button.dataset.command;
            const chain = editor.chain().focus();
            if (command === 'heading') chain.toggleHeading({level: 2}).run();
            if (command === 'bulletList') chain.toggleBulletList().run();
            if (command === 'bold') chain.toggleBold().run();
            if (command === 'undo') chain.undo().run();
            if (command === 'redo') chain.redo().run();
            updateToolbar();
        });
    });
    async function post(content) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(form.action, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({content, expected_revision: revision, is_new: isNew ? '1' : '0'}),
                signal: controller.signal,
            });
            const result = await response.json();
            if (!response.ok) {
                if (isNew && result.recovery_url) {
                    form.action = result.recovery_url;
                    document.querySelector('.box-reference').textContent = 'Box ' + result.box_number;
                }
                if (!isNew && response.status === 409 && typeof result.content === 'string' && typeof result.revision === 'string') {
                    conflictRevision = result.revision;
                    conflict.hidden = false;
                    document.getElementById('saved-conflict-text').textContent = result.content;
                    throw new Error('This box changed elsewhere. Your draft is still in the editor. Review the saved text and choose which to keep.');
                }
                throw new Error(result.error || 'Could not save. Your draft is still here; try again.');
            }
            if (typeof result.revision !== 'string' || typeof result.content !== 'string' || !result.redirect) throw new Error('The save could not be confirmed. Your draft is still here; try again.');
            revision = result.revision;
            conflictRevision = undefined;
            conflict.hidden = true;
            keepDraft();
            return result;
        } catch (error) {
            if (error instanceof TypeError || error.name === 'AbortError' || error instanceof SyntaxError) {
                throw new Error('Could not connect to save. Your draft is kept here; retry when connected.');
            }
            throw error;
        } finally { clearTimeout(timeout); }
    }
    if (!isNew) {
        saveButton.hidden = true;
        autosave = createAutosave({readContent, initialContent: editor ? server.source : server.source.replace(/\r\n?/g, '\n'), save: post,
            onState({state, error}) {
                status.textContent = {saved: 'Saved', pending: 'Waiting to save…', saving: 'Saving…', error: 'Not saved yet'}[state];
                form.setAttribute('aria-busy', String(state === 'saving'));
                saveError.hidden = true;
                retry.hidden = true;
                if (state === 'saved') keepDraft(true);
                if (state === 'error') {keepDraft(); showError(error);}
            },
        });
        // A recovered draft must remain dirty until its exact text is acknowledged.
        if (draft) {keepDraft(); autosave.changed();}
    } else status.textContent = draft ? 'Draft restored. Create the box when ready.' : 'Add a title and notes, then create this box.';
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!isNew) {await autosave.flush(); return;}
        if (creating) return;
        creating = true;
        saveButton.disabled = true;
        title.disabled = source.disabled = true;
        editor?.setEditable(false);
        buttons.forEach(button => {button.disabled = true;});
        status.textContent = 'Creating box…';
        saveError.hidden = true;
        try {
            const result = await post(readContent());
            keepDraft(true);
            leaving = true;
            window.location.assign(result.redirect);
        } catch (error) {showError(error); status.textContent = 'Box not created yet';}
        finally {
            creating = false; saveButton.disabled = false;
            title.disabled = source.disabled = false;
            editor?.setEditable(true);
            buttons.forEach(button => {button.disabled = false;});
            updateToolbar();
        }
    });
    document.getElementById('keep-my-text').addEventListener('click', () => {
        if (conflictRevision === undefined) return;
        revision = conflictRevision;
        conflictRevision = undefined;
        conflict.hidden = true;
        keepDraft();
        autosave.retry();
    });
    document.getElementById('use-saved-text').addEventListener('click', () => {
        keepDraft(true);
        leaving = true;
        window.location.reload();
    });
    retry.addEventListener('click', () => isNew ? form.requestSubmit() : autosave.retry());
    // Same-tab navigation waits for confirmation, including any last keystroke.
    document.addEventListener('click', async event => {
        const link = event.target.closest('a[href]');
        if (isNew || leaving || !link || link.target === '_blank' || link.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const destination = new URL(link.href);
        if (destination.pathname === window.location.pathname && destination.hash) return;
        if (!autosave.isDirty()) return;
        event.preventDefault();
        if (await autosave.flush()) {leaving = true; window.location.assign(destination.href);}
    });
    window.addEventListener('beforeunload', event => {
        if (leaving) return;
        const dirty = isNew ? readContent() !== server.source : autosave.isDirty();
        if (dirty) {keepDraft(); event.preventDefault(); event.returnValue = '';}
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && !isNew && autosave.isDirty()) {keepDraft(); autosave.flush();}
    });
    window.addEventListener('online', () => {if (!isNew) autosave.retry();});
    window.addEventListener('pageshow', () => {leaving = false; if (!isNew && autosave.isDirty()) autosave.retry();});
    document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {event.preventDefault(); form.requestSubmit();}
    });
}
