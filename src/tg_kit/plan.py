"""A write as data: what `--dry-run` prints is exactly what `execute` sends.

A step's `method` is either one of Telethon's high-level client methods
(`send_message`, …) or an MTProto method name (`messages.SendReaction`) built
through `tg_kit.raw`. Params are in the `tg raw` JSON dialect, with resolved
`Peer` objects where a peer goes; `to_json` shows those as their summary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tg_kit.guard import Target, Verdict
from tg_kit.peers import Peer

__all__ = ["CLIENT_METHODS", "Step", "WritePlan", "execute_step", "target_of"]

CLIENT_METHODS = frozenset(
    {
        "send_message",
        "send_file",
        "edit_message",
        "delete_messages",
        "forward_messages",
        "send_read_acknowledge",
    }
)


@dataclass(frozen=True)
class Step:
    method: str
    params: dict[str, object]

    def to_json(self) -> dict[str, object]:
        return {"method": self.method, "params": {k: _show(v) for k, v in self.params.items()}}


@dataclass(frozen=True)
class WritePlan:
    action: str
    target: Peer | None
    steps: tuple[Step, ...]
    verdict: Verdict

    def to_json(self) -> dict[str, object]:
        return {
            "action": self.action,
            "target": self.target.summary() if self.target else None,
            "steps": [s.to_json() for s in self.steps],
            "guard": {"allowed": self.verdict.allowed, "reason": self.verdict.reason},
        }


def target_of(peer: Peer | None) -> Target | None:
    if peer is None:
        return None
    return Target(id=peer.id, kind=peer.kind, username=peer.username, fuzzy=peer.fuzzy)


def _show(value: object) -> object:
    if isinstance(value, Peer):
        return value.summary()
    if isinstance(value, list):
        return [_show(v) for v in value]
    return value


async def execute_step(client: Any, step: Step) -> Any:
    from tg_kit.client import telegram_errors
    from tg_kit.raw import build_object, find_method

    with telegram_errors():
        if step.method in CLIENT_METHODS:
            kwargs = {k: (v.input if isinstance(v, Peer) else v) for k, v in step.params.items()}
            return await getattr(client, step.method)(**kwargs)

        async def no_resolve(spec: str) -> Peer:
            msg = f"plan step {step.method} holds an unresolved peer {spec!r}"
            raise AssertionError(msg)

        request = await build_object(find_method(step.method), step.params, no_resolve)
        return await client(request)
