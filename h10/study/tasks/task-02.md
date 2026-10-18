# Message Pinning

## Request

Users should be able to pin important messages in a room so they appear at the top, making them easy to find. Message authors and room administrators can pin or unpin messages. The room should display a count of pinned messages, and people can view them in a dedicated area or modal.

## Acceptance Criteria

- Each message has a "Pin" or menu option for pinning (visible to authors and administrators only)
- When pinned, a message shows a pin icon or label
- Rooms display a "Pinned" badge or button showing the count of pinned messages
- Clicking the pinned messages badge opens a view listing all pinned messages in that room
- Pinned messages appear in chronological order or in the order they were pinned
- Only message authors and room administrators can unpin messages
- Existing unpinned messages have no pin icon by default
- When a message is deleted, it is automatically unpinned
