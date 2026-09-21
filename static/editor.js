import { Editor } from '@tiptap/core';
import { composeNote, editorExtensions } from './richtext.js';

const form = document.getElementById('editor-form');
if (form) initialiseEditor(form);

function initialiseEditor(form) {
    const source = document.getElementById('content');
    const fallback = document.getElementById('source-fallback');
    const visual = document.getElementById('visual-editor');
    const title = document.getElementById('box-title');
    const save = document.getElementById('save-button');
    const saveLabel = save.textContent;
    const status = document.getElementById('editor-status');
    const saveError = document.getElementById('save-error');
    const config = JSON.parse(document.getElementById('editor-data').textContent);
    const buttons = [...form.querySelectorAll('[data-command]')];
    let submitting = false;
    let editor;
    let initialDocument;

    function bodyChanged() { return JSON.stringify(editor.getJSON()) !== initialDocument; }
    function dirty() {
        return editor ? title.value !== config.title || bodyChanged() : source.value !== config.source.replace(/\r\n?/g, '\n');
    }
    function updateToolbar() {
        if (!editor) return;
        for (const button of buttons) {
            const command = button.dataset.command;
            if (command === 'undo' || command === 'redo') button.disabled = !editor.can()[command]();
            else {
                const active = command === 'heading' ? editor.isActive('heading', { level: 2 }) : editor.isActive(command);
                button.setAttribute('aria-pressed', String(active));
            }
        }
        const message = dirty() ? 'Unsaved changes' : 'Changes saved only when you choose Save.';
        if (status.textContent !== message) status.textContent = message;
    }
    try {
        editor = new Editor({
            element: document.getElementById('rich-body'), extensions: editorExtensions(),
            content: config.html, contentType: 'html', enableInputRules: false, enablePasteRules: false,
            editorProps: { attributes: {
                role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': 'notes-label',
                'aria-describedby': 'editor-status', spellcheck: 'true', autocapitalize: 'sentences',
                class: 'rich-document markdown-content',
            } },
        });
        // Leave original source available if the schema would discard any text.
        const rendered = document.createElement('div');
        rendered.innerHTML = config.html;
        const compact = text => text.replace(/\s/g, '');
        if (compact(rendered.textContent) !== compact(editor.getText())) throw new Error('Incomplete document');
        initialDocument = JSON.stringify(editor.getJSON());
        fallback.hidden = true;
        visual.hidden = false;
        editor.on('update', updateToolbar);
        editor.on('selectionUpdate', updateToolbar);
        title.addEventListener('input', updateToolbar);
        updateToolbar();
    } catch (error) {
        if (editor) editor.destroy();
        editor = null;
        status.textContent = 'The visual editor could not load. Your original notes are available below.';
    }
    buttons.forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => {
            if (!editor) return;
            const command = button.dataset.command;
            const chain = editor.chain().focus();
            if (command === 'heading') chain.toggleHeading({ level: 2 }).run();
            if (command === 'bulletList') chain.toggleBulletList().run();
            if (command === 'bold') chain.toggleBold().run();
            if (command === 'undo') chain.undo().run();
            if (command === 'redo') chain.redo().run();
            updateToolbar();
        });
    });
    form.addEventListener('submit', async event => {
        if (submitting) { event.preventDefault(); return; }
        if (!editor) return;
        event.preventDefault();
        let content;
        try {
            const changed = bodyChanged();
            content = composeNote(config, title.value, changed, changed ? editor.getMarkdown() : '');
        } catch (error) {
            saveError.hidden = false;
            saveError.textContent = 'Your changes could not be prepared for saving. Your text is still here; please keep this page open.';
            return;
        }
        submitting = true;
        save.disabled = true;
        save.textContent = 'Saving…';
        form.setAttribute('aria-busy', 'true');
        saveError.hidden = true;
        try {
            // JSON preserves exact source newlines. Native textarea form posting
            // would normalize the untouched body when only its title changes.
            const response = await fetch(form.action, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({content, is_new: form.querySelector('[name="is_new"]')?.value || '0'}),
            });
            const result = await response.json();
            if (!response.ok) {
                if (result.recovery_url) {
                    form.action = result.recovery_url;
                    document.querySelector('.box-reference').textContent = 'Box ' + result.box_number;
                }
                throw new Error(result.error || 'The save did not complete. Your text is still here; try saving again.');
            }
            window.location.assign(result.redirect);
        } catch (error) {
            saveError.hidden = false;
            saveError.textContent = error instanceof TypeError ? 'Could not connect to save. Your text is still here; try saving again.' : error.message;
            submitting = false;
            save.disabled = false;
            save.textContent = saveLabel;
            form.removeAttribute('aria-busy');
        }
    });
    window.addEventListener('beforeunload', event => {
        if (!submitting && dirty()) { event.preventDefault(); event.returnValue = ''; }
    });
    document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault(); form.requestSubmit();
        }
    });
    window.addEventListener('pageshow', () => {
        submitting = false; save.disabled = false; save.textContent = saveLabel;
        form.removeAttribute('aria-busy');
    });
}
