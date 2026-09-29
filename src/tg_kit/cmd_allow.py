"""`tg allow add|list|remove` — the only writer of allow.toml.

Adding a peer lets every later write to it skip --yes, so `add` is itself
guarded: it needs --yes (or an interactive yes) and is refused under readonly.
"""

from __future__ import annotations

import sys
from typing import Annotated

import typer

from tg_kit.allowlist import AllowEntry, save_allowlist
from tg_kit.app import (
    AccountOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    VerboseOpt,
    YesOpt,
    emit_json,
    globals_from,
    note,
    out,
    run,
)
from tg_kit.common import resolve_spec
from tg_kit.errors import NotFoundError, RefusedError

__all__ = ["register"]

PeersArg = Annotated[list[str], typer.Argument(metavar="PEER...", help="me, @username, id, …")]


def _confirm(rt: Runtime, question: str, *, yes: bool, retry: str) -> None:
    if rt.config.readonly:
        raise RefusedError("readonly = true in config.toml: the allowlist cannot change")
    if yes:
        return
    if not sys.stdin.isatty():
        raise RefusedError(
            "changing the allowlist needs confirmation",
            hint=f"run: {retry} --yes (only with the account owner's OK)",
        )
    if not typer.confirm(question):
        raise RefusedError("cancelled; allowlist unchanged")


def _entry_json(e: AllowEntry) -> dict[str, object]:
    return {"id": e.id, "kind": e.kind, "username": e.username, "name": e.name, "added": e.added}


def register(app: typer.Typer) -> None:  # noqa: C901, PLR0915 — one closure per command
    allow_app = typer.Typer(
        no_args_is_help=True, help="Peers writable without --yes (stored by id in allow.toml)."
    )
    app.add_typer(allow_app, name="allow")

    @allow_app.command("add")
    def allow_add(
        ctx: typer.Context,
        peers: PeersArg,
        yes: YesOpt = False,
        account: AccountOpt = None,
        json_out: JsonOpt = False,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Resolve peers and allow writes to them by id (labels kept for humans)."""
        g = globals_from(ctx, account, json_out, timeout, verbose)

        async def body(rt: Runtime) -> int:
            async with rt.connect() as conn:
                resolved = [await resolve_spec(conn, p, for_write=True) for p in peers]
            new = [
                AllowEntry(
                    id=p.id,
                    kind=p.kind,
                    username=p.username,
                    name=p.title,
                    added=rt.now.date().isoformat(),
                )
                for p in resolved
            ]
            listing = "\n".join(f"  + {e.label()}" for e in new)
            _confirm(
                rt,
                f"allow writes without --yes to:\n{listing}\n?",
                yes=yes,
                retry="tg allow add " + " ".join(peers),
            )
            allowlist = rt.allowlist()
            for e in new:
                allowlist = allowlist.with_entry(e)
            save_allowlist(rt.allow_path, allowlist)
            if rt.json:
                emit_json([_entry_json(e) for e in new])
            else:
                for e in new:
                    out(f"+ {e.label()}")
            return 0

        run(g, body)

    @allow_app.command("list")
    def allow_list(ctx: typer.Context, json_out: JsonOpt = False) -> None:
        """Show the allowlist (no network)."""
        g = globals_from(ctx, None, json_out=json_out, timeout=None, verbose=False)

        async def body(rt: Runtime) -> int:
            entries = rt.allowlist().entries
            if rt.json:
                emit_json([_entry_json(e) for e in entries])
            elif not entries:
                note("allowlist is empty: every write needs --yes (add with: tg allow add PEER)")
            for e in entries:
                out(e.label())
            return 0

        run(g, body)

    @allow_app.command("remove")
    def allow_remove(
        ctx: typer.Context,
        peers: Annotated[
            list[str],
            typer.Argument(metavar="ID|PEER...", help="An id from tg allow list, or a peer."),
        ],
        account: AccountOpt = None,
        timeout: TimeoutOpt = None,
        verbose: VerboseOpt = False,
    ) -> None:
        """Stop allowing writes to peers (by id; a spec is resolved first)."""
        g = globals_from(ctx, account, json_out=False, timeout=timeout, verbose=verbose)

        async def body(rt: Runtime) -> int:
            allowlist = rt.allowlist()
            known = {e.id: e for e in allowlist.entries}
            ids: list[int] = []
            specs = []
            for p in peers:
                if p.lstrip("-").isdigit() and int(p) in known:
                    ids.append(int(p))
                else:
                    specs.append(p)
            if specs:  # only reach the network for non-id specs
                async with rt.connect() as conn:
                    ids += [(await resolve_spec(conn, s, for_write=True)).id for s in specs]
            missing = [i for i in ids if i not in known]
            if missing:
                raise NotFoundError(f"not in the allowlist: {missing}", hint="see: tg allow list")
            if rt.config.readonly:
                raise RefusedError("readonly = true in config.toml: the allowlist cannot change")
            # Removing only tightens the guard, so it needs no confirmation.
            for i in ids:
                allowlist = allowlist.without(i)
                out(f"- {known[i].label()}")
            save_allowlist(rt.allow_path, allowlist)
            return 0

        run(g, body)
