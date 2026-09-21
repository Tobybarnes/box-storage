import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import MarkdownIt from 'markdown-it';
import { composeNote, editorExtensions } from '../static/richtext.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver']) {
    Object.defineProperty(globalThis, key, {value: dom.window[key], configurable: true});
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const renderMarkdown = new MarkdownIt({html:false, breaks:true});

function createEditor(html) {
    return new Editor({element: document.createElement('div'), extensions: editorExtensions(), content: html, contentType: 'html'});
}
const original = {
    source: '# box-001 Photos  \r\n\r\n## Contents\r\n\r\n-old prints\r\nslides',
    head: '# box-001 Photos  \r\n', title: 'Photos', titlePrefix: '# box-001 ',
    titleSuffix: '  \r\n', newline: '\r\n', body: '\r\n## Contents\r\n\r\n-old prints\r\nslides',
};
test('an unchanged editor returns exact original source, not serialized output', () => {
    assert.equal(composeNote(original, 'Photos', false, 'anything'), original.source);
});
test('a title-only edit leaves every body byte and title prefix untouched', () => {
    assert.equal(composeNote(original, 'Letters', false, 'ignored'), '# box-001 Letters  \r\n' + original.body);
});
test('a body-only edit keeps the complete original title and line-ending style', () => {
    assert.equal(composeNote(original, 'Photos', true, '## Contents\n\n- Albums'), original.head + '\r\n## Contents\r\n\r\n- Albums');
});
test('plain title punctuation remains literal Markdown text', () => {
    assert.equal(composeNote(original, '<Photos> **2026**', false, ''), '# box-001 \\<Photos\\> \\*\\*2026\\*\\*  \r\n' + original.body);
});
test('entity-shaped text in a plain title stays literal', () => {
    const markdown = composeNote(original, 'Photos &copy; & notes', false, '');
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown.render(markdown);
    assert.equal(container.querySelector('h1').textContent, 'box-001 Photos &copy; & notes');
});
test('rich edits, undo and Markdown serialization preserve empty bullets and line breaks', () => {
    const editor = createEditor('<h2>Contents</h2>\n<p>-old prints<br>slides &amp; letters</p>\n<ul><li></li><li>Photos</li></ul>');
    const before = editor.getJSON();
    editor.commands.insertContentAt(editor.state.doc.content.size, {type: 'paragraph', content: [{type:'text', text:'Added note'}]});
    assert.notDeepEqual(editor.getJSON(), before);
    editor.commands.undo();
    assert.deepEqual(editor.getJSON(), before);
    const markdown = editor.getMarkdown();
    editor.commands.setContent(renderMarkdown.render(markdown), {contentType:'html'});
    assert.deepEqual(editor.getJSON(), before);
    editor.destroy();
});

// Optional private fixtures are generated outside the repository. They are never
// needed for the portable suite and never copied into source control.
if (process.env.RICH_TEXT_FIXTURES) {
    const fixtures = JSON.parse(readFileSync(process.env.RICH_TEXT_FIXTURES, 'utf8'));
    const results = [];
    for (const fixture of fixtures) test(`existing note ${fixture.id} survives rich editing`, () => {
        const editor = createEditor(fixture.html);
        const initial = editor.getJSON();
        const originalOutput = composeNote(fixture, fixture.title, false, editor.getMarkdown());
        assert.equal(originalOutput, fixture.source);
        const titleOnly = composeNote(fixture, fixture.title + ' review', false, editor.getMarkdown());
        assert.ok(titleOnly.endsWith(fixture.body));
        const serialized = editor.getMarkdown();
        editor.commands.setContent(renderMarkdown.render(serialized), {contentType:'html'});
        assert.deepEqual(editor.getJSON(), initial, 'Markdown round-trip changed the document');
        editor.commands.insertContentAt(editor.state.doc.content.size, {type:'paragraph', content:[{type:'text', text:'Verification note'}]});
        const changedDocument = editor.getJSON();
        const changed = composeNote(fixture, fixture.title, true, editor.getMarkdown());
        results.push({id:fixture.id, originalOutput, titleOnly, changed, originalDocument:initial, changedDocument});
        editor.destroy();
        if (results.length === fixtures.length && process.env.RICH_TEXT_RESULTS) {
            writeFileSync(process.env.RICH_TEXT_RESULTS, JSON.stringify(results));
        }
    });
}

if (process.env.RICH_TEXT_REOPENED) {
    const fixtures = JSON.parse(readFileSync(process.env.RICH_TEXT_REOPENED, 'utf8'));
    for (const fixture of fixtures) test(`saved note ${fixture.id} reopens with its full edited document`, () => {
        const editor = createEditor(fixture.html);
        assert.deepEqual(JSON.parse(JSON.stringify(editor.getJSON())), fixture.expected);
        editor.destroy();
    });
}
