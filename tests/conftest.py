import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
PAY_TO = "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _start(env_extra: dict) -> tuple[subprocess.Popen, str]:
    port = _free_port()
    env = {**os.environ, "PAY_TO": PAY_TO, **env_extra}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(80):
        try:
            if httpx.get(base + "/health", timeout=1).status_code == 200:
                return proc, base
        except Exception:
            pass
        if proc.poll() is not None:
            raise RuntimeError(proc.stdout.read().decode())
        time.sleep(0.25)
    proc.kill()
    raise RuntimeError("server did not start")


@pytest.fixture(scope="session")
def paid_server():
    """Real server with the x402 payment gate ON (PayAI facilitator, Base mainnet)."""
    proc, base = _start({"X402_DISABLED": "0", "PUBLIC_BASE_URL": "https://stillcurrent.example"})
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture(scope="session")
def test_server():
    """Real server in TEST MODE (payment gate OFF) for endpoint-logic tests."""
    proc, base = _start({"X402_DISABLED": "1"})
    yield base
    proc.terminate()
    proc.wait(10)
