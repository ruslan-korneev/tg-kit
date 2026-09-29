"""`tg raw METHOD [PARAMS_JSON|-]` — the long tail of MTProto. Output is always JSON."""

from __future__ import annotations

import json
import sys
from typing import Annotated

import typer

from tg_kit.app import (
    AccountOpt,
    DryRunOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    VerboseOpt,
    YesOpt,
    emit_json,
    globals_from,
    note,
    run,
)
from tg_kit.client import telegram_errors
from tg_kit.common import resolve_spec
from tg_kit.errors import RefusedError, UsageError
from tg_kit.guard import Verdict, check
from tg_kit.peers import Peer
from tg_kit.raw import build_object, find_method, is_read_method, method_name, to_jsonable

__all__ = ["register"]


def _params(value: str | None) -> dict[str, object]:
    if value is None:
        return {}
    text = sys.stdin.read() if value == "-" else value
    try:
        parsed = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError as exc:
        raise UsageError(f"PARAMS is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise UsageError('PARAMS must be a JSON object, e.g. \'{"peer": "me", "limit": 2}\'')
    return parsed


def register(app: typer.Typer) -> None:
    @app.command("raw")
    def raw_cmd(
        ctx: typer.Context,
        method: Annotated[
            str, typer.Argument(help="e.g. messages.GetHistory or users.GetFullUser.")
        ],
        params: Annotated[
            str | None,
            typer.Argument(metavar="[PARAMS_JSON|-]", help="JSON object; - reads stdin."),
        ] = None,
        yes: YesOpt = False,
        dry_run: DryRunOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Call any MTProto method. Writes (all but Get/Search/Check/Resolve reads) need --yes."""
        g = globals_from(ctx, account, json_out, timeout, verbose)
        cls = find_method(method)
        given = _params(params)
        name = method_name(cls)
        read_only = is_read_method(cls)

        async def body(rt: Runtime) -> int:
            # Reads are not writes: the guard (and readonly) only apply to write methods.
            verdict = (
                Verdict(allowed=True, reason="read-only method")
                if read_only
                else check(
                    rt.config,
                    allowed_ids=frozenset(),  # raw writes always need --yes
                    action=f"raw {name}",
                    target=None,
                    yes=yes,
                    always_confirm=True,
                )
            )
            resolved: dict[str, Peer] = {}
            async with rt.connect() as conn:

                async def resolve(spec: str) -> Peer:
                    if spec not in resolved:
                        resolved[spec] = await resolve_spec(conn, spec, for_write=not read_only)
                    return resolved[spec]

                with telegram_errors():
                    request = await build_object(cls, given, resolve, where=name)
                plan = {
                    "action": "raw",
                    "method": name,
                    "write": not read_only,
                    "params": to_jsonable(request),
                    "peers": {k: v.summary() for k, v in resolved.items()},
                    "guard": {"allowed": verdict.allowed, "reason": verdict.reason},
                }
                if dry_run:
                    emit_json(plan)
                    outcome = "would send" if verdict.allowed else "would be REFUSED (exit 7)"
                    note(f"dry run: {outcome}: {verdict.reason}; nothing was sent")
                    return 0
                if not verdict.allowed:
                    note("refused; nothing was sent. The request was:")
                    note(json.dumps(plan, ensure_ascii=False, default=str))
                    raise RefusedError(
                        verdict.reason,
                        hint="ask the account owner; add --yes only with their explicit OK",
                    )
                for spec, p in resolved.items():
                    if not read_only:
                        note(f"{p.target_line()}  [{spec}]")
                with telegram_errors():
                    result = await conn.client(request)
            emit_json(to_jsonable(result))
            return 0

        run(g, body)
