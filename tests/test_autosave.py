"""Automatic text saves must preserve source bytes and reject stale edits."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from threading import Barrier

import pytest
from flask import template_rendered

from test_box_storage import ORIGINAL_MARKDOWN, snapshot, storage


def revision(source):
    return sha256(source if isinstance(source, bytes) else source.encode('utf-8')).hexdigest()


def editor_context(module, client, path):
    contexts = []
    def capture(sender, template, context, **extra):
        contexts.append(context)
    with template_rendered.connected_to(capture, module.app):
        assert client.get(path).status_code == 200
    return contexts[-1]


def test_editor_exposes_exact_source_revision_but_new_draft_has_none(storage):
    module, client, data_dir = storage
    source = '\ufeff# Box 001 — Emily’s photos\r\n\r\nKeep these spaces.  \r\n'
    (data_dir / 'boxes' / 'box-001.md').write_bytes(source.encode('utf-8'))
    before = snapshot(data_dir)
    existing = editor_context(module, client, '/box/box-001/edit')['editor']
    assert existing['revision'] == revision(source)
    assert existing['source'] == source
    new = editor_context(module, client, '/box/box-002/edit?new=1')['editor']
    assert new['revision'] is None
    assert snapshot(data_dir) == before
    assert sorted(path.name for path in data_dir.iterdir()) == ['boxes', 'photos']


def test_autosave_returns_the_persisted_source_revision_and_editor_identity(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    edited = '# Family photos\r\n\r\n- Albums\r\n- Emily’s letters  \r\n'
    response = client.post('/box/box-001/edit', json={
        'content': edited, 'expected_revision': revision(ORIGINAL_MARKDOWN),
    })
    assert response.status_code == 200
    assert response.get_json() == {
        'redirect': '/box/box-001', 'edit_url': '/box/box-001/edit',
        'box_id': 'box-001', 'box_number': '001', 'revision': revision(edited), 'content': edited,
    }
    assert (data_dir / 'boxes' / 'box-001.md').read_bytes() == edited.encode('utf-8')
    after = snapshot(data_dir)
    for name in before:
        if name != 'boxes/box-001.md':
            assert after[name] == before[name]


def test_stale_autosave_does_not_replace_a_newer_note(storage):
    _, client, data_dir = storage
    current = '# Emily’s update\n\n- Family photos\n'
    (data_dir / 'boxes' / 'box-001.md').write_bytes(current.encode('utf-8'))
    before = snapshot(data_dir)
    response = client.post('/box/box-001/edit', json={
        'content': '# Old editor\n\n- Letters', 'expected_revision': revision(ORIGINAL_MARKDOWN),
    })
    assert response.status_code == 409
    assert response.is_json and response.get_json()['error']
    assert response.get_json()['content'] == current
    assert response.get_json()['revision'] == revision(current)
    assert snapshot(data_dir) == before


def test_retry_after_a_lost_save_response_is_successful_without_rewriting(storage):
    _, client, data_dir = storage
    edited = '# Albums\n\n- Family photographs\n'
    payload = {'content': edited, 'expected_revision': revision(ORIGINAL_MARKDOWN)}
    first = client.post('/box/box-001/edit', json=payload)
    assert first.status_code == 200
    before_retry = snapshot(data_dir)
    repeated = client.post('/box/box-001/edit', json=payload)
    assert repeated.status_code == 200
    assert repeated.get_json()['revision'] == revision(edited)
    assert repeated.get_json()['content'] == edited
    assert snapshot(data_dir) == before_retry


def test_noop_normalizes_only_for_comparison_and_returns_original_bytes(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    submitted = ORIGINAL_MARKDOWN.decode('utf-8').replace('\r\n', '\n')
    response = client.post('/box/box-001/edit', json={
        'content': submitted, 'expected_revision': '0' * 64,
    })
    assert response.status_code == 200
    assert response.get_json()['revision'] == revision(ORIGINAL_MARKDOWN)
    assert response.get_json()['content'].encode('utf-8') == ORIGINAL_MARKDOWN
    assert snapshot(data_dir) == before


def test_simultaneous_autosaves_cannot_both_replace_the_same_revision(storage):
    module, _, data_dir = storage
    barrier = Barrier(2)
    def save(title):
        with module.app.test_client() as client:
            barrier.wait()
            response = client.post('/box/box-001/edit', json={
                'content': f'# {title}\n', 'expected_revision': revision(ORIGINAL_MARKDOWN),
            })
            return title, response
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ['Photos', 'Letters']))
    assert sorted(response.status_code for _, response in results) == [200, 409]
    winner = next(title for title, response in results if response.status_code == 200)
    assert (data_dir / 'boxes' / 'box-001.md').read_bytes() == f'# {winner}\n'.encode()


def test_failed_atomic_autosave_is_a_visible_error_and_keeps_original(storage, monkeypatch):
    module, client, data_dir = storage
    before = snapshot(data_dir)
    real_replace = module.os.replace
    def disk_failure(source, destination):
        if Path(destination).suffix == '.md':
            raise OSError('simulated note commit failure')
        return real_replace(source, destination)
    monkeypatch.setattr(module.os, 'replace', disk_failure)
    response = client.post('/box/box-001/edit', json={
        'content': '# An edit that cannot be saved\n', 'expected_revision': revision(ORIGINAL_MARKDOWN),
    })
    assert response.status_code == 500
    assert response.is_json and response.get_json()['error']
    assert 'revision' not in response.get_json()
    assert snapshot(data_dir) == before


def test_new_autosave_creates_one_box_and_returns_a_normal_editor_url(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    source = '# Winter clothes\n\n- Coats\n'
    response = client.post('/box/box-002/edit?new=1', json={
        'is_new': '1', 'content': source, 'expected_revision': None,
    })
    assert response.status_code == 200
    assert response.get_json() == {
        'redirect': '/box/box-002', 'edit_url': '/box/box-002/edit',
        'box_id': 'box-002', 'box_number': '002', 'revision': revision(source), 'content': source,
    }
    after = snapshot(data_dir)
    assert after.keys() == before.keys() | {'boxes/box-002.md'}
    for name in before:
        assert after[name] == before[name]


def test_new_box_collision_keeps_draft_recovery_semantics(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post('/box/box-001/edit?new=1', json={
        'is_new': '1', 'content': '# A separate new box\n', 'expected_revision': None,
    })
    assert response.status_code == 409
    assert response.get_json()['recovery_url'] == '/box/box-002/edit?new=1'
    assert snapshot(data_dir) == before


def test_deleted_existing_note_is_not_recreated_by_autosave(storage):
    _, client, data_dir = storage
    (data_dir / 'boxes' / 'box-001.md').unlink()
    before = snapshot(data_dir)
    response = client.post('/box/box-001/edit', json={
        'content': '# A stale editor\n', 'expected_revision': revision(ORIGINAL_MARKDOWN),
    })
    assert response.status_code == 404
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('expected', [True, 1, [], {}, '', 'bad-revision', 'a' * 63])
def test_invalid_expected_revision_is_rejected_without_saving(storage, expected):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post('/box/box-001/edit', json={'content': '# Rejected\n', 'expected_revision': expected})
    assert response.status_code == 400
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before


def test_legacy_json_clients_can_still_save_without_a_revision(storage):
    _, client, data_dir = storage
    source = '# Legacy editor\n\n- Photos\n'
    response = client.post('/box/box-001/edit', json={'content': source})
    assert response.status_code == 200
    assert response.get_json()['revision'] == revision(source)
    assert (data_dir / 'boxes' / 'box-001.md').read_bytes() == source.encode()


def test_autosave_cannot_recreate_a_box_deleted_during_its_atomic_write(storage, monkeypatch):
    from concurrent.futures import TimeoutError
    from threading import Event
    module, _, data_dir = storage
    save_ready = Event()
    release_save = Event()
    real_replace = module.os.replace
    def paused_commit(source, destination):
        if Path(destination).suffix == '.md':
            save_ready.set()
            assert release_save.wait(5)
        return real_replace(source, destination)
    monkeypatch.setattr(module.os, 'replace', paused_commit)
    def save():
        with module.app.test_client() as client:
            return client.post('/box/box-001/edit', json={
                'content': '# The last edit\n', 'expected_revision': revision(ORIGINAL_MARKDOWN),
            })
    def delete():
        with module.app.test_client() as client:
            return client.post('/box/box-001/delete')
    with ThreadPoolExecutor(max_workers=2) as pool:
        saving = pool.submit(save)
        assert save_ready.wait(5)
        deleting = pool.submit(delete)
        try:
            deleting.result(timeout=0.5)
        except TimeoutError:
            pass
        finally:
            release_save.set()
        assert saving.result(timeout=5).status_code == 200
        assert deleting.result(timeout=5).status_code == 302
    assert not (data_dir / 'boxes' / 'box-001.md').exists()
