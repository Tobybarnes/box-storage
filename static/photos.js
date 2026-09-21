(() => {
    'use strict';
    const input = document.getElementById('photo-input');
    if (!input) return;
    const form = document.getElementById('photo-form');
    const preview = document.getElementById('photo-preview');
    const image = document.getElementById('preview-img');
    const name = document.getElementById('preview-name');
    const button = document.getElementById('upload-button');
    let imageUrl;

    input.addEventListener('change', () => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        const file = input.files[0];
        preview.hidden = !file;
        if (!file) return;
        imageUrl = URL.createObjectURL(file);
        image.src = imageUrl;
        name.textContent = file.name;
    });
    form.addEventListener('submit', () => {
        button.disabled = true;
        button.textContent = 'Uploading…';
        form.setAttribute('aria-busy', 'true');
    });
    window.addEventListener('pageshow', () => {
        button.disabled = false;
        button.textContent = 'Upload photo';
        form.removeAttribute('aria-busy');
    });
})();
