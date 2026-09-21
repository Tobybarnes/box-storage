"""Saved rotation must never alter an original image or a box note."""

import importlib.util
import io
from pathlib import Path

import pytest
from PIL import Image

from test_box_storage import APP_PATH, snapshot, storage


COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (255, 0, 255), (0, 255, 255)]


def asymmetric_photo(data_dir, filename='asymmetric.png', orientation=None):
    path = data_dir / 'photos' / 'box-001' / filename
    image = Image.new('RGB', (3, 2))
    image.putdata(COLORS)
    options = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[274] = orientation
        options['exif'] = exif
    image.save(path, format='PNG', **options)
    return path


def rotate(client, filename='asymmetric.png', rotation=1, expected=0):
    return client.post(
        f'/box/box-001/photos/{filename}/rotate',
        json={'rotation': rotation, 'expected_rotation': expected},
    )


def decoded(response):
    with Image.open(io.BytesIO(response.data)) as image:
        with image.convert('RGB') as pixels:
            return image.size, list(pixels.get_flattened_data())


def originals_snapshot(data_dir):
    return {name: value for name, value in snapshot(data_dir).items() if not name.startswith('photo-edits/')}


def test_saved_clockwise_rotation_is_lossless_and_survives_restart(storage):
    module, client, data_dir = storage
    original = asymmetric_photo(data_dir)
    before = originals_snapshot(data_dir)
    response = rotate(client)
    assert response.status_code == 200
    result = response.get_json()
    assert result['rotation'] == 1
    assert '?v=' in result['photo_url']
    rotated = client.get(result['photo_url'])
    assert rotated.mimetype == 'image/png'
    assert decoded(rotated) == ((2, 3), [COLORS[3], COLORS[0], COLORS[4], COLORS[1], COLORS[5], COLORS[2]])
    assert originals_snapshot(data_dir) == before
    assert list((data_dir / 'photo-edits' / 'box-001').glob('*.json'))
    spec = importlib.util.spec_from_file_location('rotation_restarted_app', APP_PATH)
    restarted = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(restarted)
    restarted.app.config['TESTING'] = True
    assert decoded(restarted.app.test_client().get(result['photo_url'])) == decoded(rotated)
    assert restarted.photo_src('box-001', original.name) == result['photo_url']


def test_repeated_absolute_rotations_start_from_original_and_reset_exact_bytes(storage):
    module, client, data_dir = storage
    asymmetric_photo(data_dir)
    before = originals_snapshot(data_dir)
    expected_pixels = {
        1: ((2, 3), [COLORS[3], COLORS[0], COLORS[4], COLORS[1], COLORS[5], COLORS[2]]),
        2: ((3, 2), [COLORS[5], COLORS[4], COLORS[3], COLORS[2], COLORS[1], COLORS[0]]),
        3: ((2, 3), [COLORS[2], COLORS[5], COLORS[1], COLORS[4], COLORS[0], COLORS[3]]),
    }
    previous = 0
    previous_url = None
    for rotation in (1, 3, 2, 1, 2, 3):
        result = rotate(client, rotation=rotation, expected=previous).get_json()
        assert result is not None
        assert decoded(client.get(result['photo_url'])) == expected_pixels[rotation]
        assert result['photo_url'] != previous_url
        previous, previous_url = rotation, result['photo_url']
        assert originals_snapshot(data_dir) == before
    reset = rotate(client, rotation=0, expected=3)
    assert reset.status_code == 200
    assert reset.get_json()['rotation'] == 0
    assert client.get(reset.get_json()['photo_url']).data == before['photos/box-001/asymmetric.png'][0]
    assert not list((data_dir / 'photo-edits' / 'box-001').glob('*.png'))
    assert originals_snapshot(data_dir) == before


def test_rotation_applies_after_original_exif_orientation(storage):
    _, client, data_dir = storage
    asymmetric_photo(data_dir, orientation=6)
    before = originals_snapshot(data_dir)
    result = rotate(client).get_json()
    assert result is not None
    # EXIF6 turns right once; the saved right turn therefore produces 180 degrees.
    assert decoded(client.get(result['photo_url'])) == ((3, 2), list(reversed(COLORS)))
    assert originals_snapshot(data_dir) == before


def test_noop_and_read_only_visits_do_not_create_edit_storage(storage):
    module, client, data_dir = storage
    asymmetric_photo(data_dir)
    before = snapshot(data_dir)
    assert module.photo_src('box-001', 'asymmetric.png') == '/box/box-001/photos/asymmetric.png'
    assert module.photo_src('box-001', 'asymmetric.png', thumbnail=True).endswith('?thumbnail=1')
    for url in ('/', '/box/box-001', '/box/box-001/photos/asymmetric.png', '/box/box-001/photos/asymmetric.png/view'):
        assert client.get(url).status_code == 200
    response = rotate(client, rotation=0, expected=0)
    assert response.status_code == 200
    assert snapshot(data_dir) == before
    assert not (data_dir / 'photo-edits').exists()


def test_saved_noop_does_not_rewrite_state_or_image(storage):
    _, client, data_dir = storage
    asymmetric_photo(data_dir)
    first = rotate(client)
    assert first.status_code == 200
    before = snapshot(data_dir)
    repeated = rotate(client, rotation=1, expected=1)
    assert repeated.status_code == 200
    assert repeated.get_json() == first.get_json()
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('payload', [
    {}, {'rotation': 1}, {'rotation': True, 'expected_rotation': 0},
    {'rotation': 1.0, 'expected_rotation': 0}, {'rotation': -1, 'expected_rotation': 0},
    {'rotation': 4, 'expected_rotation': 0}, {'rotation': '1', 'expected_rotation': 0},
    {'rotation': 1, 'expected_rotation': False}, {'rotation': 1, 'expected_rotation': 8},
    {'rotation': float('nan'), 'expected_rotation': 0}, [], None,
])
def test_invalid_rotation_requests_are_json_errors_without_changes(storage, payload):
    _, client, data_dir = storage
    asymmetric_photo(data_dir)
    before = snapshot(data_dir)
    response = client.post('/box/box-001/photos/asymmetric.png/rotate', json=payload)
    assert response.status_code == 400
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before
    assert not (data_dir / 'photo-edits').exists()


def test_stale_rotation_does_not_overwrite_saved_orientation(storage):
    _, client, data_dir = storage
    asymmetric_photo(data_dir)
    saved = rotate(client)
    assert saved.status_code == 200
    before = snapshot(data_dir)
    stale = rotate(client, rotation=2, expected=0)
    assert stale.status_code == 409
    assert stale.is_json and stale.get_json()['error']
    assert stale.get_json()['rotation'] == 1
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('url', [
    '/box/box-999/photos/asymmetric.png/rotate',
    '/box/box-001/photos/missing.png/rotate',
    '/box/box-001/photos/..%5Coutside.png/rotate',
])
def test_missing_or_unsafe_targets_return_json_without_files(storage, url):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post(url, json={'rotation': 1, 'expected_rotation': 0})
    assert response.status_code == 404
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('kind', ['broken', 'gif', 'webp'])
def test_broken_and_animated_images_are_rejected_without_flattening(storage, kind):
    _, client, data_dir = storage
    path = data_dir / 'photos' / 'box-001' / ('broken.jpg' if kind == 'broken' else f'moving.{kind}')
    if kind == 'broken':
        path.write_bytes(b'not a valid photograph')
    else:
        first = Image.new('RGB', (3, 2), 'red')
        second = Image.new('RGB', (3, 2), 'blue')
        first.save(path, save_all=True, append_images=[second], duration=100, loop=0)
    before = snapshot(data_dir)
    response = rotate(client, filename=path.name)
    assert response.status_code == 422
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('failure', ['image_write', 'state_commit'])
def test_failed_save_preserves_previous_rotation_and_all_originals(storage, monkeypatch, failure):
    module, client, data_dir = storage
    asymmetric_photo(data_dir)
    saved = rotate(client)
    assert saved.status_code == 200
    before = snapshot(data_dir)
    if failure == 'image_write':
        def fail_save(self, fp, *args, **kwargs):
            raise OSError('simulated full disk')
        monkeypatch.setattr(Image.Image, 'save', fail_save)
    else:
        real_replace = module.os.replace
        def fail_state_replace(source, destination):
            if Path(destination).suffix == '.json':
                raise OSError('simulated state commit failure')
            return real_replace(source, destination)
        monkeypatch.setattr(module.os, 'replace', fail_state_replace)
    response = rotate(client, rotation=2, expected=1)
    assert response.status_code == 500
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before
    assert decoded(client.get(saved.get_json()['photo_url'])) == ((2, 3), [COLORS[3], COLORS[0], COLORS[4], COLORS[1], COLORS[5], COLORS[2]])


def test_corrupt_state_is_not_overwritten(storage):
    _, client, data_dir = storage
    asymmetric_photo(data_dir)
    assert rotate(client).status_code == 200
    state_path = next((data_dir / 'photo-edits' / 'box-001').glob('*.json'))
    state_path.write_text('{not valid json')
    before = snapshot(data_dir)
    response = rotate(client, rotation=2, expected=1)
    assert response.status_code == 500
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('delete_box', [False, True])
def test_deletion_removes_saved_edits_only_for_deleted_target(storage, delete_box):
    _, client, data_dir = storage
    asymmetric_photo(data_dir)
    assert rotate(client).status_code == 200
    unrelated_photo = data_dir / 'photos' / 'box-001' / '20260130_120000.jpg'
    unrelated_bytes = unrelated_photo.read_bytes()
    url = '/box/box-001/delete' if delete_box else '/box/box-001/photos/asymmetric.png/delete'
    assert client.post(url).status_code == 302
    assert not list((data_dir / 'photo-edits').rglob('*.*'))
    if not delete_box:
        assert unrelated_photo.read_bytes() == unrelated_bytes
        assert (data_dir / 'boxes' / 'box-001.md').is_file()


def test_view_and_thumbnail_urls_use_the_saved_revision(storage):
    from flask import template_rendered
    module, client, data_dir = storage
    asymmetric_photo(data_dir, filename='0000.png')
    result = rotate(client, filename='0000.png').get_json()
    assert result is not None and 'photo_url' in result
    contexts = []
    def capture(sender, template, context, **extra):
        contexts.append(context)
    with template_rendered.connected_to(capture, module.app):
        assert client.get('/box/box-001/photos/0000.png/view').status_code == 200
    context = contexts[-1]
    assert context['photo_rotation'] == 1
    assert context['photo_url'] == result['photo_url']
    assert context['rotation_url'] == '/box/box-001/photos/0000.png/rotate'
    thumbnail_url = module.get_all_boxes()[0]['thumbnail_url']
    assert 'thumbnail=1' in thumbnail_url and '&v=' in thumbnail_url
    assert decoded(client.get(thumbnail_url))[0] == (2, 3)
    assert module.app.jinja_env.globals['photo_src']('box-001', '0000.png') == result['photo_url']


def test_simultaneous_saves_cannot_both_overwrite_the_same_expected_rotation(storage):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    module, _, data_dir = storage
    asymmetric_photo(data_dir)
    before = originals_snapshot(data_dir)
    barrier = Barrier(2)
    def submit(rotation):
        with module.app.test_client() as client:
            barrier.wait()
            return rotate(client, rotation=rotation).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(submit, (1, 2)))
    assert sorted(statuses) == [200, 409]
    assert originals_snapshot(data_dir) == before


def test_oversized_image_is_rejected_before_persistent_edits(storage):
    module, client, data_dir = storage
    asymmetric_photo(data_dir)
    module.app.config['MAX_PHOTO_ROTATION_PIXELS'] = 5
    before = snapshot(data_dir)
    response = rotate(client)
    assert response.status_code == 413
    assert response.is_json and response.get_json()['error']
    assert snapshot(data_dir) == before


def test_photo_read_remains_available_while_next_rotation_commits(storage, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from threading import Event
    module, client, data_dir = storage
    asymmetric_photo(data_dir)
    assert rotate(client).status_code == 200
    path_resolved = Event()
    release_reader = Event()
    writer_started = Event()
    original_resolve = module._saved_photo_path

    def pause_after_resolving(box_id, filename):
        path = original_resolve(box_id, filename)
        path_resolved.set()
        assert release_reader.wait(5)
        return path

    monkeypatch.setattr(module, '_saved_photo_path', pause_after_resolving)

    def read_photo():
        with module.app.test_client() as reader:
            return reader.get('/box/box-001/photos/asymmetric.png')

    def save_next_rotation():
        writer_started.set()
        with module.app.test_client() as writer:
            return rotate(writer, rotation=2, expected=1)

    with ThreadPoolExecutor(max_workers=2) as pool:
        reading = pool.submit(read_photo)
        assert path_resolved.wait(5)
        writing = pool.submit(save_next_rotation)
        assert writer_started.wait(5)
        try:
            # Without a shared read lock, this commit deletes the PNG whose path
            # the paused request resolved. With the lock it waits for that reader.
            writing.result(timeout=0.5)
        except TimeoutError:
            pass
        finally:
            release_reader.set()
        response = reading.result(timeout=5)
        assert response.status_code == 200
        assert decoded(response) == ((2, 3), [COLORS[3], COLORS[0], COLORS[4], COLORS[1], COLORS[5], COLORS[2]])
        assert writing.result(timeout=5).status_code == 200


def test_phone_mpo_rotates_primary_photo_without_discarding_auxiliary_original(storage):
    _, client, data_dir = storage
    path = data_dir / 'photos' / 'box-001' / 'phone.jpeg'
    primary = Image.new('RGB', (3, 2))
    primary.putdata(COLORS)
    auxiliary = Image.new('RGB', (3, 2), 'black')
    primary.save(path, format='MPO', save_all=True, append_images=[auxiliary], quality=100, subsampling=0)
    with Image.open(path) as source:
        assert source.format == 'MPO' and source.n_frames == 2
        source_pixels = list(source.convert('RGB').get_flattened_data())
    before = originals_snapshot(data_dir)
    response = rotate(client, filename=path.name)
    assert response.status_code == 200
    assert decoded(client.get(response.get_json()['photo_url'])) == (
        (2, 3), [source_pixels[3], source_pixels[0], source_pixels[4], source_pixels[1], source_pixels[5], source_pixels[2]],
    )
    assert originals_snapshot(data_dir) == before
    with Image.open(path) as original:
        assert original.n_frames == 2
