# MUL-444 A: B1/main follow-up failures

On validated code head `86065b9e`, CI build run `36520460248` failed its backend suite with 23 cases. Local PostgreSQL reproduced all 23. They are assigned to MUL-402's B1/main transaction reconciliation, following the parent decision and Senior's depth-one ruling. No assertions or timeouts were relaxed in MUL-444.

## PostgreSQL store: 11

Suite: `MultiremiStore on Postgres (integration)` in `tests/unit/multiremi/multiremi-postgres-store.test.ts`. The depth assertions observed `maxTransactionDepth=2` where they require 1; commit/rollback cases need the same transaction-owner correction.

1. writes the redispatch dependency exemption after commit (PG)
2. writes the retry dependency exemption after commit (PG)
3. writes the continuation dependency exemption after commit (PG)
4. writes the delegation_return dependency exemption after commit (PG)
5. writes the parent_wakeup dependency exemption after commit (PG)
6. does not auto-claim a backlog issue with an active exempt round (PG)
7. keeps the automatic-start chain at one transaction (PG)
8. keeps the prerequisite done and the dependent retryable when auto-start dispatch fails (PG)
9. rolls the whole automatic start back when a step fails (PG)
10. keeps todo plus its round when the process dies after the forced start commits (PG)
11. keeps the gate-open member start record when the process dies after COMMIT (PG)

## Human dependency force: 6

Suite: `MUL-458 human dependency force`.

1. (PostgreSQL) force-starts from a jwt member comment at depth 1
2. (PostgreSQL) force-starts from a pat member comment at depth 1
3. (PostgreSQL) keeps autopilot blocked and rolls back the transactional force path on PG
4. (PostgreSQL) serializes concurrent human comment and rerun across two PG connections
5. (PostgreSQL) serializes concurrent human comment and automatic start across two PG connections (timed out after 120 seconds)
6. (SQLite) rolls back task, status and force activity together when force audit fails

## Atomic PostgreSQL boundaries: 6

Suite: `MUL-465 atomic PostgreSQL boundaries`.

1. rolls back terminal round writes when steering an existing wake task fails later
2. reuses a round wake task under the outer workspace lock in one transaction
3. keeps workspace before session locking and emits nothing in the steer primitive
4. commits an Organizer steer and its audit in one transaction, publishing after COMMIT
5. commits an Organizer force_answer and its audit in one transaction, publishing after COMMIT
6. rolls back an Organizer steer, its audit and comment when the transaction fails later

## Separate performance follow-up

Local PostgreSQL adds one failure absent from CI: `MUL-473 first-screen hotspot query counts > keeps pending-tasks' statement count constant from 1 to 200 Chats`, which timed out after 20 seconds. The identical test on parent `41e81555` passed in 18.64 seconds on the same private PG instance; this branch took 21.68 seconds in isolation and 21.96 seconds in the full run. The pending-tasks read itself took about 34 ms. The fixture's repeated Chat writes now involve B1 conversation-log mirroring, so this should be reviewed during MUL-402 integration without weakening the query-count assertion or raising its timeout.
