# Export Room Messages

## Request

Users should be able to export messages from a room as a file in CSV or JSON format. The export includes the sender name, timestamp, message content, reactions, and attachment metadata. Only room administrators and the account administrator can export messages from a room. The download begins after they click "Export."

## Acceptance Criteria

- Room pages have an "Export" button visible only to room creators and account administrators
- Clicking "Export" opens a modal or menu with format options: "CSV" or "JSON"
- Users select their preferred format and click "Download"
- The file is named with the room name and today's date (e.g., "general_2024-10-18.csv")
- CSV includes columns: Timestamp, Author, Message, Reactions, Attachments
- JSON includes an array of message objects with fields: timestamp, author, message_text, reactions (array), attachments (array with filename and type)
- Attachments in the export show only metadata (filename, type, size) not the actual files
- Reactions show the emoji/character and the count of each reaction
- The export includes messages sorted chronologically from oldest to newest
- Users who are not administrators see no export option
