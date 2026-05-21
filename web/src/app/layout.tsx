import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";

export const metadata: Metadata = {
  metadataBase: new URL("https://openadminos.com"),
  title: "OpenAdminOS — Private preview",
  description:
    "Open-source, local-first agents for Microsoft 365 admins. Connect a tenant, pick a local LLM, run read-only agents against Intune and Entra without sending tenant data to anyone.",
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
