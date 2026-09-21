"""A small, file-based inventory for the boxes in our storage unit."""

import base64
from contextlib import contextmanager
from datetime import datetime
import fcntl
from hashlib import sha256
import io
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from urllib.parse import quote
from uuid import uuid4

from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, url_for
from markdown_it import MarkdownIt
from PIL import Image, ImageOps
import qrcode


app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
app.config['MAX_PHOTO_ROTATION_PIXELS'] = 32_000_000
app.config['PUBLIC_BASE_URL'] = os.environ.get(
    'PUBLIC_BASE_URL', 'https://box-storage.fly.dev'
).rstrip('/')

VERSION = "2.04"
BUILD_DATE = "2026-09-21"


@app.context_processor
def inject_version():
    return {'version': VERSION, 'build_date': BUILD_DATE}


# Production still reads the original Fly volume; local previews can use a copy.
DATA_DIR = Path(os.environ.get('DATA_PATH', Path(__file__).parent))
BOXES_DIR = DATA_DIR / 'boxes'
PHOTOS_DIR = DATA_DIR / 'photos'
PHOTO_EDITS_DIR = DATA_DIR / 'photo-edits'
BOXES_DIR.mkdir(parents=True, exist_ok=True)
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
markdown = MarkdownIt('js-default', {'html': False, 'breaks': True})


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def _safe_component(value):
    """Keep the existing file names while ensuring a URL cannot leave its folder."""
    return bool(value) and value not in {'.', '..'} and not any(
        character in value for character in ('/', '\\', '\x00')
    )


def _box_file(box_id):
    if not _safe_component(box_id):
        abort(404)
    return BOXES_DIR / f'{box_id}.md'


def get_box_photos(box_id):
    """Return existing photo names without generating or changing any images."""
    _box_file(box_id)
    box_photos_dir = PHOTOS_DIR / box_id
    if not box_photos_dir.is_dir():
        return []
    return [
        photo.name for photo in sorted(box_photos_dir.iterdir())
        if photo.is_file() and allowed_file(photo.name)
    ]


def get_box_content(box_id):
    """Read the original UTF-8 text, retaining its line endings."""
    box_file = _box_file(box_id)
    if box_file.is_file():
        return box_file.read_bytes().decode('utf-8')
    return None


def _normalise_browser_newlines(content):
    # Browsers normalise textarea line endings when submitting a form.
    return content.replace('\r\n', '\n').replace('\r', '\n')


def _content_revision(content):
    return sha256(content.encode('utf-8')).hexdigest() if content is not None else None


@contextmanager
def _boxes_write_lock():
    # The directory survives atomic note replacements, unlike a note's inode.
    # flock needs no persistent lock file and coordinates separate workers.
    descriptor = os.open(BOXES_DIR, os.O_RDONLY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def save_box_content(box_id, content, *, create_only=False):
    """Write a complete replacement atomically, leaving unchanged originals alone."""
    box_file = _box_file(box_id)
    existing = get_box_content(box_id)
    if create_only and existing is not None:
        raise FileExistsError(box_file)
    if existing is not None and _normalise_browser_newlines(existing) == _normalise_browser_newlines(content):
        return False

    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='wb', prefix=f'.{box_id}-', suffix='.tmp', dir=BOXES_DIR, delete=False
        ) as temporary:
            temporary_name = temporary.name
            if box_file.exists():
                os.chmod(temporary_name, stat.S_IMODE(box_file.stat().st_mode))
            temporary.write(content.encode('utf-8'))
            temporary.flush()
            os.fsync(temporary.fileno())
        if create_only:
            # Publish the finished file only if this number is still unused.
            os.link(temporary_name, box_file)
        else:
            os.replace(temporary_name, box_file)
        return True
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def _box_metadata(box_id, content, modified=None):
    lines = content.lstrip('\ufeff').strip().splitlines()
    first_line = lines[0].strip() if lines else ''
    title = _plain_title(re.sub(r'^#{1,6}(?:\s+|$)', '', first_line).strip()) or box_id
    # This is a display-only abbreviation. The source and label title stay intact.
    id_prefix = re.escape(box_id)
    if box_id.lower().startswith('box-'):
        id_prefix = r'box[\s-]+' + re.escape(box_id[4:])
    display_title = re.sub(
        rf'^{id_prefix}(?=$|[\s:|\-–—])(?:\s*[:|\-–—]?\s*)',
        '', title, count=1, flags=re.IGNORECASE
    ).strip() or 'Untitled box'
    suffix = re.search(r'(\d+)$', box_id)
    photos = get_box_photos(box_id)
    thumbnail_url = (
        photo_src(box_id, photos[0], thumbnail=True)
        if photos else None
    )
    return {
        'id': box_id,
        'title': title,
        'display_title': display_title,
        'number': suffix.group(1).zfill(3) if suffix else box_id,
        'modified': modified,
        'photo_count': len(photos),
        'thumbnail_url': thumbnail_url,
    }


def get_all_boxes():
    """Read all existing boxes, most recently changed first."""
    boxes = []
    for box_file in BOXES_DIR.glob('*.md'):
        if box_file.is_file():
            boxes.append(_box_metadata(
                box_file.stem,
                box_file.read_bytes().decode('utf-8'),
                datetime.fromtimestamp(box_file.stat().st_mtime),
            ))
    return sorted(boxes, key=lambda box: box['modified'], reverse=True)


def generate_box_id():
    """Choose a free box number without creating a file just by opening a page."""
    existing = {box_file.stem for box_file in BOXES_DIR.glob('*.md')}
    existing.update(folder.name for folder in PHOTOS_DIR.iterdir() if folder.is_dir())
    counter = 1
    while f'box-{counter:03d}' in existing:
        counter += 1
    return f'box-{counter:03d}'


def render_markdown(content, *, omit_title=False):
    """Render a view of the Markdown; never rewrite the stored source."""
    tokens = markdown.parse(content.lstrip('\ufeff'))
    if omit_title and tokens and tokens[0].type == 'heading_open' and tokens[0].tag == 'h1':
        tokens = tokens[3:]
    return markdown.renderer.render(tokens, markdown.options, {})


class _InlineText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def _plain_title(value):
    parser = _InlineText()
    parser.feed(markdown.renderInline(value))
    return ''.join(parser.parts)


def editor_data(box_id, content, *, is_new=False):
    """Keep exact source slices so visual editing need not rewrite untouched text."""
    match = re.match(
        r'\A\ufeff?(?:[ \t]*(?:\r\n|\n|\r))* {0,3}#[ \t]+(?P<title>[^\r\n]*)(?P<eol>\r\n|\n|\r|$)',
        content,
    )
    data = {
        'source': content, 'title': '', 'head': '', 'body': content,
        'titlePrefix': '# ', 'titleSuffix': '\n', 'newline': '\n',
        'revision': None if is_new else _content_revision(content),
    }
    if match:
        raw_title = match.group('title')
        leading = len(raw_title) - len(raw_title.lstrip())
        label = raw_title.strip()
        identifier = re.escape(box_id)
        if box_id.lower().startswith('box-'):
            identifier = r'box[\s-]+' + re.escape(box_id[4:])
        prefix = re.match(
            rf'{identifier}(?=$|[\s:|\-–—])(?:\s*[:|\-–—]?\s*)',
            label, flags=re.IGNORECASE,
        )
        start = match.start('title') + leading + (prefix.end() if prefix else 0)
        end = max(start, match.start('title') + len(raw_title.rstrip()))
        data.update(
            title=_plain_title(content[start:end]), head=content[:match.end()],
            body=content[match.end():], titlePrefix=content[:start],
            titleSuffix=content[end:match.end()], newline=match.group('eol') or '\n',
        )
    data['html'] = render_markdown(data['body'])
    return data


def box_qr_url(box_id):
    return f'{app.config["PUBLIC_BASE_URL"]}/box/{quote(box_id, safe="")}'


def _qr_png(url):
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(fill_color='black', back_color='white')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    buffer.seek(0)
    return buffer


def generate_qr_code(url):
    return base64.b64encode(_qr_png(url).getvalue()).decode('ascii')


def _error(title, message, status=400, back_url=None):
    if request.is_json:
        return jsonify(error=message), status
    return render_template(
        'error.html', title=title, message=message,
        back_url=back_url or url_for('index'),
    ), status


def _recover_new_box_draft(content):
    """Keep an unsaved draft available if its proposed number was already used."""
    box_id = generate_box_id()
    if request.is_json:
        return jsonify(
            error=f'That box number was already used. Your draft is still here. Save again to create Box {box_id.removeprefix("box-")}.',
            recovery_url=url_for('edit_box', box_id=box_id, new='1'),
            box_number=box_id.removeprefix('box-'),
        ), 409
    return render_template(
        'edit.html', box=_box_metadata(box_id, content), box_id=box_id,
        content=content, editor=editor_data(box_id, content, is_new=True), is_new=True,
        error=(
            'That box number was used while this draft was open. Your text is still here '
            'with a new box number. Check the title, then save when ready.'
        ),
    ), 409


@app.errorhandler(404)
def not_found(error):
    return _error('Page not found', 'This box or page could not be found.', 404)


@app.errorhandler(413)
def upload_too_large(error):
    return _error('Photo is too large', 'Choose a photo smaller than 16 MB.', 413)


@app.route('/')
def index():
    return render_template('index.html', boxes=get_all_boxes())


@app.route('/box/<box_id>')
def view_box(box_id):
    content = get_box_content(box_id)
    if content is None:
        abort(404)
    box = _box_metadata(
        box_id, content, datetime.fromtimestamp(_box_file(box_id).stat().st_mtime)
    )
    qr_url = box_qr_url(box_id)
    return render_template(
        'box.html', box=box, box_id=box_id, content=content,
        rendered_content=render_markdown(content, omit_title=True),
        qr_base64=generate_qr_code(qr_url), qr_url=qr_url,
        photos=get_box_photos(box_id),
    )


@app.route('/box/<box_id>/edit', methods=['GET', 'POST'])
def edit_box(box_id):
    payload = request.get_json(silent=True) if request.is_json else request.form
    if not hasattr(payload, 'get'):
        payload = {}
    is_new = request.args.get('new') == '1' or payload.get('is_new') == '1'
    if request.method == 'POST':
        if not isinstance(payload.get('content'), str):
            return _error(
                'Contents were not received', 'Open the editor and try saving again.',
                400, url_for('edit_box', box_id=box_id, **({'new': '1'} if is_new else {})),
            )
        submitted_content = payload['content']
        check_revision = request.is_json and 'expected_revision' in payload
        expected_revision = payload.get('expected_revision')
        if check_revision and expected_revision is not None and (
            not isinstance(expected_revision, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_revision)
        ):
            return _error('Invalid revision', 'The saved version could not be identified. Reload the editor before saving.', 400)
        try:
            with _boxes_write_lock():
                content = get_box_content(box_id)
                if content is None and not is_new:
                    abort(404)
                if is_new and content is not None:
                    return _recover_new_box_draft(submitted_content)
                already_saved = content is not None and (
                    _normalise_browser_newlines(content) == _normalise_browser_newlines(submitted_content)
                )
                if check_revision and expected_revision != _content_revision(content) and not already_saved:
                    return jsonify(
                        error='This box was changed elsewhere. Your text is still in the editor. Review the saved note before replacing it.',
                        content=content, revision=_content_revision(content),
                    ), 409
                save_box_content(box_id, submitted_content, create_only=is_new)
                persisted = get_box_content(box_id)
                if request.is_json:
                    return jsonify(
                        redirect=url_for('view_box', box_id=box_id),
                        edit_url=url_for('edit_box', box_id=box_id),
                        box_id=box_id, box_number=_box_metadata(box_id, persisted)['number'],
                        revision=_content_revision(persisted), content=persisted,
                    )
        except FileExistsError:
            return _recover_new_box_draft(submitted_content)
        except OSError:
            app.logger.exception('Could not save box contents.')
            return _error(
                'Save could not be confirmed',
                'Could not confirm the save. Keep this page open and try again.',
                500,
            )
        return redirect(url_for('view_box', box_id=box_id))

    content = get_box_content(box_id)
    if is_new and content is not None:
        return _error(
            'Box number already in use',
            'This box number has already been saved. Start a new box to get another number.',
            409, url_for('new_box'),
        )
    if content is None and not is_new:
        abort(404)
    if content is None:
        content = f'# {box_id}\n\n## Contents\n\n- \n\n## Location\n\n\n## Notes\n\n'
    modified = None if is_new else datetime.fromtimestamp(_box_file(box_id).stat().st_mtime)
    return render_template(
        'edit.html', box=_box_metadata(box_id, content, modified),
        box_id=box_id, content=content, editor=editor_data(box_id, content, is_new=is_new),
        is_new=is_new, error=None,
    )


@app.route('/preview', methods=['POST'])
def preview():
    payload = request.get_json(silent=True) if request.is_json else request.form
    content = payload.get('content', '') if hasattr(payload, 'get') else ''
    if not isinstance(content, str):
        return jsonify(error='Contents must be text.'), 400
    return jsonify(html=render_markdown(content))


@app.route('/box/<box_id>/qr')
def download_qr(box_id):
    if get_box_content(box_id) is None:
        abort(404)
    return send_file(
        _qr_png(box_qr_url(box_id)), mimetype='image/png',
        download_name=f'{box_id}-qr.png',
    )


@app.route('/new')
def new_box():
    return redirect(url_for('edit_box', box_id=generate_box_id(), new='1'))


@app.route('/labels')
def labels():
    boxes = get_all_boxes()
    existing_ids = {box['id'] for box in boxes}
    requested = request.args.getlist('box')
    selected_ids = (
        [box_id for box_id in requested if box_id in existing_ids]
        if 'box' in request.args else [box['id'] for box in boxes]
    )
    if any(box_id and box_id not in existing_ids for box_id in requested):
        return render_template(
            'labels.html', boxes=boxes, selected_ids=selected_ids,
            error='One of the selected boxes is no longer available. Choose your boxes again.',
        ), 400
    return render_template('labels.html', boxes=boxes, selected_ids=selected_ids, error=None)


@app.route('/labels/print')
def label_print():
    boxes = get_all_boxes()
    existing_ids = {box['id'] for box in boxes}
    selected_ids = list(dict.fromkeys(request.args.getlist('box')))
    if not selected_ids or not any(selected_ids):
        return render_template(
            'labels.html', boxes=boxes, selected_ids=[],
            error='Select at least one box to print.',
        ), 400
    if any(box_id not in existing_ids for box_id in selected_ids):
        return _error(
            'Box not found', 'One of the selected boxes is no longer available. Choose your boxes again.',
            400, url_for('labels'),
        )
    paper = request.args.get('paper', 'letter').lower()
    copies_value = request.args.get('copies', '1')
    if paper not in {'letter', 'a4'}:
        return _error('Choose a paper size', 'Labels can be printed on Letter or A4 paper.', 400, url_for('labels'))
    if copies_value not in {'1', '2', '3', '4'}:
        return _error('Choose a number of copies', 'Choose between one and four copies of each label.', 400, url_for('labels'))
    copies = int(copies_value)
    selected = set(selected_ids)
    print_labels = []
    for box in boxes:
        if box['id'] in selected:
            qr_url = box_qr_url(box['id'])
            label = {
                key: box[key] for key in ('id', 'number', 'title', 'display_title')
            }
            label.update(qr_base64=generate_qr_code(qr_url), qr_url=qr_url)
            print_labels.extend(label.copy() for _ in range(copies))
    pages = [print_labels[offset:offset + 6] for offset in range(0, len(print_labels), 6)]
    return render_template(
        'print_labels.html', pages=pages, paper=paper, copies=copies,
        label_count=len(print_labels), box_count=len(selected), selected_ids=selected_ids,
    )


@app.route('/search')
def search():
    query = request.args.get('q', '').strip().lower()
    results = []
    if query:
        for box in get_all_boxes():
            content = get_box_content(box['id'])
            if query in box['id'].lower() or query in content.lower():
                result = box.copy()
                result['preview'] = [
                    line.strip() for line in content.splitlines() if query in line.lower()
                ][:3]
                results.append(result)
    return render_template('search.html', query=query, results=results)


@app.route('/box/<box_id>/photos', methods=['POST'])
def upload_photo(box_id):
    if get_box_content(box_id) is None:
        abort(404)
    file = request.files.get('photo')
    if file is None or not file.filename:
        return redirect(url_for('view_box', box_id=box_id))
    if not allowed_file(file.filename):
        return _error(
            'Choose an image', 'Use a JPG, PNG, GIF or WebP photo.',
            400, url_for('view_box', box_id=box_id),
        )
    box_photos_dir = PHOTOS_DIR / box_id
    box_photos_dir.mkdir(exist_ok=True)
    extension = file.filename.rsplit('.', 1)[1].lower()
    # Exclusive creation guarantees a new upload cannot overwrite an old photo.
    while True:
        photo_path = box_photos_dir / f'{uuid4().hex}.{extension}'
        try:
            photo_file = photo_path.open('xb')
            break
        except FileExistsError:
            continue
    try:
        with photo_file:
            file.save(photo_file)
            photo_file.flush()
            os.fsync(photo_file.fileno())
    except Exception:
        photo_path.unlink(missing_ok=True)
        raise
    return redirect(url_for('view_box', box_id=box_id))


def _photo_file(box_id, filename):
    _box_file(box_id)
    if not _safe_component(filename):
        abort(404)
    return PHOTOS_DIR / box_id / filename


def _photo_edit_location(box_id, filename):
    _photo_file(box_id, filename)
    key = sha256(filename.encode('utf-8')).hexdigest()
    return PHOTO_EDITS_DIR / box_id, key


def _read_photo_edit(box_id, filename, *, strict=False):
    folder, key = _photo_edit_location(box_id, filename)
    original = {'rotation': 0, 'revision': None}
    try:
        state = json.loads((folder / f'{key}.json').read_text(encoding='utf-8'))
        if not isinstance(state, dict) or type(state.get('rotation')) is not int or state['rotation'] not in range(4):
            raise ValueError('Invalid saved photo rotation.')
        if not isinstance(state.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{32}', state['revision']):
            raise ValueError('Invalid saved photo revision.')
        if state['rotation'] and not (folder / f'{key}-{state["revision"]}.png').is_file():
            raise ValueError('The saved photo image is missing.')
        return {'rotation': state['rotation'], 'revision': state['revision']}
    except FileNotFoundError:
        return original
    except (OSError, ValueError):
        if strict:
            raise
        # A damaged edit cannot make the original photograph inaccessible.
        return original


@app.template_global()
def photo_src(box_id, filename, thumbnail=False):
    state = _read_photo_edit(box_id, filename)
    path = f'/box/{quote(box_id, safe="")}/photos/{quote(filename, safe="")}'
    query = ['thumbnail=1'] if thumbnail else []
    if state['revision']:
        query.append(f'v={state["revision"]}')
    return path + ('?' + '&'.join(query) if query else '')


def _saved_photo_path(box_id, filename):
    state = _read_photo_edit(box_id, filename)
    if state['rotation']:
        folder, key = _photo_edit_location(box_id, filename)
        return folder / f'{key}-{state["revision"]}.png'
    return _photo_file(box_id, filename)


class PhotoRotationError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def _rotated_original(photo_path, rotation):
    """Decode the original once; PNG preserves the resulting pixels losslessly."""
    try:
        with Image.open(photo_path) as source:
            if source.format in {'GIF', 'WEBP', 'PNG'} and getattr(source, 'is_animated', False):
                raise PhotoRotationError('Animated photos cannot be rotated. The original is unchanged.')
            if source.width * source.height > app.config['MAX_PHOTO_ROTATION_PIXELS']:
                raise PhotoRotationError('This photo is too large to rotate safely. The original is unchanged.', 413)
            source.load()
            with ImageOps.exif_transpose(source) as oriented:
                mode = 'RGBA' if 'A' in oriented.getbands() or 'transparency' in oriented.info else 'RGB'
                pixels = oriented.convert(mode)
        operations = {
            1: Image.Transpose.ROTATE_270,
            2: Image.Transpose.ROTATE_180,
            3: Image.Transpose.ROTATE_90,
        }
        if rotation:
            rotated = pixels.transpose(operations[rotation])
            pixels.close()
            return rotated
        return pixels
    except PhotoRotationError:
        raise
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise PhotoRotationError('This image could not be opened. The original is unchanged.') from error


def _atomic_photo_edit(path, write):
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='wb', prefix=f'.{path.stem}-', suffix='.tmp', dir=path.parent, delete=False
        ) as temporary:
            temporary_name = temporary.name
            write(temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def _write_photo_rotation(box_id, filename, rotation, image):
    folder, key = _photo_edit_location(box_id, filename)
    folder.mkdir(parents=True, exist_ok=True)
    state = {'rotation': rotation, 'revision': uuid4().hex}
    derivative = folder / f'{key}-{state["revision"]}.png' if rotation else None
    try:
        if derivative is not None:
            _atomic_photo_edit(derivative, lambda output: image.save(output, format='PNG', exif=b''))
        # Publish the new state only after its complete image is available.
        state_bytes = json.dumps(state, sort_keys=True).encode('utf-8')
        _atomic_photo_edit(folder / f'{key}.json', lambda output: output.write(state_bytes))
    except Exception:
        if derivative is not None:
            derivative.unlink(missing_ok=True)
        raise
    # Only obsolete generated images are discarded; originals are never here.
    for previous in folder.glob(f'{key}-*.png'):
        if previous != derivative:
            try:
                previous.unlink()
            except OSError:
                app.logger.warning('Could not remove an obsolete photo derivative: %s', previous)
    return state


def _delete_photo_edits(box_id, filename):
    folder, key = _photo_edit_location(box_id, filename)
    (folder / f'{key}.json').unlink(missing_ok=True)
    for derivative in folder.glob(f'{key}-*.png'):
        derivative.unlink()
    if folder.is_dir() and not any(folder.iterdir()):
        folder.rmdir()


@app.route('/box/<box_id>/photos/<filename>/rotate', methods=['POST'])
def rotate_photo(box_id, filename):
    if not _safe_component(box_id) or not _safe_component(filename):
        return jsonify(error='Photo not found.'), 404
    photo_path = _photo_file(box_id, filename)
    if not _box_file(box_id).is_file() or not photo_path.is_file() or not allowed_file(filename):
        return jsonify(error='Photo not found.'), 404
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or any(
        type(payload.get(field)) is not int or payload[field] not in range(4)
        for field in ('rotation', 'expected_rotation')
    ):
        return jsonify(error='Choose a rotation from 0 to 3 and include the previous saved rotation.'), 400
    try:
        # A read-only descriptor provides a cross-worker lock without creating a
        # lock file or modifying the original image's bytes or modification time.
        with photo_path.open('rb') as original_lock:
            fcntl.flock(original_lock.fileno(), fcntl.LOCK_EX)
            state = _read_photo_edit(box_id, filename, strict=True)
            if payload['expected_rotation'] != state['rotation']:
                return jsonify(
                    error='This photo was changed elsewhere. Reload it before saving another rotation.',
                    rotation=state['rotation'], photo_url=photo_src(box_id, filename),
                ), 409
            with _rotated_original(photo_path, payload['rotation']) as image:
                if payload['rotation'] != state['rotation']:
                    state = _write_photo_rotation(box_id, filename, payload['rotation'], image)
            return jsonify(rotation=state['rotation'], photo_url=photo_src(box_id, filename))
    except PhotoRotationError as error:
        return jsonify(error=str(error)), error.status
    except (OSError, ValueError):
        app.logger.exception('Could not save a photo rotation.')
        return jsonify(error='The rotation could not be saved. Your original photo and notes are unchanged.'), 500


def _photo_thumbnail(photo_path):
    """Create a small display copy in memory; the original file is only read."""
    source_stat = photo_path.stat()
    etag = f'thumbnail-v1-{source_stat.st_mtime_ns:x}-{source_stat.st_size:x}'
    output = io.BytesIO()
    mimetype = 'image/jpeg'
    try:
        with Image.open(photo_path) as source:
            # JPEG can decode at a smaller size, reducing memory use on the server.
            source.draft('RGB', (360, 360))
            with ImageOps.exif_transpose(source) as thumbnail:
                thumbnail.thumbnail((360, 360), Image.Resampling.LANCZOS)
                with thumbnail.convert('RGBA') as rgba:
                    with Image.new('RGB', rgba.size, 'white') as flattened:
                        flattened.paste(rgba, mask=rgba.getchannel('A'))
                        flattened.save(output, format='JPEG', quality=82, optimize=True)
    except (OSError, ValueError, Image.DecompressionBombError):
        # The surrounding photo link still opens the untouched original file.
        output = io.BytesIO(
            b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240">'
            b'<rect width="360" height="240" fill="#efede6"/>'
            b'<path d="M150 75h60v48h-60z m0 38 18-18 14 14 10-10 18 18" '
            b'fill="none" stroke="#78766d" stroke-width="3"/>'
            b'<text x="180" y="164" text-anchor="middle" font-family="sans-serif" '
            b'font-size="20" fill="#57564f">Open original</text></svg>'
        )
        mimetype = 'image/svg+xml'
    output.seek(0)
    return send_file(
        output, mimetype=mimetype, etag=etag,
        last_modified=source_stat.st_mtime, max_age=86400,
    )


@app.route('/box/<box_id>/photos/<filename>')
def get_photo(box_id, filename):
    photo_path = _photo_file(box_id, filename)
    if not photo_path.is_file():
        abort(404)
    with photo_path.open('rb') as original_lock:
        fcntl.flock(original_lock.fileno(), fcntl.LOCK_SH)
        photo_path = _saved_photo_path(box_id, filename)
        if request.args.get('thumbnail') == '1':
            return _photo_thumbnail(photo_path)
        # send_file opens its response file here, before this lock is released.
        # That open descriptor stays readable if a later save retires the PNG.
        return send_file(photo_path)


@app.route('/box/<box_id>/photos/<filename>/view')
def view_photo(box_id, filename):
    content = get_box_content(box_id)
    photo_path = _photo_file(box_id, filename)
    photos = get_box_photos(box_id)
    if content is None or not photo_path.is_file() or filename not in photos:
        abort(404)
    box = _box_metadata(
        box_id, content, datetime.fromtimestamp(_box_file(box_id).stat().st_mtime)
    )
    return render_template(
        'photo.html', box_id=box_id, box=box,
        photo_url=photo_src(box_id, filename),
        photo_rotation=_read_photo_edit(box_id, filename)['rotation'],
        rotation_url=url_for('rotate_photo', box_id=box_id, filename=filename),
        photo_number=photos.index(filename) + 1, photo_count=len(photos),
    )


@app.route('/box/<box_id>/photos/<filename>/delete', methods=['POST'])
def delete_photo(box_id, filename):
    photo_path = _photo_file(box_id, filename)
    if photo_path.is_file():
        photo_path.unlink()
    _delete_photo_edits(box_id, filename)
    return redirect(url_for('view_box', box_id=box_id))


@app.route('/box/<box_id>/delete', methods=['POST'])
def delete_box(box_id):
    box_file = _box_file(box_id)
    with _boxes_write_lock():
        if box_file.is_file():
            box_file.unlink()
    box_photos_dir = PHOTOS_DIR / box_id
    if box_photos_dir.is_dir():
        for photo in box_photos_dir.iterdir():
            if photo.is_file():
                photo.unlink()
        box_photos_dir.rmdir()
    edits_dir = PHOTO_EDITS_DIR / box_id
    if edits_dir.is_dir():
        shutil.rmtree(edits_dir)
    return redirect(url_for('index'))


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
