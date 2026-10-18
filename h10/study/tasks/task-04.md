# Advanced Message Search with Filters

## Request

The current search should support filtering messages by author, room, date range, and message type (mentions, attachments, reactions). Users should be able to save frequent searches for quick access later. Search results should show the room name, date, and a snippet of the matching message.

## Acceptance Criteria

- The search page has filter buttons or dropdowns for "Author," "Room," "Date range," and "Message type" (mentions only, has attachments, has reactions)
- Users can select multiple authors or rooms to search across
- Date range filter has preset options (Today, This week, This month, Custom range)
- Search results display the room name, sender name, date, and a preview of the message
- Results include a link to jump to the message in its room
- Users see a "Save search" button that stores the current filters and search term
- Saved searches appear in a sidebar or list for quick access
- Each saved search shows its name and can be deleted by the user
- Existing searches (with no filters applied) still work as they do today
- Applying any filter button or dropdown immediately updates the search results
