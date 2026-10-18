# Daily Digest Email

## Request

Users should be able to opt into a daily email summary delivered each morning. The digest includes a summary of unread messages from all rooms and direct messages, grouped by room, with a link to each room or conversation. Users can customize which rooms are included in their digest and can unsubscribe at any time.

## Acceptance Criteria

- Users have a "Digest" or "Email preferences" setting in their account page
- A checkbox allows users to enable "Daily digest email"
- When enabled, users can set a preferred time for delivery (e.g., 8 AM in their local timezone)
- Users see a list of all rooms and can check/uncheck which ones are included in their digest
- Each day at the chosen time, an email is sent to the user's registered email address
- The email includes: a count of new messages per room, the sender names, brief message previews, and a link to open the app
- Direct messages (if any) are listed separately in the digest
- Users can click "Stop digest" in the email to unsubscribe without leaving the app
- Digest emails are only sent if there are unread messages to report
- The digest includes a link at the bottom to adjust digest settings in the app
