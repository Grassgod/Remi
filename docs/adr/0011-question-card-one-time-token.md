# ADR 0011: Question cards use recipient-bound tokens and a responsibility revision

- Status: accepted; amended by [ADR 0017](0017-issue-execution-and-escalation.md)
  (card recipient at an Issue Q's human stage)

## Decision

The original conversation decision message owns the Q, its complete history and
its provider waiting state. Cards and cross-session notifications reference this
same message through `root_question_id`; they never create another question.

Every card delivery mints a random token. Only its hash, designated recipient
`open_id` and consumed timestamp are stored on `multiremi_conversation_log`.
The plaintext travels once in the action value with `message_id` and
`route_revision`. It must never appear in activities or logs.

A card has one recipient. At an Issue Q's human stage nobody is designated, so
the card goes to the root Issue's creator when that creator is an active member
who maps uniquely to the bot app's `open_id`. A Chat Q without an Issue sends it
to its designated member. Group owners and workspace owners never substitute for
that recipient. Ambiguous or missing identity mapping produces a text reminder
with its original Q and workbench link; any active member can still answer the
same Q on the web.

The server validates the configured bot transport, resolves the operator to one
active member of the Q's frozen workspace, then requires a human stage that this
member may handle (any active member for an Issue Q, the designated member for a
Chat Q), current responsibility facts, the expected route revision and an unused
token bound to the recipient. One transaction saves the answer, original-session
reply and card consumption. Redelivery and re-routing after a responsibility
change rotate credentials; old cards fail closed.

The bot host forwards the action. Its optional in-memory registry only supports
card patching; native callbacks work after a host restart by rereading the
persisted original Q.

Remi reads and summarizes the same Issue Q before normal card delivery.
Unavailable Remi, its own question, or the explicit summary deadline allows
original-question fallback. A Chat Q has no Remi step: its member answers it in
the original Chat, and a Feishu-bound Chat gets the original-question card at
once (see [unified questions](../dev/questions.md)). Web and card answers use the same server authority. Saved answers and
actual provider consumption remain separate, including controlled continuation
after a process exit; see [unified questions](../dev/questions.md).
