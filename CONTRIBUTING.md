# Contributing to EFTForge

## Setup

Follow the [Getting Started](README.md#getting-started) section in the README to get
the backend and frontend running locally. For contributing changes, install the dev
dependencies instead of the runtime-only ones:

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements-dev.txt
```

`requirements-dev.txt` includes everything in `requirements.txt` plus the tools
described below (black, flake8, mypy, pytest).

## Before opening a PR

### Backend

```bash
cd backend
python -m black . --exclude venv --check   # formatting
python -m flake8 .                          # linting
python -m mypy .                            # type checking (informational, CI doesn't block on it yet)
python -m pytest tests/ -v                  # tests
```

### Frontend

```bash
cd frontend
npm ci
npm run lint   # eslint
```

CI runs all of the above (except mypy, which is non-blocking for now, see the comment
in `.github/workflows/ci.yml`) on every push and PR. A red check means something needs
fixing before merge.

### Optional: pre-commit hooks

If you'd rather catch formatting/lint issues before you commit instead of after you
push, install [pre-commit](https://pre-commit.com/):

```bash
pip install pre-commit
pre-commit install
```

This runs black, flake8, and eslint automatically on `git commit`.

## Code style

- Backend: formatted with `black` (line length 120, see `pyproject.toml`), linted with
  `flake8` (see `.flake8` for the handful of intentionally-ignored rules and why).
- Frontend: linted with `eslint` (see `.eslintrc.json`). The codebase uses classic
  `<script>` tags sharing a global scope, not ES modules, cross-file functions are
  declared as ESLint globals rather than imported.
- `.editorconfig` sets indent style/size and line endings for editors that support it.

## Tests

Backend tests live in `backend/tests/` and currently cover the EvoErgo/EED/arm-stamina
calculation formulas, since those are duplicated between the backend and
`frontend/app.js` and need to stay in sync. There's no frontend test suite yet.

## Commit messages

Focus on *why* a change was made, not just what changed.

## Build date

When your PR is ready to merge, please bump `APP_BUILD_DATE` in
`frontend/modules/config.js` to the current time with `new Date().toISOString()`.

## Release notes / news posts

Contributors should never add or edit anything under `frontend/news/` (posts,
`manifest.json`) as part of a feature or fix PR. Release notes,
version bumps, and the news feed are written and published by Morph1ne **only**, after
a change has actually shipped. If your PR includes changes in that directory, expect
to be asked to remove them before merge.

## Reporting bugs / requesting features

Open a GitHub issue. For security vulnerabilities, see [SECURITY.md](SECURITY.md)
instead, please don't file those as public issues.
