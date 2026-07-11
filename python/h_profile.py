"""Publish and resolve versioned H browser profiles for the hackathon demo."""

from __future__ import annotations

import json
import argparse
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

from hai_agents import Client
from hai_agents.types import BrowserNetwork


ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "profile-state.json"
ENV_PATH = ROOT / ".env"
CHROME_BINARY = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
CHROME_VERSION = "150.0.7871.115"
CHROME_ROOT = Path.home() / "Library/Application Support/Google/Chrome"
PROFILE_DIR = CHROME_ROOT / "Profile 7"
ARCHIVE_PATH = ROOT / "hackathon-chrome-user-data.zip"
PROFILE_PATTERN = re.compile(r"^hackathon0*(\d+)$")
ENV_ID_LINE = re.compile(r"^HAI_BROWSER_PROFILE_ID=.*$", re.MULTILINE)
ENV_NAME_LINE = re.compile(r"^HAI_BROWSER_PROFILE_NAME=.*$", re.MULTILINE)


def load_state() -> dict[str, object]:
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def newest_browser_profile_id(client: Client, name: str | None = None) -> str:
    state = load_state()
    profile_name = name or str(state["active_profile_name"])
    page = client.browser_profiles.list_browser_profiles(limit=100, offset=0)
    matches = [profile for profile in page.profiles if profile.name == profile_name]
    if not matches:
        raise RuntimeError(f"No finalized H browser profile named {profile_name!r} was found")

    newest = max(matches, key=lambda profile: profile.created_at)
    print(
        f"Using active H browser profile {profile_name!r}: "
        f"{newest.id} (created {newest.created_at})",
        flush=True,
    )
    return newest.id


def active_environment_network(client: Client) -> BrowserNetwork:
    """Return the tracked H environment's network config without logging secrets."""
    state = load_state()
    environment_id = str(state["environment_id"])
    environment = client.environments.get_environment(environment_id)
    if environment.kind != "web" or environment.network is None:
        raise RuntimeError(f"H environment {environment_id!r} has no browser network config")
    if environment.network.proxy_url:
        print(f"Using custom proxy configured on H environment {environment_id!r}.", flush=True)
    elif environment.network.managed_proxy:
        print(f"Using managed proxy configured on H environment {environment_id!r}.", flush=True)
    else:
        raise RuntimeError(f"H environment {environment_id!r} has an empty network config")
    return environment.network


def open_chrome() -> None:
    subprocess.Popen(
        [
            "/usr/bin/open",
            "-a",
            "Google Chrome",
            "--args",
            "--profile-directory=Profile 7",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(
        f"Opened Chrome profile {PROFILE_DIR}.\n"
        "Publishing will quit Chrome briefly so its databases are flushed.",
        flush=True,
    )


def quit_chrome() -> None:
    running = subprocess.run(
        ["pgrep", "-x", "Google Chrome"],
        stdout=subprocess.DEVNULL,
        check=False,
    ).returncode == 0
    if not running:
        return

    print("Quitting Chrome cleanly so Profile 7 databases are flushed...", flush=True)
    subprocess.run(["osascript", "-e", 'quit app "Google Chrome"'], check=True)
    for _ in range(20):
        still_running = subprocess.run(
            ["pgrep", "-x", "Google Chrome"],
            stdout=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
        if not still_running:
            return
        time.sleep(0.5)
    raise RuntimeError("Chrome did not quit within 10 seconds")


def rebuild_archive() -> None:
    if not PROFILE_DIR.is_dir():
        raise RuntimeError(f"Chrome profile directory does not exist: {PROFILE_DIR}")
    ARCHIVE_PATH.unlink(missing_ok=True)
    print(f"Creating {ARCHIVE_PATH.name} from Chrome Profile 7...", flush=True)
    with tempfile.TemporaryDirectory(prefix="h-profile-") as temporary:
        staging = Path(temporary)
        shutil.copytree(PROFILE_DIR, staging / "Default", symlinks=True)
        local_state = CHROME_ROOT / "Local State"
        if local_state.is_file():
            shutil.copy2(local_state, staging / "Local State")
        subprocess.run(
            ["/usr/bin/zip", "-r", "-q", str(ARCHIVE_PATH), "."],
            cwd=staging,
            check=True,
        )
    ARCHIVE_PATH.chmod(0o600)
    print(f"Archive size: {ARCHIVE_PATH.stat().st_size / 1024 / 1024:.1f} MiB", flush=True)


def next_profile(client: Client) -> tuple[int, str]:
    state = load_state()
    versions = [int(state["version"])]
    page = client.browser_profiles.list_browser_profiles(limit=100, offset=0)
    for profile in page.profiles:
        match = PROFILE_PATTERN.fullmatch(profile.name)
        if match:
            versions.append(int(match.group(1)))
    version = max(versions) + 1
    if version > 99:
        raise RuntimeError("Two-digit browser profile version space is exhausted")
    return version, f"hackathon{version:02d}"


def upload_archive(client: Client, profile_name: str) -> str:
    upload = client.browser_profiles.initiate_browser_profile_upload()
    print(f"Uploading {profile_name!r} as pending profile {upload.profile_id}...", flush=True)
    curl_args = [
        "/usr/bin/curl",
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--request",
        "POST",
        upload.upload_url,
    ]
    for key, value in upload.upload_fields.items():
        curl_args.extend(("--form-string", f"{key}={value}"))
    curl_args.extend(("--form", f"file=@{ARCHIVE_PATH};type=application/zip"))
    status = subprocess.check_output(curl_args, text=True).strip()
    if status != "204":
        raise RuntimeError(f"Profile storage upload returned HTTP {status}, expected 204")

    for delay_s in (0, 1, 2, 4, 8, 15):
        if delay_s:
            print(f"Waiting {delay_s}s for H storage to settle...", flush=True)
            time.sleep(delay_s)
        try:
            profile = client.browser_profiles.complete_browser_profile_upload(
                profile_id=upload.profile_id,
                name=profile_name,
                browser_name="chromium",
                browser_version=CHROME_VERSION,
                labels={"project": "hackathon", "source": "chrome-profile-7-as-default"},
            )
            return profile.id
        except Exception as exc:
            if "Upload not found in S3" not in str(exc) or delay_s == 15:
                raise
    raise RuntimeError("H did not complete the uploaded browser profile")


def confirm_finalized(client: Client, profile_id: str, profile_name: str) -> None:
    print("Upload completed; pausing to confirm it through H's profile-list API...", flush=True)
    for attempt in range(1, 7):
        page = client.browser_profiles.list_browser_profiles(limit=100, offset=0)
        if any(p.id == profile_id and p.name == profile_name for p in page.profiles):
            print(f"Confirmed finalized profile {profile_name!r} ({profile_id}).", flush=True)
            return
        print(f"Confirmation attempt {attempt}/6 not visible yet; waiting 2s...", flush=True)
        time.sleep(2)
    raise RuntimeError("New profile completed but was not confirmed by H's list API")


def sync_environment(client: Client, profile_id: str) -> None:
    state = load_state()
    environment_id = str(state["environment_id"])
    print(f"Updating H environment {environment_id!r} to the new profile...", flush=True)
    environment = client.environments.patch_environment(
        environment_id,
        browser_profile_id=profile_id,
        use_default_browser_profile=False,
        persist_browser_profile=True,
    )
    if environment.browser_profile_id != profile_id:
        raise RuntimeError(
            f"Environment {environment_id!r} did not confirm browser profile {profile_id}"
        )
    print(f"Confirmed environment {environment_id!r} uses profile {profile_id}.", flush=True)


def activate(version: int, profile_name: str, profile_id: str) -> None:
    previous = load_state()
    state = {
        "version": version,
        "active_profile_name": profile_name,
        "active_profile_id": profile_id,
        "environment_id": previous["environment_id"],
        "confirmed_at": datetime.now(UTC).isoformat(),
    }
    temporary = STATE_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    temporary.replace(STATE_PATH)

    contents = ENV_PATH.read_text(encoding="utf-8")
    contents = ENV_ID_LINE.sub(f"HAI_BROWSER_PROFILE_ID={profile_id}", contents)
    contents = ENV_NAME_LINE.sub(f"HAI_BROWSER_PROFILE_NAME={profile_name}", contents)
    ENV_PATH.write_text(contents, encoding="utf-8")
    ENV_PATH.chmod(0o600)


def publish() -> None:
    if not os.environ.get("HAI_API_KEY"):
        raise RuntimeError("HAI_API_KEY is not set; let direnv load this project first")

    client = Client()
    version, profile_name = next_profile(client)
    print(f"Next browser profile version: {version:02d} ({profile_name})", flush=True)
    quit_chrome()
    rebuild_archive()
    profile_id = upload_archive(client, profile_name)
    confirm_finalized(client, profile_id, profile_name)
    sync_environment(client, profile_id)
    activate(version, profile_name, profile_id)
    print(
        f"SUCCESS: {profile_name} is finalized and is now the active browser profile.\n"
        "Run `direnv reload` before starting the next browser session.",
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage the versioned H Chrome profile")
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open the dedicated Chrome user-data directory for login/setup instead of publishing",
    )
    args = parser.parse_args()
    if args.open:
        open_chrome()
        return
    try:
        publish()
    except Exception as exc:
        print(f"FAILURE: browser profile was not activated: {exc}", flush=True)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
