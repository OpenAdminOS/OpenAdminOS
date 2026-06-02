import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";

import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  SITE_NAME,
  SITE_URL,
  SOCIAL_IMAGE_PATH,
  TWITTER_IMAGE_PATH,
  absoluteUrl,
} from "./seo";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: {
    default: HOME_TITLE,
    template: `%s - ${SITE_NAME}`,
  },
  description: HOME_DESCRIPTION,
  category: "technology",
  keywords: [
    "OpenAdminOS",
    "Microsoft 365 admin agents",
    "Intune agents",
    "Entra agents",
    "local LLM",
    "Microsoft Graph",
    "tenant automation",
  ],
  openGraph: {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
    images: [
      {
        url: absoluteUrl(SOCIAL_IMAGE_PATH),
        width: 1200,
        height: 630,
        alt: "OpenAdminOS social preview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [absoluteUrl(TWITTER_IMAGE_PATH)],
  },
  icons: {
    icon: [
      {
        url: "/favicon-48.png",
        sizes: "48x48",
        type: "image/png",
      },
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
    apple: [
      {
        url: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  robots: {
    index: true,
    follow: true,
  },
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
