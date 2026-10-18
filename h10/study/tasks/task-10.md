# Scheduled Messages

## Request

Users should be able to write a message and schedule it to be sent at a specific date and time in the future. Users can view, edit, or cancel scheduled messages before they are sent. Once sent, scheduled messages appear in the room just like any other message.

## Acceptance Criteria

- When composing a message, users see a "Schedule" option or button
- Clicking "Schedule" opens a date/time picker modal
- The modal shows fields for selecting: date, time, and timezone (defaults to browser timezone)
- Users can schedule a message no more than 90 days in the future
- After scheduling, users see a confirmation with the exact delivery date and time
- Users see a "Scheduled messages" page or section in the app navigation
- Scheduled messages are listed with: destination (room or person), scheduled time, and a preview of the message
- Users can edit the message text, date, or time before it sends
- Users can cancel a scheduled message and it is permanently deleted
- When the scheduled time arrives, the message is automatically sent to the room or direct message
- The sent message shows the actual send time, not the scheduled time
- A person can schedule messages to multiple different times/recipients
- If the sender is deactivated or banned before the scheduled message sends, the message is deleted
