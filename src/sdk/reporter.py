"""
agennect-open SDK — Mode B invocation reporter (Python).

Copy this file into your agent or orchestrator project. Uses httpx when
available, falls back to urllib.request from the stdlib.

Usage:
    from reporter import AgennectReporter

    reporter = AgennectReporter(
        "http://localhost:3000", caller_id="my-orchestrator"
    )

    # Option A: let the SDK invoke and report for you.
    result = reporter.invoke(
        agent_id="dataoracle-x7k2",
        endpoint_url="https://myagent.com/tasks",
        payload={"message": {"parts": [{"type": "text",
                                         "text": "Analyze Q1 data"}]}}
    )

    # Option B: report manually if you handled the invocation yourself.
    reporter.report(
        agent_id="dataoracle-x7k2",
        latency_ms=340,
        status="success",
        request_size=512,
        response_size=1024,
    )
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import quote

try:
    import httpx
    _HTTP = "httpx"
except ImportError:
    import urllib.request
    _HTTP = "urllib"


class AgennectReporter:
    def __init__(
        self,
        registry_url: str,
        caller_id: Optional[str] = None,
        report_timeout: float = 5.0,
        invoke_timeout: float = 30.0,
    ) -> None:
        if not registry_url:
            raise ValueError("registry_url is required")
        self.registry_url = registry_url.rstrip("/")
        self.caller_id = caller_id
        self.report_timeout = report_timeout
        self.invoke_timeout = invoke_timeout

    def invoke(
        self,
        agent_id: str,
        endpoint_url: str,
        payload: Dict[str, Any],
        auth_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Invoke an agent directly and report metrics. Returns the agent's parsed JSON response."""
        if not agent_id:
            raise ValueError("agent_id is required")
        if not endpoint_url:
            raise ValueError("endpoint_url is required")

        headers = {"Content-Type": "application/json"}
        if auth_headers:
            headers.update(auth_headers)

        body = json.dumps(payload or {}).encode()
        request_size = len(body)

        start = time.time()
        status = "error"
        error_msg: Optional[str] = None
        result: Optional[Dict[str, Any]] = None
        response_size: Optional[int] = None

        try:
            if _HTTP == "httpx":
                with httpx.Client() as client:
                    res = client.post(
                        endpoint_url,
                        content=body,
                        headers=headers,
                        timeout=self.invoke_timeout,
                    )
                    text = res.text
                    response_size = len(text.encode())
                    if res.is_success:
                        status = "success"
                        try:
                            result = res.json()
                        except Exception:
                            result = {"text": text}
                    else:
                        error_msg = f"HTTP {res.status_code}"
            else:
                req = urllib.request.Request(
                    endpoint_url, data=body, headers=headers, method="POST"
                )
                with urllib.request.urlopen(req, timeout=self.invoke_timeout) as res:
                    text = res.read().decode()
                    response_size = len(text.encode())
                    status = "success"
                    try:
                        result = json.loads(text)
                    except Exception:
                        result = {"text": text}
        except Exception as e:
            status = "timeout" if "timeout" in str(e).lower() else "error"
            error_msg = str(e)

        latency_ms = int((time.time() - start) * 1000)

        # Fire-and-forget report so the caller never blocks on registry availability.
        threading.Thread(
            target=self._report_silently,
            args=(agent_id, latency_ms, status, request_size, response_size, error_msg),
            daemon=True,
        ).start()

        if status != "success":
            raise RuntimeError(error_msg or "Invocation failed")

        return result or {}

    def report(
        self,
        agent_id: str,
        latency_ms: int,
        status: str,
        request_size: Optional[int] = None,
        response_size: Optional[int] = None,
        error_msg: Optional[str] = None,
        caller_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Manually report an invocation you handled yourself."""
        return self._report(
            agent_id, latency_ms, status,
            request_size, response_size, error_msg, caller_agent_id,
        )

    # ── internal ────────────────────────────────────────────────────────────

    def _report(
        self,
        agent_id: str,
        latency_ms: int,
        status: str,
        request_size: Optional[int],
        response_size: Optional[int],
        error_msg: Optional[str],
        caller_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{self.registry_url}/agents/{quote(agent_id, safe='')}/report"
        headers = {"Content-Type": "application/json"}
        if self.caller_id:
            headers["X-Caller-ID"] = self.caller_id

        body = json.dumps({
            "latency_ms":      latency_ms,
            "status":          status,
            "request_size":    request_size,
            "response_size":   response_size,
            "error_msg":       error_msg,
            "caller_agent_id": caller_agent_id,
        }).encode()

        if _HTTP == "httpx":
            with httpx.Client() as client:
                res = client.post(
                    url, content=body, headers=headers,
                    timeout=self.report_timeout,
                )
                res.raise_for_status()
                return res.json()
        else:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=self.report_timeout) as res:
                return json.loads(res.read().decode())

    def _report_silently(self, *args) -> None:
        try:
            self._report(*args)
        except Exception as e:
            # Reporting must never crash the caller.
            print(f"[AgennectReporter] report failed: {e}")
