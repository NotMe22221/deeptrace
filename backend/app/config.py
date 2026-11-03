"""Runtime configuration (environment variables; see .env.example at the repo root)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DATASETS_DIR = BACKEND_DIR / "datasets"
REGIONS_DIR = DATASETS_DIR / "regions"
CACHE_DIR = DATASETS_DIR / "cache"
PUBLIC_DEMO_DIR = REPO_ROOT / "public" / "demo"


def _load_dotenv() -> None:
    """Minimal .env loader. Precedence (first wins): real environment variables >
    repo-root .env.local > repo-root .env > backend/.env. Blank values (e.g. the
    template line ``ANTHROPIC_API_KEY=``) are treated as unset."""
    for path in (REPO_ROOT / ".env.local", REPO_ROOT / ".env", BACKEND_DIR / ".env"):
        if not path.exists():
            continue
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and value and not os.environ.get(key):
                os.environ[key] = value


_load_dotenv()


@dataclass(frozen=True)
class Settings:
    region_id: str = field(default_factory=lambda: os.getenv("DEEPTRACE_REGION", "atlanta-downtown"))
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.getenv("DEEPTRACE_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
            if o.strip()
        )
    )
    llm_provider: str = field(default_factory=lambda: os.getenv("DEEPTRACE_LLM_PROVIDER", "anthropic"))
    llm_model: str = field(default_factory=lambda: os.getenv("DEEPTRACE_LLM_MODEL", "claude-opus-5-5"))
    llm_effort: str = field(default_factory=lambda: os.getenv("DEEPTRACE_LLM_EFFORT", "medium"))
    llm_max_tool_rounds: int = field(default_factory=lambda: int(os.getenv("DEEPTRACE_LLM_MAX_TOOL_ROUNDS", "8")))
    overpass_url: str = field(
        default_factory=lambda: os.getenv("DEEPTRACE_OVERPASS_URL", "https://overpass-api.de/api/interpreter")
    )

    @property
    def llm_available(self) -> bool:
        return self.llm_provider == "anthropic" and bool(
            os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
