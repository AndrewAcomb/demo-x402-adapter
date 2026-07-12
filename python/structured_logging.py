"""Fixed-column structured stdout/stderr logging for demo workflows."""

from __future__ import annotations

import atexit
import logging
import os
import re
import sys
import threading
import time
import urllib.parse
from pathlib import Path


ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def hyperlink(label: str, target: str | Path) -> str:
    """OSC 8 terminal hyperlink."""
    uri = str(target)
    if "://" not in uri:
        uri = "file://" + urllib.parse.quote(str(Path(uri).resolve()))
    return f"\x1b]8;;{uri}\x1b\\{label}\x1b]8;;\x1b\\"


class DemoConsole:
    """A spinner plus at most a dozen curated key lines on the real terminal.

    Inactive by default; every method is a no-op until start() runs, so call
    sites never need to check the console mode themselves.
    """

    def __init__(self) -> None:
        self._stream = None
        self._status = ""
        self._lock = threading.Lock()
        self._started_monotonic = 0.0
        self._stop_event = threading.Event()
        self._spin_generation = 0

    @property
    def active(self) -> bool:
        return self._stream is not None

    def start(self, stream) -> None:
        if self._stream is not None:
            return
        self._stream = stream
        self._started_monotonic = time.monotonic()
        self._start_spinner()
        atexit.register(self.stop)

    def _start_spinner(self) -> None:
        self._stop_event.clear()
        self._spin_generation += 1
        threading.Thread(
            target=self._spin, args=(self._spin_generation,), daemon=True
        ).start()

    def _spin(self, generation: int) -> None:
        index = 0
        while not self._stop_event.wait(0.12):
            with self._lock:
                if self._stream is None or generation != self._spin_generation:
                    return
                elapsed = int(time.monotonic() - self._started_monotonic)
                frame = SPINNER_FRAMES[index % len(SPINNER_FRAMES)]
                line = f"{frame} {elapsed // 60:02d}:{elapsed % 60:02d}  {self._status}"
                self._stream.write("\r\x1b[2K" + line[:160])
                self._stream.flush()
            index += 1

    def pause(self) -> None:
        """Silence the spinner (e.g. while the operator types); resume() restarts it."""
        if not self.active:
            return
        self._stop_event.set()
        with self._lock:
            if self._stream is not None:
                self._stream.write("\r\x1b[2K")
                self._stream.flush()

    def resume(self) -> None:
        if not self.active:
            return
        self._start_spinner()

    def status(self, text: str) -> None:
        """Update the transient spinner label (not a printed line)."""
        if self.active:
            self._status = " ".join(str(text).split())

    def key(
        self,
        text: str,
        *,
        link_label: str | None = None,
        link_target: str | Path | None = None,
    ) -> None:
        """Print one durable milestone line above the spinner."""
        if not self.active:
            return
        message = " ".join(str(text).split())
        if link_label and link_target:
            suffix = hyperlink(f"[{link_label}]", link_target)
            message = f"{message}  {suffix}" if message else suffix
        with self._lock:
            if self._stream is None:
                return
            self._stream.write("\r\x1b[2K" + message + "\n")
            self._stream.flush()

    def stop(self, final_text: str | None = None) -> None:
        if not self.active:
            return
        self._stop_event.set()
        with self._lock:
            stream, self._stream = self._stream, None
            stream.write("\r\x1b[2K")
            if final_text:
                stream.write(" ".join(final_text.split()) + "\n")
            stream.flush()


console = DemoConsole()
FORMAT = (
    "%(asctime)s.%(msecs)03d  %(session_id)-4s  %(request_id)-4s  "
    "%(component)24s - %(message)s"
)


def classify(message: str) -> str:
    lowered = message.casefold()
    if any(
        marker in lowered
        for marker in (
            "[agent]",
            "[action]",
            "[result]",
            "[page]",
            "[state]",
            "[metrics]",
            "[answer]",
            "[step error]",
        )
    ):
        return "HHStream"
    if "h browser runtime:" in lowered or "h browser session" in lowered:
        return "HRuntime"
    return "Application"


def log_output(message: str, *, component: str, level: int = logging.INFO) -> None:
    """Emit a locally sourced message with an explicit, call-site-stable component."""
    logger = logging.getLogger("h402.output")
    if logger.handlers:
        logger.log(level, message, extra={"component": component})
    else:
        print(message, file=sys.__stderr__ if level >= logging.ERROR else sys.__stdout__)


class ContextFormatter(logging.Formatter):
    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        return super().formatTime(record, "%Y-%m-%d %H:%M:%S")


class LoggingStream:
    """Turn arbitrary print output into complete classified log records."""

    encoding = "utf-8"

    def __init__(self, logger: logging.Logger, level: int) -> None:
        self.logger = logger
        self.level = level
        self.buffer = ""

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def write(self, value: str) -> int:
        self.buffer += value
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self._emit(line)
        return len(value)

    def flush(self) -> None:
        if self.buffer:
            self._emit(self.buffer)
            self.buffer = ""
        for handler in self.logger.handlers:
            handler.flush()

    def _emit(self, line: str) -> None:
        clean = ANSI_ESCAPE.sub("", line).strip()
        if not clean:
            return
        self.logger.log(
            self.level,
            clean,
            extra={
                "component": "Error" if self.level >= logging.ERROR else classify(clean)
            },
        )


def configure_structured_output(
    log_path: Path,
    *,
    session_id: str,
    request_id: str,
) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("h402.output")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    logger.propagate = False

    formatter = ContextFormatter(FORMAT)
    class AddContext(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            record.session_id = session_id
            record.request_id = request_id
            if not hasattr(record, "component"):
                record.component = "Application"
            return True

    context_filter = AddContext()
    mode = os.environ.get("H402_CONSOLE", "").strip().casefold()
    if mode == "quiet":
        quiet = True
    elif mode == "verbose":
        quiet = False
    else:
        quiet = bool(sys.__stdout__ and sys.__stdout__.isatty())
    if not quiet:
        terminal = logging.StreamHandler(sys.__stdout__)
        terminal.setFormatter(formatter)
        terminal.addFilter(context_filter)
        logger.addHandler(terminal)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.addFilter(context_filter)
    logger.addHandler(file_handler)

    sys.stdout = LoggingStream(logger, logging.INFO)  # type: ignore[assignment]
    sys.stderr = LoggingStream(logger, logging.ERROR)  # type: ignore[assignment]

    if quiet and not console.active:
        console.start(sys.__stdout__)
        console.key(
            f"{session_id} · streaming full output to log",
            link_label="app.log",
            link_target=log_path,
        )
        previous_hook = sys.excepthook

        def _console_excepthook(exc_type, exc, tb) -> None:
            console.stop(f"✗ {exc_type.__name__}: {exc}")
            previous_hook(exc_type, exc, tb)

        sys.excepthook = _console_excepthook
