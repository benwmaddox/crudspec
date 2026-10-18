# Admin Notifications for Inactive Users

## Request

Account administrators should receive an automated email notification when a user in their organization has not signed in for 14 consecutive days. The notification includes the user's name, email, and the last date they signed in. Administrators can configure this feature and disable it if desired.

## Acceptance Criteria

- Account administrators see an "Inactive user alerts" setting in the account/admin page
- A toggle allows administrators to enable or disable "Send me email when users are inactive for 14 days"
- When a user reaches 14 days of inactivity, an email is sent to all account administrators at the account
- The email includes: the inactive user's name, email address, role, and the date they last signed in
- The email includes a link to view the user's profile in the app
- If multiple users become inactive on the same day, administrators receive one email listing all of them
- Administrators can click to reactivate or deactivate a user directly from the user's profile
- If a user signs in again after being flagged as inactive, no further notifications are sent until they are inactive for another 14 days
- Existing user accounts show no inactivity status until 14 days have passed
- The setting is enabled by default for new accounts
