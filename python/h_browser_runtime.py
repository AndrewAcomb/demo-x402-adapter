"""Shared H hosted-browser configuration and session lifecycle."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from hai_agents import Client
from hai_agents.polling import SessionHandle
from hai_agents.types import BrowserNetwork

from h_profile import load_state


DEFAULT_AGENT = "h/web-surfer-pro"
DEFAULT_PROXY_EGRESS_IP = "54.71.20.137"


def proxy_verification_instruction() -> str:
    """Prompt block for --verify-proxy runs that start on api.ipify.org."""
    expected_ip = os.environ.get("EXPECTED_PROXY_EGRESS_IP", DEFAULT_PROXY_EGRESS_IP)
    return f"""
First inspect the JSON at the current api.ipify.org page. Confirm its public IP
is exactly {expected_ip}. If it differs, stop immediately with success=false and
blocker="custom proxy egress verification failed". Do not expose proxy credentials.
""".strip()


@dataclass(frozen=True)
class HBrowserRuntime:
    environment_id: str
    browser_profile_id: str
    network: BrowserNetwork

    @classmethod
    def resolve(
        cls, client: Client, environment_id: str | None = None
    ) -> HBrowserRuntime:
        """Resolve and validate the one pinned environment/profile/network tuple."""
        state = load_state()
        configured_environment_id = str(state["environment_id"])
        if environment_id is not None and environment_id != configured_environment_id:
            raise RuntimeError(
                f"Unsupported H environment {environment_id!r}; only "
                f"{configured_environment_id!r} is configured"
            )
        environment_id = configured_environment_id
        browser_profile_id = str(state["active_profile_id"])
        environment = client.environments.get_environment(environment_id)
        if environment.kind != "web":
            raise RuntimeError(f"H environment {environment_id!r} is not a web environment")
        if environment.browser_profile_id != browser_profile_id:
            raise RuntimeError(
                f"H environment {environment_id!r} profile does not match "
                "profile-state.json; run `./h402 profile publish`"
            )
        if environment.network is None or not (
            environment.network.proxy_url or environment.network.managed_proxy
        ):
            raise RuntimeError(
                f"H environment {environment_id!r} has no configured browser proxy"
            )
        proxy_kind = (
            "custom" if environment.network.proxy_url else "H-managed"
        )
        print(
            f"H browser runtime: environment={environment_id!r}, "
            f"profile={state['active_profile_name']!r}, proxy={proxy_kind}",
            flush=True,
        )
        return cls(
            environment_id=environment_id,
            browser_profile_id=browser_profile_id,
            network=environment.network,
        )

    def overrides(
        self,
        start_url: str,
        *,
        network: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return {
            "agent.environments[kind=web].start_url": start_url,
            "agent.environments[kind=web].browser_profile_id": self.browser_profile_id,
            "agent.environments[kind=web].persist_browser_profile": True,
            "agent.environments[kind=web].network": (
                network
                if network is not None
                else self.network.model_dump(mode="json", exclude_none=True)
            ),
        }

    def start_session(
        self,
        client: Client,
        *,
        start_url: str,
        network: dict[str, object] | None = None,
        **session_options: Any,
    ) -> SessionHandle[Any]:
        proxy_mode = "disabled" if network == {} else "configured"
        print(f"H browser session proxy={proxy_mode}", flush=True)
        return client.start_session(
            agent=DEFAULT_AGENT,
            overrides=self.overrides(start_url, network=network),
            **session_options,
        )

    def attach_idle_session(self, client: Client, session_id: str) -> SessionHandle[Any]:
        """Attach only to the exact still-idle session; never create a replacement."""
        session = client.session(session_id)
        status = str(session.status().status)
        if status != "idle":
            raise RuntimeError(
                f"H session {session_id} has status {status!r}, expected 'idle'"
            )
        return session
