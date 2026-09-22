# Changelog

## [Unreleased]

No changes recorded yet.

## [2.06] - 2026-09-22

- Added a camera session for each box: take several photos without reopening the camera, see captured thumbnails, and return with Done.
- Photos upload automatically with progress and saved confirmation. The photo library accepts multiple selections, and the box gallery updates without a page reload.
- Interrupted uploads retain a recovery copy on the same device when browser storage is available. Reopening that box resumes uploads; failed photos can be retried or downloaded. Retrying an upload cannot duplicate or overwrite a photo.
- Added phone-camera and library fallbacks, camera pause/resume, and warnings when a pending photo has no recovery copy. Saved photo previews release their full image data to keep memory use down.
- Existing notes and photo originals remain unchanged. Keep the app open until uploads finish; browser recovery storage is not a permanent backup, and uploads do not continue after the app closes. Library files support JPG, PNG, GIF and WebP up to 15 MB each; HEIC is not supported. The repeated-shot camera has been checked with a simulated camera; physical iPhone Home Screen testing remains outstanding.

## [2.05] - 2026-09-21

- Aligned the editor with the box view and site header, removing the sideways jump when opening or leaving Edit box.

## [2.04] - 2026-09-21

- Existing box titles and notes save automatically after typing pauses, with saving and saved feedback. Done and other in-app links finish pending saves before leaving.
- Unsaved drafts are kept on the same device when browser storage is available. Connection failures show a retry option; conflicting edits let you review the saved text before choosing which version to keep.
- Saves preserve untouched text and line endings, and detect stale edits before replacing a note. Photos remain attached and unchanged.
- New boxes still use Create box. A manual save remains available if JavaScript cannot load.

## [2.03] - 2026-09-21

- Photo rotation now saves automatically. Reopening a photo and viewing its thumbnail use the saved orientation.
- Reset restores the original orientation. Every rotation starts from the untouched original and saves a separate image, avoiding repeated compression.
- Added saving feedback and recovery for failed saves. Existing phone photos with embedded auxiliary images are supported.
- Changed headings to Helvetica Neue/Helvetica at bold weight, with Arial as the fallback.

## [2.02] - 2026-09-21

First documented release, collecting the updates shipped on this date:

- Refreshed the responsive interface with a numbered box list, compact photo indicators, and a new app icon and favicon.
- Added formatted Markdown viewing and a visual editor with title editing, basic formatting, Undo/Redo, and a raw-text fallback. Unchanged saves and title-only edits preserve the original body text.
- Added bulk QR labels with human-readable box numbers and titles, 1–4 copies, and six-label Letter/A4 layouts for printing or saving as PDF.
- Added an in-app full-size photo viewer with a Close control, so photos opened from the Safari home-screen app have a way back to their box.
- Added Rotate left, Rotate right, and Reset to the photo viewer. Rotation changes the current view only and leaves the original photo unchanged.
- Extended search to include box numbers and prevented missing box URLs from creating empty records.
- Set the displayed version to 2.02 and added a release workflow to keep the app version, changelog, Git tag, and GitHub release aligned.

Existing box IDs, URLs, Markdown files, and original photos remain in place. Earlier changes are recorded in the repository's commit history.

[Unreleased]: https://github.com/Tobybarnes/box-storage/compare/v2.06...HEAD
[2.06]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.06
[2.05]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.05
[2.04]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.04
[2.03]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.03
[2.02]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.02
