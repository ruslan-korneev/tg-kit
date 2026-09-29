"""Pins peer-spec parsing (every accepted form, and the refusals) and message refs.

Not covered: network resolution (cache miss → ResolveUsername / dialog scan);
that path is exercised by the live smoke test.
"""

from __future__ import annotations

import pytest

from tg_kit.errors import UsageError
from tg_kit.peers import Peer, PeerSpec, message_id_in, parse_message_ref, parse_peer


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("me", PeerSpec(raw="me", kind="me")),
        ("SELF", PeerSpec(raw="SELF", kind="me")),
        ("@Example_Bot", PeerSpec(raw="@Example_Bot", kind="username", username="example_bot")),
        ("example_bot", PeerSpec(raw="example_bot", kind="username", username="example_bot")),
        ("@gif", PeerSpec(raw="@gif", kind="username", username="gif")),
        (
            "t.me/example_bot",
            PeerSpec(raw="t.me/example_bot", kind="username", username="example_bot"),
        ),
        (
            "https://t.me/example_chan/45",
            PeerSpec(
                raw="https://t.me/example_chan/45",
                kind="username",
                username="example_chan",
                message_id=45,
            ),
        ),
        (
            "https://telegram.me/s/example_chan?x=1",
            PeerSpec(
                raw="https://telegram.me/s/example_chan?x=1",
                kind="username",
                username="example_chan",
            ),
        ),
        (
            "t.me/c/123/45",
            PeerSpec(raw="t.me/c/123/45", kind="id", peer_id=-1000000000123, message_id=45),
        ),
        ("123456", PeerSpec(raw="123456", kind="id", peer_id=123456)),
        ("-1001234567890", PeerSpec(raw="-1001234567890", kind="id", peer_id=-1001234567890)),
        ("-4567", PeerSpec(raw="-4567", kind="id", peer_id=-4567)),
        ("+1 (555) 010-0000", PeerSpec(raw="+1 (555) 010-0000", kind="phone", phone="15550100000")),
        ("title:Team Chat", PeerSpec(raw="title:Team Chat", kind="title", title="Team Chat")),
    ],
)
def test_peer_spec_forms_parse(spec: str, expected: PeerSpec) -> None:
    assert parse_peer(spec) == expected


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        ("", "empty peer spec"),
        ("title:", "needs a chat title"),
        ("t.me/+AbCdEf", "invite links are not supported"),
        ("t.me/joinchat/AbCdEf", "invite links are not supported"),
        ("ab", "cannot read peer spec"),
        ("hello world", "cannot read peer spec"),
        ("@1abc", "cannot read peer spec"),
    ],
)
def test_bad_peer_specs_are_refused_with_the_accepted_forms(spec: str, message: str) -> None:
    with pytest.raises(UsageError, match=message):
        parse_peer(spec)


@pytest.mark.parametrize(
    ("value", "msg_id", "peer_kind"),
    [
        ("677791", 677791, None),
        ("#677791", 677791, None),
        ("t.me/example_chan/45", 45, "username"),
        ("https://t.me/c/123/45", 45, "id"),
    ],
)
def test_message_ref_takes_an_id_or_a_link(value: str, msg_id: int, peer_kind: str | None) -> None:
    spec, parsed = parse_message_ref(value)
    assert parsed == msg_id
    assert (spec.kind if spec else None) == peer_kind


def test_link_without_message_id_is_not_a_message_ref() -> None:
    with pytest.raises(UsageError, match="not a message id"):
        parse_message_ref("t.me/example_chan")


def test_target_line_names_kind_and_id() -> None:
    bot = Peer(id=123456, kind="bot", username="example_bot", title="Example", input=None)
    assert bot.target_line() == "→ @example_bot (bot, id 123456)"
    chat = Peer(id=-100777, kind="supergroup", username=None, title="Team", input=None, fuzzy=True)
    assert chat.target_line() == "→ Team (supergroup, id -100777, title match)"
    me = Peer(id=1, kind="self", username="someone", title="Saved Messages", input=None)
    assert me.label() == "me"


@pytest.mark.parametrize(
    ("peer", "ref", "expected"),
    [
        ("@example_chan", "45", 45),
        ("@example_chan", "t.me/example_chan/45", 45),
        ("-1000000000123", "https://t.me/c/123/45", 45),
    ],
)
def test_message_link_into_the_same_chat_is_accepted(peer: str, ref: str, expected: int) -> None:
    assert message_id_in(peer, ref) == expected


@pytest.mark.parametrize(
    ("peer", "ref"),
    [("@example_bot", "t.me/c/999/45"), ("@example_bot", "t.me/example_chan/45")],
)
def test_message_link_into_another_chat_is_refused(peer: str, ref: str) -> None:
    with pytest.raises(UsageError, match="points into another chat"):
        message_id_in(peer, ref)
