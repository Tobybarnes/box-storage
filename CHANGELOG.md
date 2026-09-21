# Changelog

## [Unreleased]

No changes recorded yet.

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

[Unreleased]: https://github.com/Tobybarnes/box-storage/compare/v2.03...HEAD
[2.03]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.03
[2.02]: https://github.com/Tobybarnes/box-storage/releases/tag/v2.02
