import type { MemberWithUser } from "../types";

/** Resolve a display identity from the current workspace's member list. */
export function findMemberById(
  members: readonly MemberWithUser[],
  id: string,
): MemberWithUser | undefined {
  return members.find((member) => member.id === id)
    ?? members.find((member) => member.user_id === id);
}
