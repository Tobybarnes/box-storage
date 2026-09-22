"""Photo queue retries must add complete originals once, without changing data."""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import stat
from threading import Barrier

import pytest
from PIL import Image
from werkzeug.datastructures import FileStorage

from test_box_storage import APP_PATH, picture_bytes, snapshot, storage


UPLOAD_ID = 'ca50d48e771b4cffbf1dd21288213621'
HEADERS = {'Accept': 'application/json'}


def upload(client, content=None, *, upload_id=UPLOAD_ID, box='box-001', filename='phone.JPG'):
    data = {'photo': (io.BytesIO(content if content is not None else picture_bytes('red')), filename)}
    if upload_id is not None:
        data['upload_id'] = upload_id
    return client.post(f'/box/{box}/photos', data=data, headers=HEADERS)


def assert_originals_unchanged(data_dir, before):
    after = snapshot(data_dir)
    for path, original in before.items():
        assert after[path] == original
    assert not list((data_dir / 'photos').glob('.photo-upload-*'))


def test_upload_returns_working_urls_and_keeps_exact_camera_bytes(storage):
    module, client, data_dir = storage
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    with Image.new('RGB', (30, 20), 'orange') as image:
        image.save(buffer, format='JPEG', exif=exif)
    original = buffer.getvalue()
    before = snapshot(data_dir)
    response = upload(client, original)
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['ok'] is True
    photo = payload['photo']
    assert set(photo) == {'filename', 'url', 'thumbnail_url', 'view_url'}
    assert photo['filename'] in module.get_box_photos('box-001')
    assert client.get(photo['url']).data == original
    assert client.get(photo['thumbnail_url']).mimetype == 'image/jpeg'
    assert client.get(photo['view_url']).status_code == 200
    assert len(module.get_box_photos('box-001')) == 2
    assert_originals_unchanged(data_dir, before)


def test_lost_response_retry_survives_restart_without_duplicate_or_rewrite(storage):
    _, client, data_dir = storage
    first = upload(client)
    assert first.status_code == 200
    before_retry = snapshot(data_dir)
    spec = importlib.util.spec_from_file_location('upload_restarted_app', APP_PATH)
    restarted = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(restarted)
    restarted.app.config['TESTING'] = True
    # Canonical UUID and hex forms name the same queued photo across restarts.
    second = upload(
        restarted.app.test_client(),
        upload_id='CA50D48E-771B-4CFF-BF1D-D21288213621', filename='renamed.jpeg',
    )
    assert second.status_code == 200
    assert second.get_json() == first.get_json()
    assert snapshot(data_dir) == before_retry


def test_upload_ids_are_scoped_to_each_box(storage):
    module, client, data_dir = storage
    (data_dir / 'boxes' / 'box-002.md').write_text('# Second box\n')
    first = upload(client)
    second = upload(client, picture_bytes('blue'), box='box-002')
    assert first.status_code == second.status_code == 200
    assert client.get(first.get_json()['photo']['url']).data == picture_bytes('red')
    assert client.get(second.get_json()['photo']['url']).data == picture_bytes('blue')
    assert len(module.get_box_photos('box-002')) == 1


def test_same_id_different_bytes_returns_conflict_without_overwrite(storage):
    _, client, data_dir = storage
    assert upload(client).status_code == 200
    before = snapshot(data_dir)
    response = upload(client, picture_bytes('blue'))
    assert response.status_code == 409
    assert response.get_json()['ok'] is False
    assert response.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('same_photo', [True, False])
def test_simultaneous_same_id_uploads_publish_once(storage, same_photo):
    module, _, data_dir = storage
    before = snapshot(data_dir)
    barrier = Barrier(2)

    def submit(color):
        with module.app.test_client() as client:
            barrier.wait()
            response = upload(client, picture_bytes(color))
            return response.status_code, response.get_json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, ['red', 'red' if same_photo else 'blue']))
    assert sorted(status for status, _ in results) == ([200, 200] if same_photo else [200, 409])
    if same_photo:
        assert results[0][1] == results[1][1]
    assert len(module.get_box_photos('box-001')) == 2
    assert_originals_unchanged(data_dir, before)


@pytest.mark.parametrize('upload_id', [None, '', '../bad', 'x' * 32, 'a' * 31, 'a' * 33])
def test_invalid_upload_id_returns_json_without_writes(storage, upload_id):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = upload(client, upload_id=upload_id)
    assert response.status_code == 400
    assert response.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('filename,content,status', [
    ('photo.heic', b'unsupported', 400),
    ('photo.svg', b'<svg></svg>', 400),
    ('photo.jpg', b'not an image', 422),
    ('photo.png', b'', 422),
    ('photo.png', b'\x89PNG\r\n\x1a\ntruncated', 422),
])
def test_invalid_image_never_appears_in_gallery(storage, filename, content, status):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = upload(client, content, filename=filename)
    assert response.status_code == status
    assert response.get_json()['error']
    assert snapshot(data_dir) == before


def test_missing_photo_box_and_oversized_request_are_json_errors(storage):
    module, client, data_dir = storage
    before = snapshot(data_dir)
    missing_file = client.post('/box/box-001/photos', data={'upload_id': UPLOAD_ID}, headers=HEADERS)
    assert missing_file.status_code == 400
    assert missing_file.get_json()['error']
    missing_box = upload(client, box='box-999')
    assert missing_box.status_code == 404
    assert missing_box.get_json()['error']
    unsafe_box = upload(client, box='..%5Coutside')
    assert unsafe_box.status_code == 404
    assert unsafe_box.get_json()['error']
    module.app.config['MAX_CONTENT_LENGTH'] = 100
    too_large = upload(client)
    assert too_large.status_code == 413
    assert too_large.get_json()['error']
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('failure', ['partial_write', 'publish'])
def test_failed_upload_cleans_partial_files_and_preserves_originals(storage, monkeypatch, failure):
    module, client, data_dir = storage
    before = snapshot(data_dir)
    if failure == 'partial_write':
        def fail_save(self, destination, *args, **kwargs):
            destination.write(b'partial image bytes')
            assert module.get_box_photos('box-001') == ['20260130_120000.jpg']
            raise OSError('simulated interrupted write')
        monkeypatch.setattr(FileStorage, 'save', fail_save)
    else:
        def fail_publish(source, destination):
            assert module.get_box_photos('box-001') == ['20260130_120000.jpg']
            raise OSError('simulated full disk')
        monkeypatch.setattr(module.os, 'link', fail_publish)
    response = upload(client)
    assert response.status_code == 500
    assert response.get_json()['error']
    assert snapshot(data_dir) == before


def test_failed_acknowledgement_after_publication_can_retry_without_duplicate(storage, monkeypatch):
    module, client, data_dir = storage
    before = snapshot(data_dir)
    real_fsync = module.os.fsync
    directory_failed = False

    def fail_directory_once(descriptor):
        nonlocal directory_failed
        if stat.S_ISDIR(module.os.fstat(descriptor).st_mode) and not directory_failed:
            directory_failed = True
            raise OSError('simulated failure after publication')
        return real_fsync(descriptor)

    monkeypatch.setattr(module.os, 'fsync', fail_directory_once)
    assert upload(client).status_code == 500
    after_uncertain_save = snapshot(data_dir)
    recovered = upload(client)
    assert recovered.status_code == 200
    assert client.get(recovered.get_json()['photo']['url']).data == picture_bytes('red')
    assert len(module.get_box_photos('box-001')) == 2
    assert snapshot(data_dir) == after_uncertain_save
    assert_originals_unchanged(data_dir, before)


def test_plain_form_fallback_still_redirects_and_preserves_original_bytes(storage):
    module, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post('/box/box-001/photos', data={
        'photo': (io.BytesIO(picture_bytes('green')), 'phone.jpg'),
    })
    assert response.status_code == 302
    assert response.headers['Location'] == '/box/box-001'
    new_photo = next(name for name in module.get_box_photos('box-001') if name != '20260130_120000.jpg')
    assert (data_dir / 'photos' / 'box-001' / new_photo).read_bytes() == picture_bytes('green')
    assert_originals_unchanged(data_dir, before)


def test_phone_mpo_upload_retains_every_original_frame(storage):
    _, client, data_dir = storage
    buffer = io.BytesIO()
    with Image.new('RGB', (3, 2), 'orange') as primary, Image.new('RGB', (3, 2), 'black') as auxiliary:
        primary.save(buffer, format='MPO', save_all=True, append_images=[auxiliary])
    original = buffer.getvalue()
    response = upload(client, original, filename='phone.jpeg')
    assert response.status_code == 200
    assert client.get(response.get_json()['photo']['url']).data == original
    with Image.open(data_dir / 'photos' / 'box-001' / response.get_json()['photo']['filename']) as image:
        assert image.n_frames == 2
