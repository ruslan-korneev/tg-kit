# `tg raw` — params and common methods

```bash
tg raw METHOD '{"param": value, …}'      # or: echo '{…}' | tg raw METHOD -
tg raw METHOD '{…}' --dry-run            # show the built request, send nothing
```

Output is always the method's result as JSON, with bytes as base64 and dates as ISO strings.

## Params

- **Method name:** `messages.GetHistory`, `messages.GetHistoryRequest` and `messages.getHistory`
  all work. A typo exits 2 with suggestions. The full list is at
  <https://core.telegram.org/methods>.
- **Keys:** snake_case or camelCase (`msg_id` / `msgId`). An unknown key exits 2 and lists the
  valid ones.
- **Peers:** any param typed InputPeer, InputUser, InputChannel or InputDialogPeer takes a peer
  spec (`"me"`, `"@name"`, an id). tg resolves it and converts it to the right Input type.
- **Message ids:** InputMessage params accept bare ints: `{"id": [5, 6]}`.
- **Bytes:** a plain string (UTF-8), `{"$bytes": "text"}`, `{"$hex": "6f6b"}` or
  `{"$b64": "b2s="}`.
- **TL objects:** `{"_": "ConstructorName", …fields}`, nested as deep as needed. Example:
  `{"_": "ReactionEmoji", "emoticon": "👍"}`.
- **Dates:** ISO strings (`"2026-09-01T00:00:00"`, read as UTC) or unix ints.
- **Omitted required params:** integers (offsets, `hash`, `max_id`) become 0, nullable ones
  become null, and `random_id` is generated. So `{"peer": "me", "limit": 2}` is enough for
  GetHistory.
- **Writes:** only names starting with Get/Search/Check/Resolve are reads. Every `auth.*` and
  `Export*` method is a write (except `channels.ExportMessageLink` and `stories.ExportStoryLink`),
  and so are the read-named methods that change state (GetBotCallbackAnswer, GetMessagesViews,
  GetLocated, the password ones). Writes need `--yes` and are blocked under `readonly = true`. The same rule applies as everywhere else:
  never `--yes` towards a third party without the user's explicit OK.

## Methods likely to be needed

Read-only unless marked ✍ (✍ = write, needs `--yes`).

| Need | Method | Params |
|---|---|---|
| Full user/bot profile (bio, bot info, common chats) | `users.GetFullUser` | `{"id": "@name"}` |
| Several users at once | `users.GetUsers` | `{"id": ["@a", "@b"]}` |
| Channel/supergroup details | `channels.GetFullChannel` | `{"channel": "@chan"}` |
| Basic group details | `messages.GetFullChat` | `{"chat_id": 123}` (positive id) |
| Resolve a username | `contacts.ResolveUsername` | `{"username": "name"}` |
| History page | `messages.GetHistory` | `{"peer": "@x", "limit": 50, "offset_id": 0}` |
| Messages by id | `messages.GetMessages` | `{"id": [5, 6]}` (private chats/groups) |
| Channel messages by id | `channels.GetMessages` | `{"channel": "@chan", "id": [5]}` |
| Press a callback by hand | `messages.GetBotCallbackAnswer` | `{"peer": "@bot", "msg_id": 5, "data": {"$hex": "…"}}`; prefer `tg press` |
| Bot inline results | `messages.GetInlineBotResults` | `{"bot": "@bot", "peer": "me", "query": "q", "offset": ""}`; prefer `tg inline` |
| Channel admin log | `channels.GetAdminLog` | `{"channel": "@chan", "q": "", "max_id": 0, "min_id": 0, "limit": 20}` |
| Participants | `channels.GetParticipants` | `{"channel": "@chan", "filter": {"_": "ChannelParticipantsRecent"}, "offset": 0, "limit": 50}` |
| Message reactions list | `messages.GetMessageReactionsList` | `{"peer": "@chan", "id": 5, "limit": 50}` |
| Poll results | `messages.GetPollResults` | `{"peer": "@chan", "msg_id": 5}` |
| Discussion thread | `messages.GetReplies` | `{"peer": "@chan", "msg_id": 5, "limit": 50}` |
| Forum topics | `messages.GetForumTopics` | `{"peer": "@group", "limit": 20}` (layer 229 moved topics here) |
| Folders | `messages.GetDialogFilters` | `{}` |
| Stories of a peer | `stories.GetPeerStories` | `{"peer": "@name"}` |
| Story views | `stories.GetStoriesViews` | `{"peer": "me", "id": [1]}` |
| Invite links (own chat) | `messages.GetExportedChatInvites` | `{"peer": "@chan", "admin_id": "me", "limit": 20}` |
| Notification settings | `account.GetNotifySettings` | `{"peer": {"_": "InputNotifyPeer", "peer": "@x"}}` |
| Privacy rules | `account.GetPrivacy` | `{"key": {"_": "InputPrivacyKeyPhoneNumber"}}` |
| Active sessions | `account.GetAuthorizations` | `{}` |
| Blocked users | `contacts.GetBlocked` | `{"offset": 0, "limit": 50}` |
| ✍ Pin a message | `messages.UpdatePinnedMessage` | `{"peer": "@x", "id": 5}` |
| ✍ Mute a chat | `account.UpdateNotifySettings` | `{"peer": {"_": "InputNotifyPeer", "peer": "@x"}, "settings": {"_": "InputPeerNotifySettings", "mute_until": 2147483647}}` |

When a method's shape is unclear, run it with `--dry-run`. The printed `params` show how tg
built each field, and a wrong field fails with the field path and the expected type.
