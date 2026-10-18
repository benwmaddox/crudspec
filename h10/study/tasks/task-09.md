# Message Threading

## Request

Users should be able to reply to a specific message, creating a conversation thread. Replies remain connected to the original message and can be viewed in a compact thread view or expanded to show all replies in context. Threads help organize conversations and keep related messages together.

## Acceptance Criteria

- Each message shows a "Reply" button or option
- Clicking "Reply" opens a reply composer with a preview of the message being replied to
- The reply box shows "@[original author]" and optionally quotes the original message
- Replies are sent as threaded messages tied to the original message
- The original message shows a "Replies" badge or count (e.g., "3 replies")
- Clicking the replies badge expands to show all replies inline under the original message
- Expanded threads show replies in chronological order with the same formatting as regular messages
- Users can collapse threads to return to the compact view
- Replies can be edited and deleted by their authors and administrators, following the same rules as regular messages
- Boosts (reactions) can be added to replies as well as original messages
- Existing messages have no replies until someone replies to them
- Direct messages and room messages both support threading
- Search results include results from threaded replies
