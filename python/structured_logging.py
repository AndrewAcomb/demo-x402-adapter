"""Fixed-column structured stdout/stderr logging for demo workflows."""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path


ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
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

    def __init__(self, logger: logging.Logger, level: int) -> None:
        self.logger = logger
        self.level = level
        self.buffer = ""

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
    terminal = logging.StreamHandler(sys.__stdout__)
    terminal.setFormatter(formatter)
    terminal.addFilter(context_filter)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.addFilter(context_filter)
    logger.addHandler(terminal)
    logger.addHandler(file_handler)

    sys.stdout = LoggingStream(logger, logging.INFO)  # type: ignore[assignment]
    sys.stderr = LoggingStream(logger, logging.ERROR)  # type: ignore[assignment]
