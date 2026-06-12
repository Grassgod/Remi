import { redirect } from "next/navigation";

// Internal self-hosted build: there is no public marketing site. The root
// path sends visitors straight to login; the login page itself forwards
// already-authenticated users on to their workspace.
export default function RootPage() {
  redirect("/login");
}
