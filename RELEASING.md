# Releasing

This repository uses `semantic-release` with GitHub Actions.

## Release flow

1. Push commits to `main` (or `master`).
2. GitHub Actions runs tests (`.github/workflows/release.yml` -> `test` job).
3. If tests pass, the `release` job runs `semantic-release`.
4. `semantic-release` creates:
   - a Git tag (`vX.Y.Z`)
   - a GitHub Release with generated notes

Docker Hub can then pick up the tag/release directly.

## Commit message convention

Use Conventional Commits so semantic-release can determine version bumps:

- `fix: ...` -> patch release
- `feat: ...` -> minor release
- `feat!: ...` or commit body containing `BREAKING CHANGE:` -> major release
- `docs: ...`, `chore: ...`, `refactor: ...` without breaking change -> usually no release

## Manual release trigger

You can also trigger the release workflow manually using `workflow_dispatch` in GitHub Actions.
