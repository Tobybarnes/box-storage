# Box Storage releases

Keep the app version, changelog, Git tag, and GitHub release aligned whenever publishing an app update.

- Use `VERSION` in `app.py` as the app's version source. Preserve the `2.02` display format and increment it for the next app release, unless the user requests a different version. Update `BUILD_DATE` to the release date.
- Add a dated entry to `CHANGELOG.md` describing the changes shipped in that release. Include limitations that affect use, such as photo rotation being view-only. Do not describe planned work as shipped.
- Run the existing checks appropriate to the change, review the scoped diff, and commit only the intended files. Verify the GitHub account is `Tobybarnes` before pushing, then confirm local and remote commit hashes match.
- Preserve the existing Fly data volume and every original note and photo. Use disposable data for tests. Compare live file hashes before and after deployment; never replace live data with a preview copy.
- Verify the deployed app and displayed version before creating the matching `v<version>` tag and GitHub release. Tag the verified deployment commit and use the corresponding changelog entry as the release notes. Never move an existing release tag to a different commit.
- Documentation-only changes do not need an app version bump or deployment.
