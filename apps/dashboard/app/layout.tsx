import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/ui";

export const metadata: Metadata = {
  title: { default: "MOTH", template: "%s · MOTH" },
  description: "MOTH — AI-powered Discord server management platform",
  icons: { icon: "/favicon.svg" },
};
export const viewport: Viewport = { themeColor: "#070707", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
