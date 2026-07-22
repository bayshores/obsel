import type { Metadata } from "next";
import type { ReactNode } from "react";

// Self-hosted, from the `geist` package. NOT `next/font/google`, and not the
// @import the mmux token sheet ships with: both fetch from fonts.googleapis.com,
// which obsel's CSP (`font-src 'self' data:`) blocks outright and which fails
// the build on a machine with no network. Getting this wrong fails silently —
// the page renders in a fallback face and looks merely slightly off — so a test
// asserts the computed family rather than trusting it.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import "./globals.css";

export const metadata: Metadata = {
  title: "obsel",
  description:
    "Finished agent work that a later upstream change invalidated, and the reason it did.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
