"""`tg raw METHOD PARAMS` — any MTProto method, with the fiddly parts handled.

- METHOD: `messages.GetHistory`, `messages.GetHistoryRequest` or `messages.getHistory`.
- PARAMS: a JSON object; snake_case or camelCase keys.
- Peer-typed params (InputPeer / InputUser / InputChannel / InputDialogPeer,
  decided from the request's own type annotations) take a peer spec: "me",
  "@name", an id. InputMessage params take a bare message id.
- Bytes: {"$bytes": "text"} · {"$hex": "…"} · {"$b64": "…"} · or a plain string (UTF-8).
- TL objects: {"_": "InputMessageID", "id": 5}. Dates: ISO string or unix int.
- Omitted required params: integers (offsets, ids, `hash`) → 0, nullable ones →
  null. `random_id` is generated.
"""

from __future__ import annotations

import base64
import binascii
import difflib
import inspect
import re
import typing
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from functools import cache
from typing import Any

from tg_kit.errors import UsageError

__all__ = [
    "PEER_TYPES",
    "build_object",
    "find_method",
    "is_read_method",
    "method_name",
    "to_jsonable",
]

Resolver = Callable[[str], Awaitable[Any]]  # peer spec → Peer (with .input)

# TL abstract types whose values can be given as a peer spec.
PEER_TYPES = {"TypeInputPeer", "TypeInputUser", "TypeInputChannel", "TypeInputDialogPeer"}
_READ_PREFIXES = ("get", "search", "check", "resolve")
# Named like reads, but they change state, mint secrets/links, or touch the 2FA
# password — found by scanning layer 229 for read-named methods with such params.
# Every Export* is a write (it mints a token or invite) except these pure lookups.
_EXPORT_READS = frozenset({"channels.ExportMessageLink", "stories.ExportStoryLink"})
_WRITES_NAMED_AS_READS = frozenset(
    {
        "messages.GetBotCallbackAnswer",  # presses a button; tg press refuses the risky ones
        "messages.GetMessagesViews",  # increment=true bumps view counters
        "contacts.GetLocated",  # self_expires publishes the account's location
        "phone.GetGroupCallStreamRtmpUrl",  # revoke=true rotates the stream key
        "account.GetPasswordSettings",
        "account.GetTmpPassword",
        "payments.GetStarGiftWithdrawalUrl",
        "payments.GetStarsRevenueWithdrawalUrl",
    }
)
_CAMEL = re.compile(r"(?<!^)(?=[A-Z])")
_FORWARD = re.compile(
    r"ForwardRef\('(\w+)'\)|'(\w+)'|<class '(\w+)'>|(datetime)\.datetime"
    r"|\b(int|str|bool|bytes|float)\b"
)


@cache
def _methods() -> dict[str, type]:
    from telethon.tl.alltlobjects import (
        tlobjects,
    )

    table: dict[str, type] = {}
    for cls in tlobjects.values():
        module = cls.__module__
        if not module.startswith("telethon.tl.functions"):
            continue
        ns = module.removeprefix("telethon.tl.functions").lstrip(".")
        name = cls.__name__.removesuffix("Request")
        table[f"{ns}.{name}".lstrip(".").lower()] = cls
    return table


@cache
def _types() -> dict[str, type]:
    from telethon.tl.alltlobjects import tlobjects

    table: dict[str, type] = {}
    for cls in tlobjects.values():
        module = cls.__module__
        if not module.startswith("telethon.tl.types"):
            continue
        ns = module.removeprefix("telethon.tl.types").lstrip(".")
        table[f"{ns}.{cls.__name__}".lstrip(".").lower()] = cls
    return table


def method_name(cls: type) -> str:
    ns = cls.__module__.removeprefix("telethon.tl.functions").lstrip(".")
    return f"{ns}.{cls.__name__.removesuffix('Request')}".lstrip(".")


def find_method(name: str) -> type:
    key = name.strip().removesuffix("Request").lower()
    table = _methods()
    if key in table:
        return table[key]
    nice = {method_name(c).lower(): method_name(c) for c in table.values()}
    close = difflib.get_close_matches(key, list(nice), n=5, cutoff=0.6)
    hint = (
        ("did you mean: " + ", ".join(nice[c] for c in close))
        if close
        else (
            "names look like messages.GetHistory; see the method list at core.telegram.org/methods"
        )
    )
    msg = f"unknown MTProto method {name!r}"
    raise UsageError(msg, hint=hint)


def is_read_method(cls: type) -> bool:
    """Reads skip the guard, so this errs towards "write" (see the sets above)."""
    name = method_name(cls)
    if name.startswith("auth.") or name in _WRITES_NAMED_AS_READS:
        return False
    if name in _EXPORT_READS:
        return True
    return cls.__name__.lower().startswith(_READ_PREFIXES)


def _snake(key: str) -> str:
    return _CAMEL.sub("_", key).lower() if not key.islower() else key


def _parse_annotation(annotation: object) -> tuple[bool, str]:
    """(is_list, base type name) from a Telethon generated annotation."""
    if isinstance(annotation, str):  # a bare forward reference: 'TypeInputPeer'
        return False, annotation.strip("'\"")
    text = repr(annotation)
    is_list = "List[" in text
    match = _FORWARD.search(text)
    if match is None:
        return is_list, "object"
    base = next(g for g in match.groups() if g)
    return is_list, base


def _nullable(annotation: object) -> bool:
    """Whether the annotation admits None: `X | None` and `Optional[X]` alike.

    Not by repr: Python 3.12/3.13 print `Optional[datetime]`, with no "None" in it.
    """
    return type(None) in typing.get_args(annotation)


def _params(cls: type) -> dict[str, inspect.Parameter]:
    sig = inspect.signature(cls.__init__)  # type: ignore[misc]
    # Field-less constructors inherit `(self, /, *args, **kwargs)`: no params at all.
    skip = (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
    return {n: p for n, p in sig.parameters.items() if n != "self" and p.kind not in skip}


async def build_object(
    cls: type, params: dict[str, object], resolve: Resolver, *, where: str | None = None
) -> Any:
    """Construct a TL request/type from JSON-ish params, resolving peers."""
    where = where or cls.__name__
    spec = _params(cls)
    given = {_snake(k): v for k, v in params.items() if k != "_"}
    unknown = set(given) - set(spec)
    if unknown:
        msg = f"{where}: unknown params {sorted(unknown)}; valid: {sorted(spec)}"
        raise UsageError(msg)
    kwargs: dict[str, Any] = {}
    for name, param in spec.items():
        if name not in given:
            if param.default is inspect.Parameter.empty:
                # Required in the TL schema but with an obvious "unset" value:
                # nullable → None, integers (offsets, ids, hash) → 0.
                is_list, base = _parse_annotation(param.annotation)
                if _nullable(param.annotation):
                    kwargs[name] = None
                    continue
                if base == "int" and not is_list:
                    kwargs[name] = 0
                    continue
                required = [n for n, p in spec.items() if p.default is inspect.Parameter.empty]
                msg = f"{where}: missing param {name!r}; required: {required}"
                raise UsageError(msg)
            continue
        is_list, base = _parse_annotation(param.annotation)
        value = given[name]
        if value is None:
            kwargs[name] = None
        elif is_list:
            if not isinstance(value, list):
                msg = f"{where}.{name}: expected a JSON list"
                raise UsageError(msg)
            kwargs[name] = [
                await _convert(base, v, resolve, f"{where}.{name}[{i}]")
                for i, v in enumerate(value)
            ]
        else:
            kwargs[name] = await _convert(base, value, resolve, f"{where}.{name}")
    return cls(**kwargs)


async def _convert(base: str, value: object, resolve: Resolver, where: str) -> Any:  # noqa: C901, PLR0911, PLR0912 — one branch per case keeps the contract readable in one place
    from telethon import utils
    from telethon.tl import types

    if isinstance(value, dict) and "_" in value:
        return await _tl_object(value, resolve, where)
    if base in PEER_TYPES:
        from tg_kit.peers import Peer

        if isinstance(value, Peer):  # already resolved (a write plan's target)
            peer = value
        elif isinstance(value, str | int) and not isinstance(value, bool):
            peer = await resolve(str(value))
        else:
            msg = f'{where}: expected a peer spec ("me", "@name", an id)'
            raise UsageError(msg)
        convert = {
            "TypeInputPeer": utils.get_input_peer,
            "TypeInputUser": utils.get_input_user,
            "TypeInputChannel": utils.get_input_channel,
            "TypeInputDialogPeer": utils.get_input_dialog,
        }[base]
        try:
            return convert(peer.input)
        except TypeError:
            kind = base.removeprefix("TypeInput").lower()
            msg = f"{where}: {value!r} is a {peer.kind}, but this param needs a {kind}"
            raise UsageError(msg) from None
    if base == "TypeInputMessage" and isinstance(value, int):
        return types.InputMessageID(id=value)
    if base == "bytes":
        return _bytes(value, where)
    if base == "datetime":
        if isinstance(value, int | float):
            return datetime.fromtimestamp(value, tz=UTC)
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError:
                raise UsageError(f"{where}: invalid ISO date {value!r}") from None
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        raise UsageError(f"{where}: expected an ISO date or a unix time")
    if base == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise UsageError(f"{where}: expected an integer, got {value!r}")
        return value
    if base == "float":
        if not isinstance(value, int | float):
            raise UsageError(f"{where}: expected a number, got {value!r}")
        return float(value)
    if base == "bool":
        if not isinstance(value, bool):
            raise UsageError(f"{where}: expected true/false, got {value!r}")
        return value
    if base == "str":
        if not isinstance(value, str):
            raise UsageError(f"{where}: expected a string, got {value!r}")
        return value
    msg = (
        f"{where}: expects a TL object {base.removeprefix('Type')}; "
        '(pass {"_": "ConstructorName", …})'
    )
    raise UsageError(msg)


async def _tl_object(value: dict[str, Any], resolve: Resolver, where: str) -> Any:
    name = str(value["_"])
    key = name.removeprefix("types.").lower()
    table = _types()
    cls = table.get(key)
    if cls is None:
        close = difflib.get_close_matches(key, list(table), n=5, cutoff=0.7)
        hint = ("did you mean: " + ", ".join(close)) if close else None
        raise UsageError(f"{where}: unknown TL constructor {name!r}", hint=hint)
    return await build_object(cls, value, resolve, where=f"{where}<{cls.__name__}>")


def _bytes(value: object, where: str) -> bytes:
    if isinstance(value, str):
        return value.encode()
    if isinstance(value, dict) and len(value) == 1:
        ((tag, payload),) = value.items()
        if not isinstance(payload, str):
            raise UsageError(f"{where}: {tag} needs a string")
        try:
            if tag == "$bytes":
                return payload.encode()
            if tag == "$hex":
                return bytes.fromhex(payload)
            if tag == "$b64":
                return base64.b64decode(payload, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise UsageError(f"{where}: invalid {tag} payload ({exc})") from exc
    msg = f'{where}: bytes go as a string, {{"$bytes": …}}, {{"$hex": …}} or {{"$b64": …}}'
    raise UsageError(msg)


def to_jsonable(obj: object) -> object:
    """TL result → JSON-safe structure: bytes → base64, datetimes → ISO."""
    to_dict = getattr(obj, "to_dict", None)
    if callable(to_dict):
        return to_jsonable(to_dict())
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, bytes):
        return base64.b64encode(obj).decode()
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj
