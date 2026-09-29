"""`tg` entry point: account commands here; the rest register from the cmd_* modules."""

from __future__ import annotations

import os
import sys
from typing import Annotated

import typer

from tg_kit import cmd_allow, cmd_bots, cmd_raw, cmd_read, cmd_write
from tg_kit.app import (
    AccountOpt,
    JsonOpt,
    Runtime,
    TimeoutOpt,
    VerboseOpt,
    YesOpt,
    app,
    emit_json,
    globals_from,
    note,
    out,
    run,
)
from tg_kit.client import QrPrompt
from tg_kit.errors import AuthRequiredError, RefusedError, TgError, UsageError

__all__ = ["app", "main"]

auth_app = typer.Typer(no_args_is_help=True, help="Manage the Telegram app credentials.")
app.add_typer(auth_app, name="auth")
for module in (cmd_read, cmd_write, cmd_bots, cmd_raw, cmd_allow):
    module.register(app)

# Login time can be long: code delivery + a human typing it in.
LOGIN_TIMEOUT = 600.0


@auth_app.command("set-app")
def auth_set_app(
    api_id: Annotated[int | None, typer.Option("--api-id", help="From my.telegram.org.")] = None,
    from_env: Annotated[
        bool,
        typer.Option(
            "--from-env", help="Read TG_KIT_API_ID / TG_KIT_API_HASH from the environment."
        ),
    ] = False,
) -> None:
    """Store api_id and api_hash in the system keychain (service 'tg-kit')."""
    from tg_kit.credentials import AppCredentials, store_app

    if from_env:
        env_id, env_hash = os.environ.get("TG_KIT_API_ID"), os.environ.get("TG_KIT_API_HASH")
        if not env_id or not env_hash:
            note("error: --from-env needs TG_KIT_API_ID and TG_KIT_API_HASH set")
            raise typer.Exit(2)
        creds = AppCredentials(int(env_id), env_hash)
    else:
        if api_id is None:
            note("error: pass --api-id N (or --from-env)")
            raise typer.Exit(2)
        api_hash = typer.prompt("api_hash", hide_input=True)
        creds = AppCredentials(api_id, api_hash.strip())
    store_app(creds)
    note(f"stored api_id {creds.api_id} and api_hash in the keychain")


@app.command()
def login(
    ctx: typer.Context,
    account: AccountOpt = None,
    phone: Annotated[str | None, typer.Option("--phone", help="+<country><number>.")] = None,
    qr: Annotated[bool, typer.Option("--qr", help="Log in by scanning a QR code.")] = False,
    verbose: VerboseOpt = False,
) -> None:
    """Log in interactively (code + 2FA). Creates a new device session, never reuses a key."""
    g = globals_from(ctx, account, json_out=False, timeout=LOGIN_TIMEOUT, verbose=verbose)

    async def body(rt: Runtime) -> int:
        if not sys.stdin.isatty():
            msg = "tg login is interactive and needs a terminal"
            raise AuthRequiredError(
                msg,
                hint="the account owner runs tg login in their own terminal "
                "(in Claude Code: ! tg login)",
            )
        from tg_kit.client import login as do_login

        existing = rt.store.accounts()
        name = g.account or ("main" if not existing else None)
        if name is None:
            msg = f"accounts already logged in: {', '.join(existing)}; name the new one"
            raise UsageError(msg, hint="run: tg login --account NAME")
        meta = await do_login(
            rt.store,
            name,
            rt.creds(),
            rt.config,
            phone=lambda: phone or typer.prompt("phone (+…)"),
            code=lambda: typer.prompt("code from Telegram"),
            password=lambda: typer.prompt("2FA password", hide_input=True),
            qr=_show_qr if qr else None,
        )
        handle = f"@{meta.username}" if meta.username else meta.name
        note(f"logged in as {handle} (id {meta.user_id}) → account {name!r}")
        return 0

    run(g, body)


def _show_qr(prompt: QrPrompt) -> None:
    """Draw the current code; on a terminal, replace the previous (expired) one in place."""
    if sys.stderr.isatty():
        sys.stderr.write("\033[H\033[2J")  # cursor home + clear: never leave a dead code on screen
    where = "Telegram → Settings → Devices → Link Desktop Device"
    status = (
        f"code {prompt.attempt}/{prompt.attempts}, "
        f"valid ~{prompt.expires_in:.0f}s; a new one replaces it when it expires"
    )
    try:
        import qrcode
    except ImportError:
        note(f"open this as a QR code in {where}:")
        note(prompt.url)
        note(status)
        return
    code = qrcode.QRCode(border=1)
    code.add_data(prompt.url)
    code.print_ascii(out=sys.stderr, invert=True)
    note(f"scan in {where}")
    note(status)


@app.command()
def logout(
    ctx: typer.Context,
    account: AccountOpt = None,
    yes: YesOpt = False,
    verbose: VerboseOpt = False,
) -> None:
    """Terminate this device session on Telegram's side and delete the local files."""
    g = globals_from(ctx, account, json_out=False, timeout=None, verbose=verbose)

    async def body(rt: Runtime) -> int:
        name = rt.account()
        if rt.config.readonly:
            raise RefusedError("readonly = true in config.toml: logout is refused too")
        if not yes:
            if not sys.stdin.isatty():
                msg = f"logout of {name!r} needs confirmation"
                raise RefusedError(msg, hint=f"run: tg logout --account {name} --yes")
            if not typer.confirm(f"log out {name!r} (ends the session on Telegram)?"):
                raise RefusedError("logout cancelled; nothing changed")
        async with rt.connect() as conn:
            # log_out() swallows RPC errors and returns False; then the session is
            # still alive server-side, so keep the local files and say so.
            if not await conn.client.log_out():
                raise TgError(
                    f"Telegram did not end the session of {name!r}; local files kept",
                    hint="retry tg logout, or end it in Telegram → Settings → Devices",
                )
        rt.store.remove(name)
        note(f"logged out {name!r}")
        return 0

    run(g, body)


@app.command()
def whoami(
    ctx: typer.Context,
    account: AccountOpt = None,
    json_out: JsonOpt = False,
    timeout: TimeoutOpt = None,
    verbose: VerboseOpt = False,
) -> None:
    """Who the account is, fetched live (also proves the session works)."""
    g = globals_from(ctx, account, json_out, timeout, verbose)

    async def body(rt: Runtime) -> int:
        from tg_kit.client import meta_from_user, telegram_errors

        async with rt.connect() as conn:
            with telegram_errors():
                me = await conn.client.get_me()
        meta = meta_from_user(me)
        rt.store.save_meta(conn.account, meta)
        if rt.json:
            emit_json(
                {
                    "account": conn.account,
                    "id": meta.user_id,
                    "username": meta.username,
                    "name": meta.name,
                    "premium": bool(me.premium),
                }
            )
        else:
            handle = f"@{meta.username}" if meta.username else "(no username)"
            out(
                f"{handle}  {meta.name}  id {meta.user_id}  account {conn.account}"
                f"{'  premium' if me.premium else ''}"
            )
        return 0

    run(g, body)


@app.command()
def accounts(
    ctx: typer.Context,
    json_out: JsonOpt = False,
    show_phone: Annotated[
        bool, typer.Option("--show-phone", help="Include phone numbers.")
    ] = False,
) -> None:
    """Logged-in accounts, from local files (no network)."""
    g = globals_from(ctx, None, json_out=json_out, timeout=None, verbose=False)

    async def body(rt: Runtime) -> int:
        names = rt.store.accounts()
        default = names[0] if len(names) == 1 else rt.config.default_account
        rows = []
        for name in names:
            meta = rt.store.meta(name)
            rows.append(
                {
                    "name": name,
                    "default": name == default,
                    "id": meta.user_id if meta else None,
                    "username": meta.username if meta else None,
                    "display_name": meta.name if meta else None,
                    **({"phone": meta.phone if meta else None} if show_phone else {}),
                }
            )
        if rt.json:
            emit_json(rows)
            return 0
        if not rows:
            note("no accounts; ask the account owner to run: tg login")
        for row in rows:
            mark = "*" if row["default"] else " "
            handle = f"@{row['username']}" if row["username"] else "-"
            phone = f"  +{row['phone']}" if show_phone and row.get("phone") else ""
            out(f"{mark} {row['name']}  id {row['id']}  {handle}  {row['display_name']}{phone}")
        return 0

    run(g, body)


def main() -> None:
    """Entry point. Catches errors raised while parsing arguments, before `run()`."""
    try:
        app()
    except TgError as exc:
        note(f"error: {exc}")
        if exc.hint:
            note(f"  fix: {exc.hint}")
        sys.exit(exc.exit_code)
