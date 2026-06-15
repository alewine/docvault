"""Central configuration: env loading, logger, and cross-cutting constants.

Every other backend module imports its constants from here. Keeping this module
dependency-free (stdlib + dotenv only) is what prevents circular imports across
the package.
"""

import atexit
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

# App-wide single-worker executor. Shared by the background loops (jobs.py and
# email_ingest.py) and every blocking endpoint, so all blocking work serializes
# through one thread. Process-wide singleton initialized once at module load.
# The atexit hook tears the worker down with wait=False so the interpreter
# doesn't block on draining the non-daemon thread on exit (was ~40s on pytest
# teardown); uvicorn dying just kills the process, so no production cleanup
# semantics are lost.
_executor = ThreadPoolExecutor(max_workers=1)
atexit.register(_executor.shutdown, wait=False)

logger = logging.getLogger("docvault")
logger.setLevel(logging.DEBUG)
_log_handler = logging.StreamHandler()
_log_handler.setLevel(logging.DEBUG)
_log_handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s - %(message)s"))
logger.addHandler(_log_handler)
logger.propagate = False  # avoid double-printing via root

NAS_PATH = Path(os.getenv("DOCVAULT_STORAGE_PATH", str(Path.home() / "Documents" / "DocVault")))
APP_SUPPORT = Path.home() / "Library" / "Application Support" / "docvault"
DB_DIR = APP_SUPPORT / "db"
DB_PATH = DB_DIR / "metadata.sqlite"
OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "nomic-embed-text"
LLM_MODEL = "llama3.1:8b"

# Provider-agnostic IMAP email ingest. Configure via these env vars (e.g. in backend/.env):
#   EMAIL_ADDRESS=your-docvault-address@gmx.com
#   EMAIL_PASSWORD=your-gmx-password
#   IMAP_HOST=imap.gmx.com   (default, override for other providers)
#   IMAP_PORT=993             (default)
#   EMAIL_POLL_INTERVAL_SECONDS=300
# The old GMAIL_ADDRESS, GMAIL_APP_PASSWORD, and GMAIL_POLL_INTERVAL_SECONDS env
# vars are superseded by EMAIL_ADDRESS / EMAIL_PASSWORD / EMAIL_POLL_INTERVAL_SECONDS.
EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS", "")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD", "")
EMAIL_POLL_INTERVAL_SECONDS = int(os.getenv("EMAIL_POLL_INTERVAL_SECONDS", "300"))
IMAP_HOST = os.getenv("IMAP_HOST", "imap.gmx.com")
IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))
EMAIL_PROCESSED_FOLDER = os.getenv("EMAIL_PROCESSED_FOLDER", "Archive")
EMAIL_REJECTED_FOLDER = os.getenv("EMAIL_REJECTED_FOLDER", "Junk")
ALLOWED_SENDERS_ENV = os.getenv("ALLOWED_SENDERS", "")
# Inline-image rescue: forwarded phone screenshots are often embedded inline
# (Content-ID set, or Content-Disposition: inline) rather than as real
# attachments. When a message has no accepted attachments, we rescue inline
# images that pass these size/dimension gates — large enough to be a real
# screenshot, not a signature logo or tracking pixel.
EMAIL_INLINE_IMAGE_MIN_BYTES = int(os.getenv("EMAIL_INLINE_IMAGE_MIN_BYTES", "25000"))
EMAIL_INLINE_IMAGE_MIN_DIM = int(os.getenv("EMAIL_INLINE_IMAGE_MIN_DIM", "400"))

# Auto-cleanup of orphaned processed files (never touches originals/)
AUTO_CLEANUP_INTERVAL_SECONDS = int(os.getenv("DOCVAULT_AUTO_CLEANUP_INTERVAL_SECONDS", str(24 * 60 * 60)))
AUTO_CLEANUP_STARTUP_DELAY_SECONDS = int(os.getenv("DOCVAULT_AUTO_CLEANUP_STARTUP_DELAY_SECONDS", "120"))

SUPPORTED_EXTENSIONS = {
    ".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif",
    ".txt", ".csv", ".docx", ".xlsx", ".pptx",
    ".mp3", ".wav", ".json",
}
TEXT_BASED_EXTENSIONS = {".txt", ".csv", ".docx", ".xlsx", ".pptx", ".json"}
AUDIO_EXTENSIONS = {".mp3", ".wav"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif"}
VALID_CATEGORIES = {"Medical", "Insurance", "Financial", "Legal", "Home", "Education", "Other", "Audio"}
ALLOWED_CATEGORIES = VALID_CATEGORIES  # alias used in category-enforcement logic

_DEFAULT_CATEGORIES = ["Audio", "Education", "Financial", "Home", "Insurance", "Legal", "Medical", "Other"]
