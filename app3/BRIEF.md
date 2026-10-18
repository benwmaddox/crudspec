# Desk: a support helpdesk

Build Desk, a small helpdesk where customers ask for help and staff answer.

## People

- **The first person** to open a new installation sets it up: on the first visit, a form with the placeholders "Name", "Email address" and "Password" creates them as the first **staff member**, signed in.
- **Customers** sign up themselves: the sign-in page has a "Sign up" link to a form with the placeholders "Name", "Email address" and "Password". They are signed in afterwards.
- Everyone signs in with their email address and password, and can sign out.

## Tickets

- A customer's home page lists their own tickets (each by its subject, linking to the ticket) and has a "New ticket" link.
- "New ticket" leads to a form with the fields "Subject" (up to 120 characters) and "Description", and a "Submit ticket" button. Submitting shows the new ticket's page.
- A ticket's page shows its subject, description, status and the conversation in order. A new ticket's status is "Open".
- Customers see only their own tickets: another customer's ticket is neither listed nor reachable.
- A staff member's home page is the **queue**: every ticket that isn't solved, each by its subject linking to the ticket.

## Working a ticket (staff)

- **Replies:** a "Reply" field and a "Send reply" button. The ticket's customer sees the reply on the ticket's page.
- **Internal notes:** a "Note" field and an "Add note" button. Notes are shown to staff only, never to the customer.
- **Assignment:** an "Assign to me" button; the ticket's page then says "Assigned to" and the staff member's name.
- **Status:** "Mark pending" and "Mark solved" buttons (and "Reopen" on a solved ticket). The page shows the status: "Open", "Pending" or "Solved". Solved tickets leave the queue.
- **Customers** can reply on their own tickets (the same "Reply" field and "Send reply" button); a reply from the customer on a pending or solved ticket reopens it. Customers have no notes, assignment or status buttons.
