import os
import sys
from pathlib import Path

# Ensure repo root, scripts/ and collectors package are on sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
COLETOR_DIR = REPO_ROOT / "services" / "coletor-externo"

for p in [str(REPO_ROOT), str(SCRIPTS_DIR), str(COLETOR_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)
