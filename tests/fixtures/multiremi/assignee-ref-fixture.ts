// MUL-473: fixture for the assignee-reference resolution equivalence suite.
//
// The PR1 branch added a `usr_ -> member` prefix inference to
// `inferAssigneeTypeFromRef`, which locked the branch before the historical
// "try agent, then member, then squad" order could run. QA's counterexample is a
// legal Agent whose *name* happens to look like a user id: the old code resolved
// it as that Agent, the new code refused it as a missing member.
//
// Equivalence therefore has to be asserted against the old implementation's
// answers, not against a restatement of the new rules. This fixture seeds the
// shapes that can collide, and `capture-assignee-ref-golden.ts` records what
// `593ff2ba` returned for each of them. Every value below is explicit so the
// capture and the assertion run over the same rows.
import type { MultiremiStore } from "@multiremi/store.js";
import { seedHistoricalIssueFacts } from "../../unit/multiremi/helpers.js";

export interface AssigneeRefFixture {
  workspaceId: string;
  otherWorkspaceId: string;
  /** The reader used for the HTTP-level assertions. */
  readerUserId: string;
  readerMemberId: string;
  ownerUserId: string;
  /** Agents, by the role each one plays in the table. */
  agents: {
    plainId: string;
    plainName: string;
    /** Name shaped like a user id — the QA counterexample. */
    usrShapedNameAgentId: string;
    usrShapedName: string;
    /** Name shaped like a member row id. */
    memShapedNameAgentId: string;
    memShapedName: string;
    /** Name shaped like a squad id. */
    sqdShapedNameAgentId: string;
    sqdShapedName: string;
    /**
   * Named exactly like the reader's user id, so the reader's member row and this
   * Agent both match that string.
   */
    collidingWithUserIdAgentId: string;
    collidingWithUserIdName: string;
    /** Named exactly like the other member's user id. */
    collidingWithOtherUserIdAgentId: string;
    collidingWithOtherUserIdName: string;
    /** Name that is also another agent's id (exact-id tier wins for that agent). */
    ambiguousAgentName: string;
  };
  members: {
    /** Ordinary member, reachable by row id, name and email. */
    otherMemberId: string;
    otherMemberName: string;
    otherMemberUserId: string;
    otherMemberEmail: string;
    /** The reader member's user id, which is also an agent's name. */
    readerUserId: string;
    /** A member whose user id nothing else in the fixture uses. */
    cleanMemberId: string;
    cleanMemberUserId: string;
    /**
     * Two members share one `user_id`, and the first of them is also *named*
     * that same string. The member tier refuses a doubled `user_id` outright —
     * it does not fall through to the alias tiers — so this reference resolves
     * to nothing rather than to the member whose name matches.
     */
    duplicateUserId: string;
    duplicateUserIdMemberId: string;
    duplicateUserIdOtherMemberId: string;
  };
  squads: {
    plainSquadId: string;
    plainSquadName: string;
    /** Name shaped like a user id. */
    usrShapedNameSquadId: string;
    usrShapedName: string;
    /** Named exactly like the reader's user id. */
    collidingWithUserIdSquadId: string;
    collidingWithUserIdName: string;
  };
  issueIds: string[];
  /** Rows archived on purpose; a ref naming one must not resolve to it. */
  archived: { agentId: string; memberId: string; squadId: string };
  /** Refs derived mechanically from the seeded names and ids. */
  derived: Array<{ label: string; ref: string }>;
}

const WORKSPACE_ID = "local";
const OTHER_WORKSPACE_ID = "ws_assignee_ref_other";

/**
 * Pin id generation and the clock, so the member `user_id`s this fixture mints
 * are the same on the golden-capture run and on every later assertion run.
 *
 * Two of the interesting cases are collisions *between* tables, and the
 * colliding string is a generated user id — without pinning, the captured
 * expected values would name rows that the next run does not create. The
 * technique mirrors `installFirstScreenHotspotIds()` (same PRNG, same
 * one-tick-per-read clock). Returns a restore function.
 */
export function installAssigneeRefIds(): () => void {
  // Restore the exact function object; a bound copy leaks identity changes.
  const realGetRandomValues = globalThis.crypto.getRandomValues;
  const RealDate = globalThis.Date;
  let clock = Date.UTC(2026, 8, 27, 9, 0, 0);
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock++);
      else super(...(args as []));
    }
    static now(): number {
      return clock++;
    }
  }
  (globalThis as { Date: unknown }).Date = FixtureDate;
  let state = 0x473_a55e;
  const nextByte = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 24) & 0xff;
  };
  (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = (array: ArrayLike<number> & { length: number }) => {
    for (let index = 0; index < array.length; index += 1) {
      (array as unknown as number[])[index] = nextByte();
    }
    return array;
  };
  return () => {
    (globalThis as { Date: unknown }).Date = RealDate;
    (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = realGetRandomValues;
  };
}

export function seedAssigneeRefFixture(store: MultiremiStore): AssigneeRefFixture {
  store.ensureLocalWorkspace();
  const owner = store.getCurrentUser();
  if (!store.getWorkspaceMember(`mem_${WORKSPACE_ID}_${owner.id}`)) {
    store.createWorkspaceMember({
      id: `mem_${WORKSPACE_ID}_${owner.id}`,
      workspaceId: WORKSPACE_ID,
      userId: owner.id,
      name: owner.name ?? "Owner",
      role: "owner",
    });
  }

  // The reader's user id is deliberately the string an Agent below is named, so
  // the "both a member user id and an agent name" collision is on the common
  // path rather than a synthetic branch.
  const reader = store.getOrCreateUser({
    externalId: "assignee-ref-reader",
    email: "assignee-ref-reader@example.test",
    name: "Assignee ref reader",
  });
  store.createWorkspaceMember({
    id: `mem_${WORKSPACE_ID}_${reader.id}`,
    workspaceId: WORKSPACE_ID,
    userId: reader.id,
    name: "Assignee ref reader",
    role: "member",
  });

  const otherMember = store.getOrCreateUser({
    externalId: "assignee-ref-other",
    email: "assignee-ref-other@example.test",
    name: "Assignee ref other",
  });
  store.createWorkspaceMember({
    id: `mem_${WORKSPACE_ID}_${otherMember.id}`,
    workspaceId: WORKSPACE_ID,
    userId: otherMember.id,
    name: "Other member",
    email: "other-member@example.test",
    role: "member",
  });

  // A member whose user id no Agent or Squad shares: the member-only case.
  const cleanMember = store.getOrCreateUser({
    externalId: "assignee-ref-clean",
    email: "assignee-ref-clean@example.test",
    name: "Assignee ref clean",
  });
  store.createWorkspaceMember({
    id: `mem_${WORKSPACE_ID}_${cleanMember.id}`,
    workspaceId: WORKSPACE_ID,
    userId: cleanMember.id,
    name: "Clean member",
    role: "member",
  });

  // A second workspace nothing in this fixture should reach.
  const otherWorkspace = store.createWorkspace({ id: OTHER_WORKSPACE_ID, name: "Other ref workspace", slug: "other-ref-ws" });

  const agent = (id: string, name: string) => store.createAgent({
    id,
    name,
    provider: "codex",
    workspaceId: WORKSPACE_ID,
    ownerId: owner.id,
    visibility: "workspace",
  });

  // Squads carry only a name alias, so the Squad tier cannot collide on ids.
  const squad = (id: string, name: string) => store.createSquad({ id, name, workspaceId: WORKSPACE_ID });

  agent("agt_assignee_plain", "Plain agent");
  agent("agt_assignee_usr_shaped", "usr_assignee_lookalike");
  agent("agt_assignee_mem_shaped", "mem_assignee_lookalike");
  agent("agt_assignee_sqd_shaped", "sqd_assignee_lookalike");
  // Named exactly like real member user ids. These strings are only known at
  // runtime (`createId` mints them), which is why the fixture returns them.
  agent("agt_assignee_shares_user_id", reader.id);
  agent("agt_assignee_shares_other_user_id", otherMember.id);
  // An Agent that is also a name-alias collision: two Agents share the alias, so
  // the alias tier cannot decide and the old code throws "ambiguous".
  agent("agt_assignee_ambiguous_a", "Shared alias");
  agent("agt_assignee_ambiguous_b", "Shared alias");
  // A workspace outsider whose name matches an alias in this one.
  store.createAgent({
    id: "agt_assignee_foreign",
    name: "Shared alias",
    provider: "codex",
    workspaceId: otherWorkspace.id,
    visibility: "workspace",
  });

  // Names that exercise the case-folding and punctuation-folding tiers of the
  // alias match.
  agent("agt_assignee_dotted", "Dotted.Name.Agent");
  agent("agt_assignee_cased", "Mixed Case Agent");

  squad("sqd_assignee_plain", "Plain squad");
  squad("sqd_assignee_usr_shaped", "usr_assignee_squad_lookalike");
  squad("sqd_assignee_shares_user_id", reader.id);

  // Archived rows, seeded last so every live twin above already exists. The
  // historical exact-id fast paths refuse archived rows, and the alias scans
  // only ever saw non-archived rows, so a ref naming one must resolve to a
  // *different* live row (or to nothing) — exactly as before.
  const archivedAgent = agent("agt_assignee_archived", "Archived agent");
  store.archiveAgent(archivedAgent.id);
  const archivedMember = store.getOrCreateUser({
    externalId: "assignee-ref-archived",
    email: "assignee-ref-archived@example.test",
    name: "Assignee ref archived",
  });
  store.createWorkspaceMember({
    id: `mem_${WORKSPACE_ID}_${archivedMember.id}`,
    workspaceId: WORKSPACE_ID,
    userId: archivedMember.id,
    name: "Archived member",
    role: "member",
  });
  store.archiveWorkspaceMember(`mem_${WORKSPACE_ID}_${archivedMember.id}`);
  const archivedSquad = squad("sqd_assignee_archived", "Archived squad");
  store.archiveSquad(archivedSquad.id);

  // Live twins, so the "archived exact id refused, alias tier decides" path has
  // a witness for the Agent and the Squad kinds.
  agent("agt_assignee_live_twin", "Archived agent");
  squad("sqd_assignee_live_twin", "Archived squad");

  // Two members sharing one user id, the first of them named after it. The
  // member tier returns nothing when more than one row carries the same
  // `user_id` (it refuses the kind instead of picking a winner), so the name
  // alias on the first row must never decide this reference.
  const duplicateUserId = "usr_assignee_dupe_shared";
  const duplicateUserIdMemberId = `mem_${WORKSPACE_ID}_dupe_shared_a`;
  const duplicateUserIdOtherMemberId = `mem_${WORKSPACE_ID}_dupe_shared_b`;
  store.createWorkspaceMember({
    id: duplicateUserIdMemberId,
    workspaceId: WORKSPACE_ID,
    userId: duplicateUserId,
    // The name hits the same reference through the compact/punctuation tier
    // rather than by exact equality. Spelling it with the same separators as the
    // reference would also make the bare `_` and `usr_` probes fuzzy-match this
    // row, silently turning two "no match" cases into hits.
    name: "Usr Assignee Dupe Shared",
    role: "member",
  });
  store.createWorkspaceMember({
    id: duplicateUserIdOtherMemberId,
    workspaceId: WORKSPACE_ID,
    userId: duplicateUserId,
    name: "Dupe member, other row",
    role: "member",
  });

  // Issues so the HTTP layer has something to filter. One per assignee shape, so
  // a filter that resolves to the wrong row is visible as a wrong total and a
  // wrong id list rather than an empty one.
  const issueIds: string[] = [];
  const addIssue = (id: string, assigneeType: "agent" | "member" | "squad", assigneeId: string) => {
    const issue = store.createIssue({
      id,
      workspaceId: WORKSPACE_ID,
      title: `Assignee ref ${id}`,
      status: "in_progress",
      ...(assigneeType === "member" ? {} : { assigneeType, assigneeId }),
      createdBy: reader.id,
    });
    // Keep the captured legacy member-assignee facts readable without using
    // the current write API to configure a human as an execution owner.
    if (assigneeType === "member") seedHistoricalIssueFacts(store, issue.id, { assigneeType, assigneeId });
    issueIds.push(issue.id);
  };
  addIssue("iss_assignee_plain_agent", "agent", "agt_assignee_plain");
  addIssue("iss_assignee_usr_shaped_agent", "agent", "agt_assignee_usr_shaped");
  addIssue("iss_assignee_mem_shaped_agent", "agent", "agt_assignee_mem_shaped");
  addIssue("iss_assignee_sqd_shaped_agent", "agent", "agt_assignee_sqd_shaped");
  addIssue("iss_assignee_shared_user_id", "agent", "agt_assignee_shares_user_id");
  addIssue("iss_assignee_plain_squad", "squad", "sqd_assignee_plain");
  addIssue("iss_assignee_usr_shaped_squad", "squad", "sqd_assignee_usr_shaped");
  addIssue("iss_assignee_shared_user_id_squad", "squad", "sqd_assignee_shares_user_id");
  addIssue("iss_assignee_other_member", "member", `mem_${WORKSPACE_ID}_${otherMember.id}`);
  // Assigned to the member whose *name* is the doubled user id, so the HTTP
  // layer distinguishes "refused the doubled user_id" (total 0) from "resolved
  // that member through its alias" (total 1).
  addIssue("iss_assignee_duplicate_user_id", "member", duplicateUserIdMemberId);

  return {
    workspaceId: WORKSPACE_ID,
    otherWorkspaceId: otherWorkspace.id,
    readerUserId: reader.id,
    readerMemberId: `mem_${WORKSPACE_ID}_${reader.id}`,
    ownerUserId: owner.id,
    agents: {
      plainId: "agt_assignee_plain",
      plainName: "Plain agent",
      usrShapedNameAgentId: "agt_assignee_usr_shaped",
      usrShapedName: "usr_assignee_lookalike",
      memShapedNameAgentId: "agt_assignee_mem_shaped",
      memShapedName: "mem_assignee_lookalike",
      sqdShapedNameAgentId: "agt_assignee_sqd_shaped",
      sqdShapedName: "sqd_assignee_lookalike",
      collidingWithUserIdAgentId: "agt_assignee_shares_user_id",
      collidingWithUserIdName: reader.id,
      collidingWithOtherUserIdAgentId: "agt_assignee_shares_other_user_id",
      collidingWithOtherUserIdName: otherMember.id,
      ambiguousAgentName: "Shared alias",
    },
    members: {
      otherMemberId: `mem_${WORKSPACE_ID}_${otherMember.id}`,
      otherMemberName: "Other member",
      otherMemberUserId: otherMember.id,
      otherMemberEmail: "other-member@example.test",
      readerUserId: reader.id,
      cleanMemberId: `mem_${WORKSPACE_ID}_${cleanMember.id}`,
      cleanMemberUserId: cleanMember.id,
      duplicateUserId,
      duplicateUserIdMemberId,
      duplicateUserIdOtherMemberId,
    },
    squads: {
      plainSquadId: "sqd_assignee_plain",
      plainSquadName: "Plain squad",
      usrShapedNameSquadId: "sqd_assignee_usr_shaped",
      usrShapedName: "usr_assignee_squad_lookalike",
      collidingWithUserIdSquadId: "sqd_assignee_shares_user_id",
      collidingWithUserIdName: reader.id,
    },
    issueIds,
    archived: {
      agentId: "agt_assignee_archived",
      memberId: `mem_${WORKSPACE_ID}_${archivedMember.id}`,
      squadId: "sqd_assignee_archived",
    },
    derived: derivedRefs(),
  };
}

/**
 * Refs derived from the fixture's own names and ids rather than enumerated by
 * hand: case variants, punctuation-stripped variants, prefixes and substrings.
 * The old implementation's answers for these are captured the same way, so the
 * tier order itself is under test, not just the shapes someone remembered.
 */
function derivedRefs(): Array<{ label: string; ref: string }> {
  const seeds: Array<[string, string]> = [
    ["agent name", "Plain agent"],
    ["agent name with digits", "Agent 7"],
    ["dotted agent name", "Dotted.Name.Agent"],
    ["dotted agent name, no dots", "DottedNameAgent"],
    ["mixed-case agent name", "Mixed Case Agent"],
    ["usr_-shaped agent name", "usr_assignee_lookalike"],
    ["squad name", "Plain squad"],
    ["member name", "Other member"],
    ["archived agent name", "Archived agent"],
    ["archived member name", "Archived member"],
    ["archived squad name", "Archived squad"],
    ["agent id", "agt_assignee_plain"],
    ["squad id", "sqd_assignee_plain"],
  ];
  const refs: Array<{ label: string; ref: string }> = [];
  for (const [label, seed] of seeds) {
    refs.push({ label: `derived: ${label}, as written`, ref: seed });
    refs.push({ label: `derived: ${label}, upper case`, ref: seed.toUpperCase() });
    refs.push({ label: `derived: ${label}, lower case`, ref: seed.toLowerCase() });
    refs.push({ label: `derived: ${label}, punctuation stripped`, ref: seed.replace(/[^A-Za-z0-9]+/g, "") });
    refs.push({ label: `derived: ${label}, one char dropped`, ref: seed.slice(0, -1) });
    refs.push({ label: `derived: ${label}, one char appended`, ref: `${seed}z` });
    refs.push({ label: `derived: ${label}, lower + padded`, ref: `  ${seed.toLowerCase()}  ` });
  }
  return refs;
}

/**
 * Every reference the equivalence suite exercises, with the shape it is meant to
 * cover. Kept here (not in the test) so the golden capture script runs the exact
 * same table.
 */
export function assigneeRefCases(fixture: AssigneeRefFixture): Array<{ label: string; ref: string }> {
  return [
    // ── plain ids ────────────────────────────────────────────────────────────
    { label: "agent row id", ref: fixture.agents.plainId },
    { label: "member row id", ref: fixture.members.otherMemberId },
    { label: "squad row id", ref: fixture.squads.plainSquadId },
    { label: "reader user id (also an agent name)", ref: fixture.members.readerUserId },
    { label: "other member user id", ref: fixture.members.otherMemberUserId },
    // ── names that carry no id shape ─────────────────────────────────────────
    { label: "agent name", ref: fixture.agents.plainName },
    { label: "member name", ref: fixture.members.otherMemberName },
    { label: "member email", ref: fixture.members.otherMemberEmail },
    { label: "squad name", ref: fixture.squads.plainSquadName },
    // ── `usr_`-shaped references ─────────────────────────────────────────────
    { label: "usr_-shaped agent name", ref: fixture.agents.usrShapedName },
    { label: "usr_-shaped squad name", ref: fixture.squads.usrShapedName },
    { label: "usr_-shaped value that exists nowhere", ref: "usr_assignee_nowhere" },
    // ── `mem_` / `agt_` / `sqd_`-shaped names (prefixes that predate this PR) ─
    { label: "mem_-shaped agent name", ref: fixture.agents.memShapedName },
    { label: "sqd_-shaped agent name", ref: fixture.agents.sqdShapedName },
    { label: "mem_-shaped value that exists nowhere", ref: "mem_assignee_nowhere" },
    { label: "agt_-shaped value that exists nowhere", ref: "agt_assignee_nowhere" },
    { label: "sqd_-shaped value that exists nowhere", ref: "sqd_assignee_nowhere" },
    // ── collisions ───────────────────────────────────────────────────────────
    // The reader's user id is also an Agent name and a Squad name: all three
    // tiers match it. What the old implementation does here is the contract.
    { label: "collision: member user id + agent name + squad name", ref: fixture.agents.collidingWithUserIdName },
    // The other member's user id is also an Agent name, and no Squad uses it.
    { label: "collision: member user id + agent name", ref: fixture.agents.collidingWithOtherUserIdName },
    // A member user id nothing else claims.
    { label: "member user id with no collision", ref: fixture.members.cleanMemberUserId },
    // Two members share one user id and one of them is named after it: the
    // member tier refuses the doubled `user_id` and does not fall through to the
    // name alias, so nothing resolves. Deleting that refusal is the mutation
    // this case exists to catch.
    { label: "collision: two members share a user id, one named like it", ref: fixture.members.duplicateUserId },
    // Two Agents share an alias and no id matches: the old alias tier refuses it.
    { label: "collision: two agents share an alias", ref: fixture.agents.ambiguousAgentName },
    // Prefix of a real agent id — the id-prefix tier in `uniqueRefMatch`.
    { label: "agent id prefix", ref: "agt_assignee_pl" },
    // An exact agent id that is also a substring of another agent's id.
    { label: "exact agent id that prefixes another id", ref: "agt_assignee_ambiguous_a" },
    // ── archived rows ────────────────────────────────────────────────────────
    { label: "archived agent row id", ref: fixture.archived.agentId },
    { label: "archived member row id", ref: fixture.archived.memberId },
    { label: "archived squad row id", ref: fixture.archived.squadId },
    // The live twin shares the archived Agent's/Squad's name, so this exercises
    // "exact id refused, alias tier decides".
    { label: "archived agent name (live twin exists)", ref: "Archived agent" },
    { label: "archived squad name (live twin exists)", ref: "Archived squad" },
    // ── derived variants (case, punctuation, prefix, substring) ─────────────
    ...fixture.derived,
    // ── empty / whitespace ───────────────────────────────────────────────────
    { label: "blank reference", ref: "   " },
    { label: "single character", ref: "A" },
    { label: "underscore only", ref: "_" },
    { label: "usr_ prefix only", ref: "usr_" },
  ];
}
