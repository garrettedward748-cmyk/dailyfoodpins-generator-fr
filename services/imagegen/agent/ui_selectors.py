"""Where things are on Flow's page, for driving it by clicking.

Flow's markup changes without notice. These live in a file rather than in the
extension so a change can be followed without rebuilding the image: put a
ui_selectors.json in the data folder (FLOW_AGENT_DIR) with only the keys that
moved, and the next job uses it. The extension keeps its own copy of the
defaults for a call that arrives without any.
"""
import json
import logging
from pathlib import Path

from agent.config import BASE_DIR

logger = logging.getLogger(__name__)

DEFAULTS_PATH = Path(__file__).parent / "ui_selectors.json"
OVERRIDE_PATH = BASE_DIR / "ui_selectors.json"


def ui_selectors() -> dict:
    with open(DEFAULTS_PATH) as f:
        selectors = json.load(f)
    if OVERRIDE_PATH != DEFAULTS_PATH and OVERRIDE_PATH.exists():
        try:
            override = json.loads(OVERRIDE_PATH.read_text())
            selectors.update({k: v for k, v in override.items() if isinstance(v, str) and v})
        except (OSError, ValueError) as exc:
            logger.warning("Ignoring unreadable %s: %s", OVERRIDE_PATH, exc)
    return selectors
