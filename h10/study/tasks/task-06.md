# Automatic Room Archival

## Request

Rooms that have no messages for 30 consecutive days should be automatically archived by the system. Archived rooms become read-only: people can view messages and search them, but cannot post new messages. Room administrators and the account administrator can manually archive a room at any time and can restore an archived room at any time.

## Acceptance Criteria

- Rooms with no new messages for 30 days are automatically marked as archived by the system
- Archived rooms are visually indicated in the room list (grayed out, tagged as "archived," or moved to a separate section)
- People cannot post new messages to archived rooms; the message input field is hidden or disabled with a message "This room is archived"
- Archived rooms can be searched and viewed like active rooms
- Room creators and account administrators see an "Archive this room" button
- Account administrators see an "Unarchive" button or option on archived rooms
- When a message is posted to an archived room, it is automatically unarchived
- The archival date is visible to administrators (e.g., "Archived 5 days ago")
- Existing active rooms remain active until they meet the 30-day inactivity condition
