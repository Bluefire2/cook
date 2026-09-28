---
name: i18n-visual-review
description: "Pre-PR in-context translation review for Sous. Follow docs/i18n-review/README.md. Not part of the iteration loop."
---

# In-context translation review (Cursor)

Follow `docs/i18n-review/README.md`. Do not restate the rubric, the
read-only rules, or the manifest.

This skill is not part of the iteration loop. Run it once, when the task's
implementation is complete and the PR may be ready to merge, before opening
the PR. Do not run it after each change.

Cursor specifics:

- Cloud agents capture screenshots through the `computerUse` subagent.
- Review through a subagent given the images as file attachments.
- Write the report to `/opt/cursor/artifacts/i18n-review/<date>.md` (`YYYY-MM-DD`)
  so it is uploaded. Do not use `.i18n-review/` for that Cursor report.
