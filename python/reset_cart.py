"""Empty the authenticated McMaster cart via the audited cart workflow.

Backward-compatible entry point: runs add_cached_to_cart.py in reset-only
mode, which enforces the David account check and saves stamped checkpoint
artifacts under runtime/sessions/.
"""

from __future__ import annotations

import sys

from add_cached_to_cart import main


if __name__ == "__main__":
    sys.argv[1:1] = ["--reset-only"]
    main()
