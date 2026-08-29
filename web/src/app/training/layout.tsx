import type { Metadata, Viewport } from "next";

import "./training.css";

const TITLE = "OpenAdmin - trained in public";
const DESCRIPTION =
  "The public record of OpenAdmin training runs, frozen evaluation suites, benchmark scores, and published model downloads.";
const TRAINING_URL = "https://training.openadminos.com/";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: TRAINING_URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: TRAINING_URL,
    siteName: "OpenAdmin",
    type: "website",
    images: [
      {
        url: "https://www.openadminos.com/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "OpenAdmin trained in public",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["https://www.openadminos.com/twitter-image.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#131009",
};

export default function TrainingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <div className="training-root">{children}</div>;
}
