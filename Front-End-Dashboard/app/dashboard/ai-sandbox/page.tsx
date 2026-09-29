"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** This route was renamed to /dashboard/scenario-sandbox. Kept as a client
 *  redirect (not a next.config `redirects()` entry) because this app builds
 *  with `output: 'export'`, which does not run server-side redirects — so
 *  anyone with the old URL bookmarked still lands on the real page. */
export default function AiSandboxRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/scenario-sandbox");
  }, [router]);

  return null;
}
