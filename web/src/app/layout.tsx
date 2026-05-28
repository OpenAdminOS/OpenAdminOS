import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";

export const metadata: Metadata = {
  metadataBase: new URL("https://openadminos.com"),
  title: "OpenAdminOS — Open-source Microsoft 365 agent control plane",
  description:
    "The open-source control plane for Microsoft 365 agents. Run scoped agents against Intune and Entra, keep local runs local, and review every change before it touches your tenant.",
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
