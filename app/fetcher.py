"""Safe HTTP fetching with manual redirect handling and SSRF protection.

Every hop (initial URL and each redirect target) is resolved and refused if any
resolved address is not globally routable (loopback, RFC1918, link-local,
cloud metadata, etc.). Bodies are size-capped and requests are time-capped.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

import httpx

from .config import settings

MAX_REDIRECTS = 10
DEFAULT_TIMEOUT = 15.0


class BlockedTarget(Exception):
    """The URL points at a non-public address or a disallowed scheme/port."""


@dataclass
class Hop:
    url: str
    status: int | None
    location: str | None = None


@dataclass
class FetchResult:
    requested_url: str
    final_url: str | None = None
    status: int | None = None
    hops: list[Hop] = field(default_factory=list)
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    truncated: bool = False
    error: str | None = None          # machine code: dns_error, connect_error, timeout, tls_error, blocked_target, too_many_redirects, ...
    error_detail: str | None = None
    elapsed_ms: int = 0

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";")[0].strip().lower()

    @property
    def charset(self) -> str | None:
        ct = self.headers.get("content-type", "")
        for part in ct.split(";")[1:]:
            k, _, v = part.strip().partition("=")
            if k.lower() == "charset" and v:
                return v.strip('"\' ')
        return None

    def text(self) -> str:
        enc = self.charset or "utf-8"
        try:
            return self.body.decode(enc, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")


def _is_public_ip(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return bool(addr.is_global) and not addr.is_multicast


async def assert_public_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise BlockedTarget(f"scheme '{parts.scheme}' not allowed (http/https only)")
    host = parts.hostname
    if not host:
        raise BlockedTarget("URL has no host")
    if parts.username or parts.password:
        raise BlockedTarget("credentials in URL are not allowed")
    if settings.allow_private_targets:
        return
    if host.lower() in {"localhost", "localhost.localdomain"} or host.lower().endswith((".local", ".internal", ".localhost")):
        raise BlockedTarget("local hostnames are not allowed")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise _DNSError(str(e)) from e
    ips = {info[4][0] for info in infos}
    if not ips:
        raise _DNSError("no addresses")
    if all(ipaddress.ip_address(ip) in _FAKE_IP_NET for ip in ips):
        # Sandboxed egress (fake-IP DNS, 198.18.0.0/15): the local resolver cannot tell us the real
        # addresses, so ask a public DNS-over-HTTPS resolver instead.
        ips = await _doh_resolve(host)
    for ip in ips:
        if not _is_public_ip(ip):
            raise BlockedTarget("host resolves to a non-public address")


_FAKE_IP_NET = ipaddress.ip_network("198.18.0.0/15")
_DOH_URL = "https://cloudflare-dns.com/dns-query"


async def _doh_resolve(host: str) -> set[str]:
    try:
        ipaddress.ip_address(host)
        return {host}
    except ValueError:
        pass
    ips: set[str] = set()
    async with httpx.AsyncClient(timeout=6.0) as c:
        for rtype in ("A", "AAAA"):
            r = await c.get(_DOH_URL, params={"name": host, "type": rtype}, headers={"accept": "application/dns-json"})
            data = r.json()
            if data.get("Status") == 3:
                raise _DNSError("NXDOMAIN (domain does not exist)")
            if data.get("Status") not in (0, None):
                raise _DNSError(f"DNS error status {data.get('Status')}")
            for ans in data.get("Answer") or []:
                if ans.get("type") in (1, 28):
                    ips.add(ans["data"])
    if not ips:
        raise _DNSError("no A/AAAA records")
    return ips


class _DNSError(Exception):
    pass


async def fetch(
    url: str,
    *,
    max_bytes: int = 2_000_000,
    timeout: float = DEFAULT_TIMEOUT,
    user_agent: str | None = None,
    client: httpx.AsyncClient | None = None,
    accept: str | None = None,
) -> FetchResult:
    """GET a URL, following up to MAX_REDIRECTS redirects manually (each hop is SSRF-checked)."""
    res = FetchResult(requested_url=url)
    t0 = time.monotonic()
    headers = {"User-Agent": user_agent or settings.user_agent}
    if accept is None:
        headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7"
        headers["Accept-Language"] = "en;q=0.9,*;q=0.5"
    else:
        headers["Accept"] = accept
    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(timeout, connect=8.0), http2=False)
    try:
        current = url
        deadline = t0 + timeout + 5
        for _ in range(MAX_REDIRECTS + 1):
            try:
                await assert_public_url(current)
            except BlockedTarget as e:
                res.error, res.error_detail = "blocked_target", str(e)
                return res
            except _DNSError as e:
                res.error, res.error_detail = "dns_error", str(e)
                res.hops.append(Hop(current, None))
                return res
            remaining = max(1.0, deadline - time.monotonic())
            try:
                async with client.stream("GET", current, headers=headers, timeout=min(timeout, remaining)) as resp:
                    loc = resp.headers.get("location")
                    res.hops.append(Hop(current, resp.status_code, loc))
                    if resp.status_code in (301, 302, 303, 307, 308) and loc:
                        current = urljoin(current, loc)
                        continue
                    res.final_url = str(resp.url)
                    res.status = resp.status_code
                    res.headers = {k.lower(): v for k, v in resp.headers.items()}
                    buf = bytearray()
                    async for chunk in resp.aiter_bytes():
                        buf.extend(chunk)
                        if len(buf) >= max_bytes:
                            res.truncated = True
                            break
                    res.body = bytes(buf[:max_bytes])
                    return res
            except httpx.TimeoutException as e:
                res.error, res.error_detail = "timeout", type(e).__name__
            except httpx.ConnectError as e:
                msg = str(e)
                res.error = "tls_error" if ("SSL" in msg or "certificate" in msg.lower()) else "connect_error"
                res.error_detail = msg[:300]
            except httpx.HTTPError as e:
                res.error, res.error_detail = "http_error", f"{type(e).__name__}: {str(e)[:300]}"
            res.hops.append(Hop(current, None))
            return res
        res.error, res.error_detail = "too_many_redirects", f">{MAX_REDIRECTS} redirects"
        return res
    finally:
        res.elapsed_ms = int((time.monotonic() - t0) * 1000)
        if own_client:
            await client.aclose()
