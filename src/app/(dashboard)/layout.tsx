import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";
import { SuspendedScreen } from "@/components/layout/suspended-screen";
import { createClient } from "@/lib/supabase/server";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Billing suspension check. Runs with the caller's own session
  // (RLS applies via accounts_select's is_account_member check), so
  // this can only ever read the signed-in user's own account — never
  // used to check anyone else's. Fails open on any error (missing
  // session, network hiccup) so a Supabase blip doesn't lock out
  // every tenant at once; suspension is only ever enforced when we
  // get an explicit 'suspended' status back.
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .single();
      if (profile?.account_id) {
        const { data: account } = await supabase
          .from("accounts")
          .select("status, suspended_reason")
          .eq("id", profile.account_id)
          .single();
        if (account?.status === "suspended") {
          return <SuspendedScreen reason={account.suspended_reason} />;
        }
      }
    }
  } catch {
    // fail open — see comment above
  }

  return <DashboardShell>{children}</DashboardShell>;
}
