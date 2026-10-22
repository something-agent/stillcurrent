"""Runtime configuration, all from environment variables."""
from __future__ import annotations

import os
import re

_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        # Public receive address only. No private keys are ever needed by a seller.
        self.pay_to: str = os.environ.get("PAY_TO", "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700")
        if not _ADDR_RE.match(self.pay_to):
            raise ValueError("PAY_TO must be a 0x-prefixed 20-byte EVM address")
        # CAIP-2 network id. eip155:8453 = Base mainnet (USDC). eip155:84532 = Base Sepolia.
        self.network: str = os.environ.get("X402_NETWORK", "eip155:8453")
        # PayAI facilitator: no account / API key needed (1,000 free settlements per payTo).
        self.facilitator_url: str = os.environ.get("FACILITATOR_URL", "https://facilitator.payai.network")
        self.price_url_check: str = os.environ.get("PRICE_URL_CHECK", "$0.01")
        self.price_citation_check: str = os.environ.get("PRICE_CITATION_CHECK", "$0.02")
        # Public base URL (https://...) used in discovery documents. Falls back to request URL.
        # On Render, RENDER_EXTERNAL_URL (https://<service>.onrender.com) is set automatically and used as a fallback.
        self.public_base_url: str | None = (os.environ.get("PUBLIC_BASE_URL") or os.environ.get("RENDER_EXTERNAL_URL") or None)
        # TEST MODE: disables the payment gate entirely. Never set this on a public deployment.
        self.payments_disabled: bool = _bool("X402_DISABLED", False)
        # Allow fetching private/loopback addresses (only for local tests).
        self.allow_private_targets: bool = _bool("ALLOW_PRIVATE_TARGETS", False)
        self.demo_enabled: bool = _bool("DEMO_ENABLED", True)
        # Operator contact email: shown in OpenAPI info.contact (x402scan) and in the outbound User-Agent.
        self.contact_email: str | None = os.environ.get("CONTACT_EMAIL") or None
        # Many sites (e.g. Wikimedia) reject bot UAs without a contact URL/email.
        _contact_parts = [self.public_base_url or "https://github.com/something-agent/stillcurrent"]
        if self.contact_email:
            _contact_parts.append(self.contact_email)
        self.bot_contact: str = os.environ.get("BOT_CONTACT") or "; ".join(_contact_parts)
        self.user_agent: str = os.environ.get(
            "FETCH_USER_AGENT",
            f"Mozilla/5.0 (compatible; StillCurrentBot/0.1; link and citation checker; +{self.bot_contact})",
        )


settings = Settings()
