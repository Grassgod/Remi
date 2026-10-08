# ADR 0011: Question cards use recipient-bound tokens and a responsibility revision

- Status: accepted

## Decision

The original conversation decision message owns the Q, its complete history and
its provider waiting state. Cards and cross-session notifications reference this
same message through `root_question_id`; they never create another question.

Every card delivery mints a random token. Only its hash, designated recipient
`open_id` and consumed timestamp are stored on `multiremi_conversation_log`.
The plaintext travels once in the action value with `message_id` and
`route_revision`. It must never appear in activities or logs.

The server validates the configured bot transport, resolves the operator to one
active member of the Q's frozen workspace, then requires the current handler,
current responsibility facts, expected route revision and unused token. One
transaction saves the answer, original-session reply and card consumption.
Redelivery and responsibility transfer rotate credentials; old cards fail closed.

The bot host forwards the action. Its optional in-memory registry only supports
card patching; native callbacks work after a host restart by rereading the
persisted original Q. Group owners and workspace owners do not substitute for
its designated human. Ambiguous identity mapping produces a text reminder with
its original Q and workbench link.

Remi reads and summarizes the same Q before normal card delivery. Unavailable
Remi, its own question, or the explicit summary deadline allows original-question
fallback. Web and card answers use the same server authority. Saved answers and
actual provider consumption remain separate, including controlled continuation
after a process exit; see [unified questions](../dev/questions.md).
