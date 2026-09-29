# ADR 0011: Question cards are answered with a one-time token bound to the addressee

- Status: accepted (MUL-404 range 5, 2026-09-28)

## Context

Task question cards (`fr_`) and Issue decision cards (`fd_`, MUL-412) decide
who may answer in two places that both rely on session identity: the bot host
keeps an in-memory registry keyed by `appId:open_message_id` and compares the
clicker's `open_id` and chat id with the card's recipient, and the server trusts
the host's `operator_open_id` (decision cards) or a fixed `responded_by =
"feishu"` (question cards). The registry is lost on host restart and re-built
from the database; the card action carries a derivable marker, not a secret.

## Decision

1. Every card delivery mints a random token. The database stores only its hash,
   the recipient `open_id`, and a consumed timestamp, on
   `multiremi_task_human_requests` and `multiremi_issue_decisions`. The plaintext
   travels once, inside the card action `value`.
2. The server is the only judge. The respond routes require `{token,
   operator_open_id}` and settle in one conditional `UPDATE` (`status =
   'pending' AND token_hash = ? AND token_recipient = ? AND token_consumed_at IS
   NULL`). Failures are `token_invalid`, `token_consumed`, `recipient_mismatch`.
   Member mapping (`resolveIssueDecisionOperatorMember`) runs after the token
   check.
3. Redelivery, retarget, and reminders rotate the token; the previous one is
   invalid immediately.
4. The host forwards; it no longer authorises. Its registry is kept only for
   card patching.
5. The web respond route (a signed-in member) is unchanged.

## Consequences

- A card survives host restarts and can be answered only once, only by the
  person it was addressed to.
- Tokens must never be logged or echoed into activities or comments.
- Group-owner-resolved recipients bind the token when the host reports the sent
  message's `interaction_open_id`.
