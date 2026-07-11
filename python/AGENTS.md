# Hackathon Agent Guide

This project uses `direnv` for its local Python environment and secrets.

- Before running project commands, ensure direnv has loaded `.envrc`. If the
  current process did not inherit direnv, run commands through
  `direnv exec . <command>`.
- Never print, inspect, commit, or copy values from `.env` into logs, source
  files, documentation, or responses.
- Run Python commands with `uv run python ...`; do not use bare Python, pip, or
  pytest commands.
- `HAI_API_KEY` is supplied by the ignored local `.env` file.
- McMaster credentials are supplied by ignored `MCMASTER_EMAIL` and
  `MCMASTER_PASSWORD` variables. Never print or commit their values.
- Email 2FA uses ignored `EMAIL_IMAP_*` variables. Never print mailbox
  credentials or extracted codes.
- `HAI_BROWSER_PROFILE_NAME` names the browser profile family. Runtime code
  enumerates finalized profiles and selects the newest matching upload.
- Use `uv run python h_profile.py --open` to open Chrome `Profile 7` for
  login/setup. Use `uv run python h_profile.py`
  to safely build, version, upload, confirm, and activate it afterward.
- McMaster catalog discovery must not add products to an order or begin checkout unless
  the user explicitly advances the demo to that stage.
