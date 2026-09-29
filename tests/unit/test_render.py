"""Golden tests for the output contract: Telethon message → MessageView → compact
lines and JSON.

Messages are real Telethon TL objects (layer 229) built offline, so the
conversion is tested against the library's shapes, not a hand-made dict.
Covers: every media kind, reply/forward/edit/pin/via markers, reactions,
truncation, newline folding, buttons of every inline and keyboard type, service
messages, and the JSON key set. Not covered: messages fetched live.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from telethon.tl import types

from tg_kit.convert import convert_message
from tg_kit.model import MessageView, with_edits
from tg_kit.render import LIST_TRUNCATE, compact, message_json

from .conftest import BOT, CHANNEL, DATE, PERSON, SELF_ID, MessageFactory

NOW = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)


def lines(view: MessageView, **kw: object) -> list[str]:
    return compact(view, now=NOW, tz=UTC, **kw)  # type: ignore[arg-type]


def view(tl_message: MessageFactory, **fields: object) -> MessageView:
    return convert_message(tl_message(**fields), self_id=SELF_ID)


def _doc(
    *attrs: object, mime: str = "application/octet-stream", size: int = 1000
) -> types.Document:
    return types.Document(
        id=1,
        access_hash=1,
        file_reference=b"",
        date=DATE,
        mime_type=mime,
        size=size,
        dc_id=2,
        attributes=list(attrs),
    )


def test_plain_bot_message_line(tl_message: MessageFactory) -> None:
    assert lines(view(tl_message, message="Choose a bot")) == [
        "#677791 09-29 11:02 @example_bot: Choose a bot"
    ]


def test_newlines_fold_into_one_line(tl_message: MessageFactory) -> None:
    assert lines(view(tl_message, message="a\nb\r\nc")) == [
        "#677791 09-29 11:02 @example_bot: a ⏎ b ⏎ c"
    ]


def test_outgoing_is_me_with_reply_marker(tl_message: MessageFactory) -> None:
    v = view(
        tl_message,
        id=677792,
        out=True,
        from_id=types.PeerUser(SELF_ID),
        message="/start",
        reply_to=types.MessageReplyHeader(reply_to_msg_id=677791),
    )
    assert lines(v) == ["#677792 09-29 11:02 me ↩677791: /start"]


def test_user_without_username_shows_display_name(tl_message: MessageFactory) -> None:
    v = view(
        tl_message,
        peer_id=types.PeerUser(PERSON.id),
        from_id=types.PeerUser(PERSON.id),
        message="hey",
    )
    assert lines(v) == ["#677791 09-29 11:02 Alex K.: hey"]


def test_channel_post_uses_channel_title(tl_message: MessageFactory) -> None:
    v = view(
        tl_message, peer_id=types.PeerChannel(CHANNEL.id), from_id=None, post=True, message="news"
    )
    assert lines(v) == ["#677791 09-29 11:02 @example_news: news"]
    assert v.sender.kind == "channel"


def test_other_year_shows_the_year(tl_message: MessageFactory) -> None:
    v = view(tl_message, date=DATE - timedelta(days=400), message="old")
    assert lines(v)[0].startswith("#677791 2025-08-25 11:02 ")


def test_markers_forward_edit_pin_via_reactions(tl_message: MessageFactory) -> None:
    v = view(
        tl_message,
        message="hi",
        fwd_from=types.MessageFwdHeader(date=DATE, from_id=types.PeerChannel(CHANNEL.id)),
        edit_date=DATE,
        pinned=True,
        via_bot_id=BOT.id,
        reactions=types.MessageReactions(
            results=[
                types.ReactionCount(reaction=types.ReactionEmoji("👍"), count=3),
                types.ReactionCount(reaction=types.ReactionEmoji("❤️"), count=1),
                types.ReactionCount(reaction=types.ReactionCustomEmoji(document_id=5), count=2),
            ]
        ),
    )
    assert lines(v) == [
        "#677791 09-29 11:02 @example_bot via @example_bot ⤳@example_news ✎ 📌: hi {👍3 ❤️1 custom2}"
    ]


def test_bot_edit_hidden_from_apps_is_still_marked(tl_message: MessageFactory) -> None:
    v = view(tl_message, message="x", edit_date=DATE, edit_hide=True)
    assert "✎" in lines(v)[0]
    assert message_json(v)["edited"] == "2026-09-29T11:02:00Z"


def test_hidden_text_links_are_listed_under_the_message(tl_message: MessageFactory) -> None:
    text = "📄 Политика и оферта"  # the emoji is 2 UTF-16 units: offsets must count them
    v = view(
        tl_message,
        message=text,
        entities=[
            types.MessageEntityTextUrl(offset=3, length=8, url="https://example.com/privacy"),
            types.MessageEntityTextUrl(offset=14, length=6, url="https://example.com/offer"),
            types.MessageEntityUrl(offset=0, length=2),
        ],
    )
    assert lines(v) == [
        "#677791 09-29 11:02 @example_bot: 📄 Политика и оферта",
        (
            '  [link "Политика" → https://example.com/privacy]'
            ' [link "оферта" → https://example.com/offer]'
        ),
    ]
    assert message_json(v)["links"] == [
        {"text": "Политика", "url": "https://example.com/privacy"},
        {"text": "оферта", "url": "https://example.com/offer"},
    ]


def test_edits_seen_while_waiting_are_counted(tl_message: MessageFactory) -> None:
    v = view(tl_message, message="final")
    assert lines(with_edits(v, 3)) == ["#677791 09-29 11:02 @example_bot ✎×3: final"]
    assert lines(with_edits(v, 1)) == ["#677791 09-29 11:02 @example_bot ✎: final"]


def test_long_text_is_truncated_with_a_pointer(tl_message: MessageFactory) -> None:
    v = view(tl_message, message="x" * (LIST_TRUNCATE + 50))
    (line,) = lines(v, truncate=LIST_TRUNCATE, peer_hint="@example_bot")
    assert line == (
        "#677791 09-29 11:02 @example_bot: "
        + "x" * LIST_TRUNCATE
        + "… (+50 chars, tg msg @example_bot 677791)"
    )
    assert lines(v)[0].endswith(": " + "x" * (LIST_TRUNCATE + 50))  # no truncate → full text


@pytest.mark.parametrize(
    ("media", "tag"),
    [
        (
            types.MessageMediaPhoto(
                photo=types.Photo(
                    id=1,
                    access_hash=1,
                    file_reference=b"",
                    date=DATE,
                    dc_id=2,
                    sizes=[
                        types.PhotoSize("m", 320, 180, 20_000),
                        types.PhotoSizeProgressive("y", 1280, 720, [100_000, 219_136]),
                    ],
                )
            ),
            "[photo 1280×720 214KB]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeAudio(duration=12, voice=True), mime="audio/ogg"
                )
            ),
            "[voice 0:12]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeAudio(duration=185, performer="Band", title="Song"),
                    mime="audio/mpeg",
                )
            ),
            "[audio Band - Song 3:05]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeVideo(duration=61, w=1920, h=1080),
                    types.DocumentAttributeFilename("clip.mp4"),
                    mime="video/mp4",
                    size=5_000_000,
                )
            ),
            "[video 1920×1080 1:01 4.8MB]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeVideo(duration=9, w=384, h=384, round_message=True)
                )
            ),
            "[videonote 0:09]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeVideo(duration=3, w=320, h=260),
                    types.DocumentAttributeAnimated(),
                    size=138_000,
                )
            ),
            "[gif 320×260 0:03 135KB]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeSticker(
                        alt="😀", stickerset=types.InputStickerSetEmpty()
                    ),
                    mime="image/webp",
                )
            ),
            "[sticker 😀]",
        ),
        (
            types.MessageMediaDocument(
                document=_doc(
                    types.DocumentAttributeFilename("report.pdf"),
                    mime="application/pdf",
                    size=2_202_010,
                )
            ),
            "[document report.pdf 2.1MB]",
        ),
        (
            types.MessageMediaPoll(
                poll=types.Poll(
                    id=1, question=types.TextWithEntities("Lunch?", []), answers=[], hash=0
                ),
                results=types.PollResults(),
            ),
            '[poll "Lunch?"]',
        ),
        (types.MessageMediaGeo(geo=types.GeoPointEmpty()), "[geo]"),
        (
            types.MessageMediaContact(
                phone_number="", first_name="Sam", last_name="", vcard="", user_id=0
            ),
            '[contact "Sam"]',
        ),
        (types.MessageMediaDice(value=4, emoticon="🎲"), "[dice 🎲=4]"),
        (types.MessageMediaUnsupported(), "[unsupported]"),
    ],
)
def test_media_tags(tl_message: MessageFactory, media: object, tag: str) -> None:
    assert lines(view(tl_message, media=media, message="cap")) == [
        f"#677791 09-29 11:02 @example_bot: {tag} cap"
    ]


def test_link_preview_adds_no_tag_but_is_in_json(tl_message: MessageFactory) -> None:
    page = types.WebPage(
        id=1, url="https://example.com", display_url="example.com", hash=0, title="Example"
    )
    v = view(tl_message, message="https://example.com", media=types.MessageMediaWebPage(page))
    assert lines(v) == ["#677791 09-29 11:02 @example_bot: https://example.com"]
    assert message_json(v)["media"] == {
        "type": "webpage",
        "title": "Example",
        "url": "https://example.com",
    }


def test_inline_buttons_of_every_type_render_as_rows(tl_message: MessageFactory) -> None:
    kb = types.KeyboardInlineButton
    markup = types.ReplyInlineMarkup(
        rows=[
            types.KeyboardInlineButtonRow(
                [
                    kb("My bot", types.InlineButtonTypeCallback(data=b"bot")),
                    kb(
                        "Back", types.InlineButtonTypeCallback(data=b"back", requires_password=True)
                    ),
                ]
            ),
            types.KeyboardInlineButtonRow(
                [
                    kb("Docs", types.InlineButtonTypeUrl("https://example.com/docs")),
                    kb(
                        "Login", types.InlineButtonTypeUrlAuth("https://example.com/l", button_id=1)
                    ),
                    kb("App", types.InlineButtonTypeWebView("https://example.com/app")),
                ]
            ),
            types.KeyboardInlineButtonRow(
                [
                    kb("Share", types.InlineButtonTypeSwitchInline("q", same_peer=True)),
                    kb("Play", types.InlineButtonTypeGame()),
                    kb("Pay", types.InlineButtonTypeBuy()),
                    kb("Copy", types.InlineButtonTypeCopy("code-1")),
                    kb("Who", types.InlineButtonTypeUserProfile(user_id=5)),
                    kb("Off", types.InlineButtonTypeDisabled()),
                ]
            ),
        ]
    )
    v = view(tl_message, message="Menu", reply_markup=markup)
    assert lines(v) == [
        "#677791 09-29 11:02 @example_bot: Menu",
        '  [0:0 cb "My bot"] [0:1 cb "Back" 🔒]',
        (
            '  [1:0 url "Docs" → https://example.com/docs] [1:1 login "Login" → https://example.com/l]'
            ' [1:2 webapp "App" → https://example.com/app]'
        ),
        (
            '  [2:0 switch "Share" → here: \'q\'] [2:1 game "Play"] [2:2 buy "Pay"]'
            ' [2:3 copy "Copy" → \'code-1\'] [2:4 profile "Who" → user 5] [2:5 disabled "Off"]'
        ),
    ]
    assert v.keyboard == "inline"
    assert v.buttons[0][0].data == b"bot"


def test_reply_keyboard_buttons_are_typed_and_not_inline(tl_message: MessageFactory) -> None:
    markup = types.ReplyKeyboardMarkup(
        rows=[
            types.KeyboardButtonRow(
                [
                    types.KeyboardButton("Menu", types.ButtonTypeDefault()),
                    types.KeyboardButton("Phone", types.ButtonTypeRequestPhone()),
                    types.KeyboardButton("Where", types.ButtonTypeRequestGeoLocation()),
                    types.KeyboardButton("Vote", types.ButtonTypeRequestPoll()),
                    types.KeyboardButton(
                        "Site", types.ButtonTypeSimpleWebView("https://example.com")
                    ),
                ]
            )
        ]
    )
    v = view(tl_message, message="k", reply_markup=markup)
    assert lines(v)[1] == (
        '  [0:0 reply "Menu"] [0:1 phone "Phone"] [0:2 geo "Where"]'
        ' [0:3 poll "Vote"] [0:4 webapp "Site" → https://example.com]'
    )
    assert v.keyboard == "reply"
    assert not any(b.inline for b in v.buttons[0])


def test_service_message_is_marked(tl_message: MessageFactory) -> None:
    msg = tl_message(cls=types.MessageService, id=9, action=types.MessageActionPinMessage())
    v = convert_message(msg, self_id=SELF_ID)
    assert lines(v) == ["#9 09-29 11:02 @example_bot: [service pin_message]"]


def test_global_search_prefixes_chat_title(tl_message: MessageFactory) -> None:
    v = convert_message(tl_message(message="x"), self_id=SELF_ID, chat_title="Team Chat")
    assert lines(v) == ["#677791 09-29 11:02 [Team Chat] @example_bot: x"]


def test_json_schema_is_stable(tl_message: MessageFactory) -> None:
    markup = types.ReplyInlineMarkup(
        rows=[
            types.KeyboardInlineButtonRow(
                [types.KeyboardInlineButton("Go", types.InlineButtonTypeCallback(data=b"go"))]
            )
        ]
    )
    doc = message_json(
        view(
            tl_message,
            message="hi",
            reply_markup=markup,
            reply_to=types.MessageReplyHeader(reply_to_msg_id=5),
        )
    )
    assert list(doc) == [
        "id",
        "chat_id",
        "date",
        "sender",
        "out",
        "text",
        "reply_to",
        "forward",
        "edited",
        "edits",
        "pinned",
        "service",
        "via_bot",
        "media",
        "keyboard",
        "buttons",
        "reactions",
        "links",
    ]
    assert doc["date"] == "2026-09-29T11:02:00Z"
    assert doc["sender"] == {
        "id": 123456,
        "kind": "bot",
        "username": "example_bot",
        "name": "Example",
    }
    assert doc["reply_to"] == 5
    assert doc["buttons"] == [
        [{"row": 0, "col": 0, "type": "cb", "text": "Go", "data_b64": "Z28="}]
    ]
