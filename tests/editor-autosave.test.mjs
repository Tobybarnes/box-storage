import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source = '# box-001 Photos  \r\n\r\n## Contents\r\n\r\n-old prints\r\nslides';
const revision = 'a'.repeat(64);
const config = {source, revision, title: 'Photos', head: '# box-001 Photos  \r\n', body: '\r\n## Contents\r\n\r\n-old prints\r\nslides', titlePrefix: '# box-001 ', titleSuffix: '  \r\n', newline: '\r\n', html: '<h2>Contents</h2><p>-old prints<br>slides</p>'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function openEditor(t, {draft, isNew = false, fetch} = {}) {
    const dom = new JSDOM(`<!doctype html><a class="back-link" href="/box/box-001">Back to box</a><p class="box-reference">Box 001</p><form id="editor-form" action="/box/box-001/edit"><input name="is_new" value="${isNew ? '1' : '0'}" type="hidden"><div id="visual-editor" hidden><input id="box-title" value="Photos"><div id="rich-body"></div></div><div id="source-fallback"><textarea id="content"></textarea></div><p id="editor-status" role="status"></p><div class="editor-actions"><button id="save-button" type="submit">Save changes</button><a id="editor-done" href="/box/box-001">Done</a><button id="retry-save" type="button" hidden>Retry</button><span id="save-note"></span></div><p id="save-error" hidden></p><div id="save-conflict" hidden><details><summary>Review saved text</summary><pre id="saved-conflict-text"></pre></details><button id="keep-my-text" type="button">Use my text</button><button id="use-saved-text" type="button">Use saved text</button></div></form><script type="application/json" id="editor-data"></script>`, {url:'https://box.test/box/box-001/edit', runScripts:'outside-only', pretendToBeVisual:true});
    const {window} = dom;
    window.document.getElementById('editor-data').textContent = JSON.stringify(config);
    window.document.getElementById('content').value = source;
    window.fetch = fetch || (() => { throw new Error('Unexpected fetch'); });
    if (draft) for (const [key,value] of Object.entries(draft)) window.localStorage.setItem(key,value);
    window.eval(readFileSync(new URL('../static/editor.bundle.js', import.meta.url), 'utf8'));
    t.after(() => window.close());
    return {window, document:window.document, changeTitle(value) { const input=window.document.getElementById('box-title');input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true})); }, storage() {return Object.fromEntries(Object.keys(window.localStorage).map(key=>[key,window.localStorage.getItem(key)]));}};
}
function response(content, rev='b'.repeat(64)) {return {ok:true,json:async()=>({redirect:'/box/box-001',edit_url:'/box/box-001/edit',box_id:'box-001',box_number:'001',content,revision:rev})};}

test('title edits autosave exact untouched body with its revision and keep the editor open', async t => {
    const calls=[];
    const page=openEditor(t,{fetch:async(url,options)=>{const payload=JSON.parse(options.body);calls.push(payload);return response(payload.content);}});
    await pause(30);
    assert.equal(calls.length,0);
    page.changeTitle('Letters');
    await pause(850);
    assert.equal(calls.length,1);
    assert.equal(calls[0].content,'# box-001 Letters  \r\n'+config.body);
    assert.equal(calls[0].expected_revision,revision);
    assert.equal(page.window.location.pathname,'/box/box-001/edit');
    assert.equal(page.document.getElementById('save-button').hidden,true);
    assert.match(page.document.getElementById('editor-status').textContent,/saved/i);
});

test('failed autosave retains the draft across reopening and retries on connection recovery', async t => {
    const page=openEditor(t,{fetch:async()=>{throw new TypeError('offline');}});
    page.changeTitle('Family albums');
    await pause(850);
    assert.match(page.document.getElementById('save-error').textContent,/connect|save|offline/i);
    const draft=page.storage();
    assert.ok(Object.keys(draft).length,'unsaved draft should survive a closed page');
    const calls=[];
    const restored=openEditor(t,{draft,fetch:async(url,options)=>{const payload=JSON.parse(options.body);calls.push(payload);return response(payload.content);}});
    assert.equal(restored.document.getElementById('box-title').value,'Family albums');
    restored.window.dispatchEvent(new restored.window.Event('online'));
    await pause(850);
    assert.equal(calls.length,1);
    assert.equal(calls[0].content,'# box-001 Family albums  \r\n'+config.body);
    assert.equal(Object.keys(restored.storage()).length,0);
});

test('a save response cannot drop edits typed while it was pending', async t => {
    let finish;
    const calls=[];
    const page=openEditor(t,{fetch:(url,options)=>{const payload=JSON.parse(options.body);calls.push(payload);return new Promise(resolve=>{finish=()=>resolve(response(payload.content));});}});
    page.changeTitle('First');
    await pause(850);
    assert.equal(calls.length,1);
    page.changeTitle('Latest');
    finish();
    await pause(850);
    assert.equal(calls.length,2);
    assert.equal(calls[1].expected_revision,'b'.repeat(64));
    assert.equal(calls[1].content,'# box-001 Latest  \r\n'+config.body);
    finish();
    await pause(30);
    assert.match(page.document.getElementById('editor-status').textContent,/saved/i);
});


test('new box creation prevents edits while the submitted draft is saving', async t => {
    let finish;
    const page=openEditor(t,{isNew:true,fetch:()=>new Promise(resolve=>{finish=()=>resolve({ok:false,json:async()=>({error:'Could not create'})});})});
    page.document.getElementById('editor-form').dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));
    assert.equal(page.document.getElementById('box-title').disabled,true);
    assert.equal(page.document.querySelector('[role="textbox"]').getAttribute('contenteditable'),'false');
    finish();
    await pause(30);
    assert.equal(page.document.getElementById('box-title').disabled,false);
    assert.equal(page.document.querySelector('[role="textbox"]').getAttribute('contenteditable'),'true');
});

test('conflicting text stays in the editor until the user deliberately chooses their draft', async t => {
    const calls=[];
    const latest='c'.repeat(64);
    const page=openEditor(t,{fetch:async(url,options)=>{
        const payload=JSON.parse(options.body);calls.push(payload);
        if(calls.length===1) return {ok:false,status:409,json:async()=>({error:'This box changed elsewhere.',content:'# Saved elsewhere\n\nAnother note',revision:latest})};
        return response(payload.content);
    }});
    page.changeTitle('My albums');
    await pause(850);
    assert.equal(page.document.getElementById('box-title').value,'My albums');
    assert.equal(page.document.getElementById('save-conflict').hidden,false);
    assert.match(page.document.getElementById('saved-conflict-text').textContent,/Another note/);
    assert.equal(calls.length,1);
    page.document.getElementById('keep-my-text').click();
    await pause(30);
    assert.equal(calls.length,2);
    assert.equal(calls[1].expected_revision,latest);
    assert.equal(calls[1].content,'# box-001 My albums  \r\n'+config.body);
    assert.equal(page.document.getElementById('save-conflict').hidden,true);
});


test('leaving before the debounce waits for the final text to be saved', async t => {
    const calls=[];
    const page=openEditor(t,{fetch:(url,options)=>{calls.push(JSON.parse(options.body));return new Promise(()=>{});}});
    page.changeTitle('Last keystroke');
    const click=new page.window.MouseEvent('click',{bubbles:true,cancelable:true,button:0});
    page.document.getElementById('editor-done').dispatchEvent(click);
    assert.equal(click.defaultPrevented,true);
    await pause(10);
    assert.equal(calls.length,1);
    assert.equal(calls[0].content,'# box-001 Last keystroke  \r\n'+config.body);
    assert.equal(page.window.location.pathname,'/box/box-001/edit');
});
