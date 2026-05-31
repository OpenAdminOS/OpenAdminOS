import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";

export const metadata: Metadata = {
  metadataBase: new URL("https://openadminos.com"),
  title: "OpenAdminOS — Local-first agents for Microsoft 365 tenants",
  description:
    "A local-first desktop app for Microsoft 365 tenant administrators. Run AI agents against your tenant, keep local runs on your device, and review every change before it happens.",
};

export const viewport = {
  themeColor: "#0a0a0c",
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
