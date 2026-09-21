"""Exercise user-visible behavior with disposable data, never the live volume."""

import importlib.util
import io
import sys
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from PIL import Image


APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
ORIGINAL_MARKDOWN = (
    "# Family photos & letters\r\n"
    "\r\n"
    "## Contents\r\n"
    "\r\n"
    "- **Photos** from Mum’s house  \r\n"
    "  - loose prints\r\n"
    "- postcards & letters\r\n"
    "\r\n"
    "## Notes\r\n"
    "\r\n"
    "Keep this spacing.   \r\n"
    "\r\n"
).encode("utf-8")


class Document(HTMLParser):
    """Small HTML tree sufficient for checking forms and printed labels."""

    VOID_ELEMENTS = {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = {"tag": "root", "attrs": {}, "children": []}
        self.stack = [self.root]
        self.feed(html.replace("\r\n", "\n").replace("\r", "\n"))

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "children": []}
        self.stack[-1]["children"].append(node)
        if tag not in self.VOID_ELEMENTS:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index]["tag"] == tag:
                self.stack = self.stack[:index]
                break

    def handle_data(self, data):
        # Match the browser rule that consumes one opening newline in textarea.
        if self.stack[-1]["tag"] == "textarea" and not self.stack[-1]["children"] and data.startswith("\n"):
            data = data[1:]
        self.stack[-1]["children"].append(data)

    def find(self, tag=None, css_class=None, **attrs):
        return self.within(self.root, tag, css_class, **attrs)

    @classmethod
    def within(cls, node, tag=None, css_class=None, **attrs):
        found = []
        for child in node["children"]:
            if isinstance(child, str):
                continue
            matches = (
                (tag is None or child["tag"] == tag)
                and (css_class is None or css_class in child["attrs"].get("class", "").split())
                and all(child["attrs"].get(key) == value for key, value in attrs.items())
            )
            if matches:
                found.append(child)
            found.extend(cls.within(child, tag, css_class, **attrs))
        return found

    @classmethod
    def text(cls, node):
        return "".join(child if isinstance(child, str) else cls.text(child) for child in node["children"])


def picture_bytes(color):
    buffer = io.BytesIO()
    Image.new("RGB", (3, 3), color).save(buffer, format="JPEG")
    return buffer.getvalue()


def snapshot(data_dir):
    """Detect byte changes, accidental new files, and unnecessary rewrites."""
    return {
        path.relative_to(data_dir).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in data_dir.rglob("*")
        if path.is_file()
    }


@pytest.fixture
def storage(tmp_path, monkeypatch):
    # Import with DATA_PATH already set: even import-time mkdir cannot touch a
    # checkout's files, a restored backup, or the production data directory.
    monkeypatch.setenv("DATA_PATH", str(tmp_path))
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    name = "box_storage_test_app"
    spec = importlib.util.spec_from_file_location(name, APP_PATH)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    module.app.config.update(TESTING=True)
    box_file = tmp_path / "boxes" / "box-001.md"
    box_file.write_bytes(ORIGINAL_MARKDOWN)
    photo_dir = tmp_path / "photos" / "box-001"
    photo_dir.mkdir()
    photo_file = photo_dir / "20260130_120000.jpg"
    photo_file.write_bytes(picture_bytes("blue"))
    return module, module.app.test_client(), tmp_path


def test_reading_existing_collection_never_rewrites_text_or_photos(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    for url in (
        "/", "/box/box-001", "/box/box-001/edit", "/box/box-001/qr",
        "/box/box-001/photos/20260130_120000.jpg",
        "/box/box-001/photos/20260130_120000.jpg?thumbnail=1", "/search?q=photos",
        "/labels", "/labels?box=box-001", "/labels/print?box=box-001",
    ):
        response = client.get(url)
        assert response.status_code == 200, url
        assert snapshot(data_dir) == before, url


def test_box_page_renders_markdown_and_opens_photos_inside_the_app(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.get("/box/box-001")
    document = Document(response.get_data(as_text=True))
    assert any(Document.text(node) == "Contents" for node in document.find("h2"))
    assert any(Document.text(node) == "Photos" for node in document.find("strong"))
    assert any("loose prints" in Document.text(node) for node in document.find("li"))
    links = document.find("a", css_class="photo-link")
    assert len(links) == 1
    assert links[0]["attrs"].get("target") != "_blank"
    viewer = client.get(links[0]["attrs"]["href"])
    assert viewer.mimetype == "text/html"
    assert document.find("img", src="/box/box-001/photos/20260130_120000.jpg?thumbnail=1")
    assert snapshot(data_dir) == before


def test_full_size_photo_has_a_close_link_without_javascript(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    original_url = "/box/box-001/photos/20260130_120000.jpg"
    response = client.get(original_url + "/view")
    assert response.status_code == 200
    assert response.mimetype == "text/html"
    document = Document(response.get_data(as_text=True))
    assert document.find("img", src=original_url)
    close_links = [node for node in document.find("a", href="/box/box-001")
                   if "Close" in Document.text(node)]
    assert close_links and close_links[0]["attrs"].get("target") != "_blank"
    assert client.get(close_links[0]["attrs"]["href"]).status_code == 200
    assert client.get(original_url).data == before["photos/box-001/20260130_120000.jpg"][0]
    assert snapshot(data_dir) == before


@pytest.mark.parametrize("url", [
    "/box/box-999/photos/20260130_120000.jpg/view",
    "/box/box-001/photos/missing.jpg/view",
    "/box/box-001/photos/..%5Csecret.jpg/view",
])
def test_missing_or_invalid_photo_viewer_never_creates_data(storage, url):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    assert client.get(url).status_code == 404
    assert snapshot(data_dir) == before


@pytest.mark.parametrize("prefix", [b"", b"\n", b"\r\n\r\n"])
def test_editor_round_trip_preserves_original_text_including_leading_blank_lines(storage, prefix):
    _, client, data_dir = storage
    original = prefix + ORIGINAL_MARKDOWN
    (data_dir / "boxes" / "box-001.md").write_bytes(original)
    before = snapshot(data_dir)
    document = Document(client.get("/box/box-001/edit").get_data(as_text=True))
    textareas = document.find("textarea", name="content")
    assert len(textareas) == 1
    actual = Document.text(textareas[0]).replace("\r\n", "\n")
    assert actual == original.decode().replace("\r\n", "\n")
    response = client.post("/box/box-001/edit", data={"content": actual})
    assert response.status_code == 302
    assert snapshot(data_dir) == before


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_untouched_save_preserves_original_bytes_and_mtime(storage, newline):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    # Browsers can normalize textarea newlines during load and form submission.
    submitted = ORIGINAL_MARKDOWN.decode().replace("\r\n", "\n").replace("\n", newline)
    response = client.post("/box/box-001/edit", data={"content": submitted})
    assert response.status_code == 302
    assert urlsplit(response.headers["Location"]).path == "/box/box-001"
    assert snapshot(data_dir) == before


@pytest.mark.parametrize('newline', ['\n', '\r\n'])
def test_rich_json_title_edit_preserves_exact_body_line_endings(storage, newline):
    module, client, data_dir = storage
    source = f'# box-001 Photos  {newline}{newline}## Contents{newline}{newline}- prints{newline}'
    note = data_dir / 'boxes' / 'box-001.md'
    note.write_bytes(source.encode())
    before = snapshot(data_dir)
    parts = module.editor_data('box-001', source)
    assert parts['title'] == 'Photos'
    assert parts['head'] + parts['body'] == source
    unchanged = client.post('/box/box-001/edit', json={'content':source})
    assert unchanged.status_code == 200
    assert unchanged.get_json()['redirect'] == '/box/box-001'
    assert snapshot(data_dir) == before
    edited = parts['titlePrefix'] + 'Letters' + parts['titleSuffix'] + parts['body']
    assert client.post('/box/box-001/edit', json={'content':edited}).status_code == 200
    assert note.read_bytes() == edited.encode()
    assert note.read_bytes().endswith(parts['body'].encode())
    assert (data_dir / 'photos' / 'box-001' / '20260130_120000.jpg').read_bytes() == before['photos/box-001/20260130_120000.jpg'][0]


def test_rich_json_bad_payload_cannot_erase_note(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    for payload in ({}, {'content':None}, {'content':17}, ['text']):
        response = client.post('/box/box-001/edit', json=payload)
        assert response.status_code == 400
        assert response.get_json()['error']
        assert snapshot(data_dir) == before


def test_rich_new_box_collision_keeps_draft_and_requires_explicit_retry(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    draft = '# Albums\n\n- Photos\n'
    response = client.post('/box/box-001/edit', json={'is_new':'1', 'content':draft})
    assert response.status_code == 409
    assert snapshot(data_dir) == before
    recovery = response.get_json()['recovery_url']
    assert recovery == '/box/box-002/edit?new=1'
    assert client.post(recovery, json={'is_new':'1', 'content':draft}).status_code == 200
    assert (data_dir / 'boxes' / 'box-002.md').read_bytes() == draft.encode()
    for path, value in before.items():
        assert snapshot(data_dir)[path] == value


def test_actual_edit_keeps_box_identity_and_all_photo_bytes(storage):
    _, client, data_dir = storage
    original_photo = (data_dir / "photos" / "box-001" / "20260130_120000.jpg").read_bytes()
    edited = "# Albums and letters\n\n- Family photos\n- Emily’s postcards  \n\n"
    response = client.post("/box/box-001/edit", data={"content": edited})
    assert response.status_code == 302
    assert urlsplit(response.headers["Location"]).path == "/box/box-001"
    assert sorted(path.name for path in (data_dir / "boxes").glob("*.md")) == ["box-001.md"]
    assert (data_dir / "boxes" / "box-001.md").read_text() == edited
    photo_response = client.get("/box/box-001/photos/20260130_120000.jpg")
    assert photo_response.status_code == 200
    assert photo_response.data == original_photo


def test_preview_returns_rendered_markdown_without_persisting_anything(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post("/preview", data={"content": "## Contents\n\n- **Photos**\n- Letters"})
    assert response.status_code == 200
    assert response.is_json
    document = Document(response.get_json()["html"])
    assert any(Document.text(node) == "Contents" for node in document.find("h2"))
    assert [Document.text(node) for node in document.find("li")] == ["Photos", "Letters"]
    assert any(Document.text(node) == "Photos" for node in document.find("strong"))
    assert snapshot(data_dir) == before


def test_preview_accepts_the_editors_json_request(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post("/preview", json={"content": "# A box\n\nKeep **photos** here."})
    assert response.status_code == 200
    assert response.is_json
    document = Document(response.get_json()["html"])
    assert any(Document.text(node) == "A box" for node in document.find("h1"))
    assert any(Document.text(node) == "photos" for node in document.find("strong"))
    assert snapshot(data_dir) == before


@pytest.mark.parametrize("url,status", [
    ("/box/box-999", 404), ("/box/box-999/edit", 404), ("/box/box-999/qr", 404),
    ("/labels?box=box-999", 400), ("/labels/print?box=box-999", 400),
])
def test_unknown_ids_do_not_create_files(storage, url, status):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.get(url)
    assert response.status_code == status
    assert snapshot(data_dir) == before


def test_missing_box_save_requires_explicit_new_box_intent(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post("/box/box-999/edit", data={"content": "# Unintended box"})
    assert response.status_code == 404
    assert snapshot(data_dir) == before


def test_malformed_save_cannot_empty_an_existing_box(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.post("/box/box-001/edit", data={})
    assert response.status_code == 400
    assert snapshot(data_dir) == before


def test_a_stale_new_box_form_preserves_its_draft_for_explicit_save_to_a_fresh_box(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    draft = "\n# A different box\n\n- Emily’s albums  \n- Letters & postcards\n\n"
    response = client.post("/box/box-001/edit", data={"is_new": "1", "content": draft})
    assert response.status_code == 409
    assert snapshot(data_dir) == before
    document = Document(response.get_data(as_text=True))
    editors = document.find("textarea", name="content")
    assert len(editors) == 1
    assert Document.text(editors[0]) == draft
    forms = document.find("form", id="editor-form")
    assert len(forms) == 1
    target = urlsplit(forms[0]["attrs"]["action"])
    assert target.path == "/box/box-002/edit"
    assert parse_qs(target.query) == {"new": ["1"]}
    assert Document.within(forms[0], "input", type="hidden", name="is_new", value="1")

    saved = client.post(forms[0]["attrs"]["action"], data={"is_new": "1", "content": draft})
    assert saved.status_code == 302
    assert (data_dir / "boxes" / "box-002.md").read_text() == draft
    after = snapshot(data_dir)
    for path, value in before.items():
        assert after[path] == value


def test_new_box_is_only_created_when_its_editor_is_saved(storage):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.get("/new")
    assert response.status_code == 302
    target = urlsplit(response.headers["Location"])
    assert target.path == "/box/box-002/edit"
    assert parse_qs(target.query) == {"new": ["1"]}
    editor = client.get(response.headers["Location"])
    assert editor.status_code == 200
    document = Document(editor.get_data(as_text=True))
    assert document.find("input", type="hidden", name="is_new", value="1")
    assert snapshot(data_dir) == before
    saved = client.post(target.path, data={"content": "# Winter clothes\n\n- Coats\n", "is_new": "1"})
    assert saved.status_code == 302
    assert (data_dir / "boxes" / "box-002.md").read_text() == "# Winter clothes\n\n- Coats\n"
    after = snapshot(data_dir)
    for path, value in before.items():
        assert after[path] == value


def test_repeated_uploads_in_one_second_preserve_every_photo(storage, monkeypatch):
    module, client, data_dir = storage

    class SameSecond(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 1, 30, 12, 0, 0, tzinfo=tz)

    monkeypatch.setattr(module, "datetime", SameSecond)
    before = snapshot(data_dir)
    uploads = [picture_bytes("red"), picture_bytes("green")]
    for image in uploads:
        response = client.post("/box/box-001/photos", data={"photo": (io.BytesIO(image), "IMG_0001.JPG")})
        assert response.status_code == 302
    all_photos = list((data_dir / "photos" / "box-001").iterdir())
    assert len(all_photos) == 3
    assert len({photo.name for photo in all_photos}) == 3
    assert sorted(photo.read_bytes() for photo in all_photos) == sorted([
        before["photos/box-001/20260130_120000.jpg"][0], *uploads,
    ])
    after = snapshot(data_dir)
    for path, value in before.items():
        assert after[path] == value


def test_thumbnail_respects_phone_orientation_without_changing_original(storage):
    _, client, data_dir = storage
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6  # Phone orientation: rotate 90 degrees clockwise for display.
    with Image.new("RGB", (2000, 1000), "orange") as image:
        image.save(buffer, format="JPEG", exif=exif)
    original = buffer.getvalue()
    original_path = data_dir / "photos" / "box-001" / "phone-photo.jpg"
    original_path.write_bytes(original)
    before = snapshot(data_dir)
    url = "/box/box-001/photos/phone-photo.jpg"

    response = client.get(f"{url}?thumbnail=1")
    assert response.status_code == 200
    assert response.mimetype == "image/jpeg"
    with Image.open(io.BytesIO(response.data)) as preview:
        assert preview.size == (180, 360)
        assert preview.getexif().get(274) in (None, 1)
    assert len(response.data) < len(original)
    assert client.get(url).data == original
    cached = client.get(f"{url}?thumbnail=1", headers={"If-None-Match": response.headers["ETag"]})
    assert cached.status_code == 304
    assert cached.data == b""
    assert snapshot(data_dir) == before


def test_undecodable_thumbnail_keeps_original_available_and_unmodified(storage):
    _, client, data_dir = storage
    original = b"Unrecognised original photo bytes must remain available.\x00\xff"
    (data_dir / "photos" / "box-001" / "old-photo.jpg").write_bytes(original)
    before = snapshot(data_dir)
    url = "/box/box-001/photos/old-photo.jpg"
    response = client.get(f"{url}?thumbnail=1")
    assert response.status_code == 200
    assert response.mimetype == "image/svg+xml"
    assert b"Open original" in response.data
    original_response = client.get(url)
    assert original_response.status_code == 200
    assert original_response.data == original
    document = Document(client.get("/box/box-001").get_data(as_text=True))
    assert document.find("a", href=url + "/view")
    assert snapshot(data_dir) == before


def test_search_can_find_existing_box_number(storage):
    _, client, _ = storage
    response = client.get("/search?q=box-001")
    assert response.status_code == 200
    document = Document(response.get_data(as_text=True))
    assert document.find("a", href="/box/box-001")


def test_label_selection_preserves_explicit_choices(storage):
    _, client, data_dir = storage
    (data_dir / "boxes" / "box-002.md").write_text("# Coats and scarves\n")
    before = snapshot(data_dir)
    response = client.get("/labels?box=box-001")
    assert response.status_code == 200
    document = Document(response.get_data(as_text=True))
    checkboxes = document.find("input", type="checkbox", name="box")
    assert {node["attrs"]["value"] for node in checkboxes} == {"box-001", "box-002"}
    assert {
        node["attrs"]["value"] for node in checkboxes if "checked" in node["attrs"]
    } == {"box-001"}
    assert snapshot(data_dir) == before


@pytest.mark.parametrize("paper", ["letter", "a4"])
def test_bulk_labels_have_six_per_page_titles_ids_copies_and_canonical_qrs(storage, monkeypatch, paper):
    module, client, data_dir = storage
    titles = {"box-001": "Family photos & letters"}
    for number in range(2, 9):
        box_id = f"box-{number:03d}"
        # A long human-readable title must survive intact on the label.
        title = f"Family albums, loose photos and handwritten letters {number} — upstairs"
        titles[box_id] = title
        (data_dir / "boxes" / f"{box_id}.md").write_text(f"# {title}\n\n- Contents\n")
    chosen_ids = [f"box-{number:03d}" for number in range(1, 8)]
    qr_urls = []
    original_add_data = module.qrcode.QRCode.add_data

    def observe_payload(qr, data, *args, **kwargs):
        qr_urls.append(data)
        return original_add_data(qr, data, *args, **kwargs)

    monkeypatch.setattr(module.qrcode.QRCode, "add_data", observe_payload)
    before = snapshot(data_dir)
    response = client.get(
        "/labels/print",
        query_string=[*(('box', box_id) for box_id in chosen_ids), ("copies", "2"), ("paper", paper)],
        base_url="http://an-internal-proxy.invalid",
    )
    assert response.status_code == 200
    document = Document(response.get_data(as_text=True))
    pages = document.find("section", css_class="print-page")
    labels = document.find("article", css_class="print-label")
    assert [len(Document.within(page, "article", css_class="print-label")) for page in pages] == [6, 6, 2]
    assert len(labels) == 14
    actual_titles = Counter(
        Document.text(Document.within(label, css_class="label-title")[0]).strip()
        for label in labels
    )
    assert actual_titles == Counter({titles[box_id]: 2 for box_id in chosen_ids})
    actual_numbers = Counter(
        Document.text(Document.within(label, css_class="label-number")[0]).strip()
        for label in labels
    )
    assert actual_numbers == Counter({f"Box {box_id.removeprefix('box-')}": 2 for box_id in chosen_ids})
    for label in labels:
        qr_images = Document.within(label, "img")
        assert len(qr_images) == 1
        assert qr_images[0]["attrs"]["src"].startswith("data:image/png;base64,")
    assert set(qr_urls) == {f"https://box-storage.fly.dev/box/{box_id}" for box_id in chosen_ids}
    assert snapshot(data_dir) == before


@pytest.mark.parametrize("query", [
    "", "paper=letter&copies=2", "box=box-001&paper=legal", "box=box-001&copies=0",
    "box=box-001&copies=5", "box=box-001&copies=many", "box=box-001&box=box-999",
])
def test_invalid_or_empty_print_requests_never_print_everything_or_create_files(storage, query):
    _, client, data_dir = storage
    before = snapshot(data_dir)
    response = client.get(f"/labels/print?{query}")
    assert response.status_code == 400
    document = Document(response.get_data(as_text=True))
    assert not document.find("article", css_class="print-label")
    assert snapshot(data_dir) == before


def test_existing_downloaded_qr_still_points_to_original_public_box_url(storage, monkeypatch):
    module, client, data_dir = storage
    qr_urls = []
    original_add_data = module.qrcode.QRCode.add_data

    def observe_payload(qr, data, *args, **kwargs):
        qr_urls.append(data)
        return original_add_data(qr, data, *args, **kwargs)

    monkeypatch.setattr(module.qrcode.QRCode, "add_data", observe_payload)
    before = snapshot(data_dir)
    response = client.get("/box/box-001/qr", base_url="http://an-internal-proxy.invalid")
    assert response.status_code == 200
    assert response.mimetype == "image/png"
    assert qr_urls == ["https://box-storage.fly.dev/box/box-001"]
    image = Image.open(io.BytesIO(response.data))
    assert image.format == "PNG"
    assert image.width == image.height and image.width >= 200
    assert snapshot(data_dir) == before
