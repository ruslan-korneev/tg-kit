"""The typer app, global options, and the one runner every command goes through.

The runner owns the process-level contract: one `asyncio` run per command,
errors as one stderr line plus a `fix:` line, fixed exit codes, Ctrl-C → 130,
SIGTERM → 143, no traceback unless `-v`.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import json
import logging
import os
import re
import signal
import sys
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, NoReturn

import typer
from typer._click.core import Context as ClickContext
from typer._click.parser import _OptionParser, _ParsingState
from typer.core import TyperCommand

from tg_kit.allowlist import Allowlist, load_allowlist
from tg_kit.config import Config, config_dir, load_config
from tg_kit.errors import EXIT_UNEXPECTED, TgError
from tg_kit.session import SessionStore
from tg_kit.style import PLAIN, ColorMode, Role, Style, choose_style, color_mode

if TYPE_CHECKING:
    from tg_kit.client import Connected
    from tg_kit.credentials import AppCredentials

__all__ = [
    "AccountOpt",
    "DryRunOpt",
    "Globals",
    "JsonOpt",
    "Runtime",
    "TgTyper",
    "TimeoutOpt",
    "TopicOpt",
    "VerboseOpt",
    "YesOpt",
    "app",
    "emit_json",
    "globals_from",
    "note",
    "out",
    "run",
]

# A marked chat id (-100… channel, -… group). No option of ours is a digit, so
# such a token is always a PEER, never a flag.
_NEGATIVE_ID = re.compile(r"-\d+")


class _NegativeIdParser(_OptionParser):
    """Click's parser, except a negative id is a positional argument, not `-1…` flags.

    Only tokens Click would read as options reach `_process_opts`; option values
    (`--after -5`) and everything after `--` never do. Any other unknown flag
    still fails with "No such option", unlike `ignore_unknown_options`, which
    would turn `tg send me --typo` into a message saying "--typo".
    """

    def _process_opts(self, arg: str, state: _ParsingState) -> None:
        if _NEGATIVE_ID.fullmatch(arg):
            state.largs.append(arg)
        else:
            super()._process_opts(arg, state)


class NegativeIdCommand(TyperCommand):
    def make_parser(self, ctx: ClickContext) -> _OptionParser:
        parser = _NegativeIdParser(ctx)
        for param in self.get_params(ctx):
            param.add_to_parser(parser, ctx)
        return parser


class TgTyper(typer.Typer):
    """`typer.Typer` whose commands accept negative chat ids (`tg read -100…`)."""

    def command(  # type: ignore[override]
        self, name: str | None = None, *, cls: type[TyperCommand] | None = None, **kwargs: Any
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return super().command(name, cls=cls or NegativeIdCommand, **kwargs)


app = TgTyper(
    add_completion=False,
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    help="Drive a Telegram user account over MTProto: read chats, send messages, "
    "test bots (send → wait → press buttons), and call raw API methods.",
)

# Default network budget for a plain command, seconds (the brief's --timeout default).
DEFAULT_TIMEOUT = 30.0

AccountOpt = Annotated[
    str | None,
    typer.Option(
        "--account", "-a", help="Account to act as (see tg accounts).", show_default=False
    ),
]
JsonOpt = Annotated[bool, typer.Option("--json", help="Print one JSON document on stdout.")]
TimeoutOpt = Annotated[
    float | None,
    typer.Option(
        "--timeout",
        help=f"Network budget in seconds (default {DEFAULT_TIMEOUT:g}).",
        show_default=False,
    ),
]
VerboseOpt = Annotated[
    bool, typer.Option("--verbose", "-v", help="Debug logs and tracebacks on stderr.")
]
YesOpt = Annotated[
    bool, typer.Option("--yes", "-y", help="Confirm a write the guard would refuse.")
]
DryRunOpt = Annotated[bool, typer.Option("--dry-run", help="Print the exact plan; send nothing.")]
TopicOpt = Annotated[
    int | None,
    typer.Option(
        "--topic", help="A forum topic's id (tg topics PEER); 1 is General.", show_default=False
    ),
]


ColorOpt = Annotated[
    str | None,
    typer.Option(
        "--color",
        help="Colour the text output: auto (a terminal, NO_COLOR unset), always, never. "
        "Also TG_COLOR. --json never has colour.",
        show_default=False,
        metavar="auto|always|never",
    ),
]


@dataclass(frozen=True)
class Globals:
    account: str | None = None
    json: bool = False
    timeout: float = DEFAULT_TIMEOUT
    verbose: bool = False
    color: ColorMode = "auto"


# `--color` for stderr, set by the global options. `note` is called from
# everywhere (and before any command runs), so it reads this rather than a
# Runtime. Empty: no `--color` given, so TG_COLOR or auto.
_color_flag: list[ColorMode] = []


@app.callback()
def _global_options(
    ctx: typer.Context,
    account: AccountOpt = None,
    json_out: JsonOpt = False,
    timeout: TimeoutOpt = None,
    verbose: VerboseOpt = False,
    color: ColorOpt = None,
) -> None:
    mode = color_mode(color, os.environ)
    _color_flag[:] = [mode] if color is not None else []
    ctx.obj = Globals(
        account=account,
        json=json_out,
        timeout=timeout or DEFAULT_TIMEOUT,
        verbose=verbose,
        color=mode,
    )


def globals_from(
    ctx: typer.Context, account: str | None, json_out: bool, timeout: float | None, verbose: bool
) -> Globals:
    """Merge options given after the subcommand over those given before it."""
    base = ctx.obj if isinstance(ctx.obj, Globals) else Globals()
    return Globals(
        account=account or base.account,
        json=json_out or base.json,
        timeout=timeout or base.timeout,
        verbose=verbose or base.verbose,
        color=base.color,
    )


@dataclass
class Runtime:
    """What a command body gets: parsed globals, config, and a way to connect."""

    globals: Globals
    config: Config
    store: SessionStore
    allow_path: Path
    now: datetime = field(default_factory=lambda: datetime.now().astimezone())
    _creds: AppCredentials | None = None

    def allowlist(self) -> Allowlist:
        return load_allowlist(self.allow_path)

    @property
    def json(self) -> bool:
        return self.globals.json

    @functools.cached_property
    def style(self) -> Style:
        """stdout's style: colour only on a terminal, never with --json/--jsonl."""
        if self.json:
            return PLAIN
        return choose_style(self.globals.color, isatty=sys.stdout.isatty(), env=os.environ)

    def creds(self) -> AppCredentials:
        if self._creds is None:
            from tg_kit.credentials import (
                load_app,
            )

            self._creds = load_app()
        return self._creds

    def account(self) -> str:
        return self.store.select(self.globals.account, self.config.default_account)

    @contextlib.asynccontextmanager
    async def connect(self, *, updates: bool = False) -> AsyncIterator[Connected]:
        from tg_kit.client import (
            connect,
        )

        async with connect(
            self.store, self.account(), self.creds(), self.config, updates=updates
        ) as conn:
            yield conn


def out(line: str = "", *, color: bool = False) -> None:
    """One stdout line. `color`: the line is styled on purpose; keep its codes in a pipe too."""
    typer.echo(line, color=color or None)


def note(line: str, role: Role | None = None) -> None:
    """One stderr line. `role` colours all of it; else a known prefix is coloured."""
    st = _err_style()
    if role is not None:
        line = st(role, line)
    elif st.on:
        line = _paint_prefix(line, st)
    typer.echo(line, err=True, color=st.on or None)


# stderr line prefixes and their colour: the error/fix pair, notes and warnings.
_PREFIXES: tuple[tuple[str, Role, bool], ...] = (
    ("error:", "unread", True),
    ("  fix:", "ok", False),
    ("note:", "held", False),
    ("warning:", "held", False),
)


def _paint_prefix(line: str, st: Style) -> str:
    for prefix, role, bold in _PREFIXES:
        if line.startswith(prefix):
            return st(role, prefix, bold=bold) + line[len(prefix) :]
    return line


def _err_style() -> Style:
    """stderr's style, decided by stderr's own isatty; a bad TG_COLOR → plain."""
    env = os.environ
    try:
        mode = _color_flag[0] if _color_flag else color_mode(None, env)
    except TgError:
        return PLAIN  # the global options report it as a usage error
    return choose_style(mode, isatty=sys.stderr.isatty(), env=env)


def emit_json(document: object) -> None:
    typer.echo(json.dumps(document, ensure_ascii=False, indent=None, default=str))


Body = Callable[[Runtime], Coroutine[Any, Any, int | None]]


def run(  # noqa: C901 — one branch per case keeps the contract readable in one place
    g: Globals,
    body: Body,
    *,
    extra_budget: float = 0.0,
    timeout_hint: str | None = None,
    unbounded: bool = False,
) -> NoReturn:
    """Run one command body and exit with its code.

    The whole body runs under `g.timeout + extra_budget` seconds (`extra_budget`
    is a command's own `--wait`), so nothing can hang past what was asked for.
    `unbounded` is for streams that run until stopped (`tg watch`); such a body
    bounds its own setup.
    """
    _setup_logging(verbose=g.verbose)
    code = EXIT_UNEXPECTED
    terminated = False

    async def main() -> int | None:
        nonlocal terminated
        task = asyncio.current_task()
        loop = asyncio.get_running_loop()

        def on_term() -> None:
            nonlocal terminated
            terminated = True
            if task is not None:
                task.cancel()

        loop.add_signal_handler(signal.SIGTERM, on_term)
        root = config_dir()
        rt = Runtime(
            globals=g,
            config=load_config(),
            store=SessionStore(root),
            allow_path=root / "allow.toml",
        )
        # Telethon may sleep through a FLOOD_WAIT up to the configured threshold;
        # that sleep must not be cut short by our own timeout and misreported.
        budget = None if unbounded else g.timeout + extra_budget + rt.config.flood_sleep_threshold
        async with asyncio.timeout(budget):
            return await body(rt)

    try:
        code = asyncio.run(main()) or 0
    except TgError as exc:
        _report(exc, verbose=g.verbose)
        code = exc.exit_code
    except TimeoutError:
        note(f"error: timed out (budget {g.timeout + extra_budget:g}s + flood-wait allowance)")
        if timeout_hint:
            note(f"  fix: {timeout_hint}")
        code = EXIT_UNEXPECTED
    except KeyboardInterrupt:
        note("interrupted")
        code = 130
    except asyncio.CancelledError:
        code = 143 if terminated else 130
    except Exception as exc:
        if g.verbose:
            raise
        note(f"error: unexpected {type(exc).__name__}: {exc}")
        note("  fix: rerun with -v for the traceback")
        code = EXIT_UNEXPECTED
    raise typer.Exit(code)


def _report(exc: TgError, *, verbose: bool) -> None:
    if verbose:
        import traceback

        traceback.print_exception(exc, file=sys.stderr)
    note(f"error: {exc}")
    if exc.hint:
        note(f"  fix: {exc.hint}")


def _setup_logging(*, verbose: bool) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    if verbose:
        logging.basicConfig(
            level=logging.DEBUG,
            stream=sys.stderr,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
        return
    # Quiet by default, except Telethon's flood-wait sleeps, which get a one-line note.
    telethon_log = logging.getLogger("telethon")
    telethon_log.setLevel(logging.INFO)
    telethon_log.propagate = False
    telethon_log.handlers = [FloodNoteHandler()]
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)


class FloodNoteHandler(logging.Handler):
    """Turns Telethon's flood-wait sleeps (and any error it logs) into one stderr line each."""

    def emit(self, record: logging.LogRecord) -> None:
        text = record.getMessage()
        if "flood wait" in text.lower():
            note(f"note: {text}")
        elif record.levelno >= logging.ERROR:
            # e.g. an exception inside an update handler: never drop it silently.
            detail = f" ({record.exc_info[1]!r})" if record.exc_info else ""
            note(f"warning: telethon: {text}{detail}")
