import type { Metadata } from "next";

export const SITE_NAME = "OpenAdminOS";
export const SITE_URL = "https://www.openadminos.com";
export const GITHUB_URL = "https://github.com/OpenAdminOS/OpenAdminOS";
export const DOCS_URL = "https://docs.openadminos.com/";
export const LINKEDIN_URL = "https://www.linkedin.com/company/openadminos/";

export const HOME_TITLE =
  "OpenAdminOS - Local-first AI agents for Microsoft 365 admins";
export const HOME_DESCRIPTION =
  "Local-first AI agents for Microsoft 365 admins. Run tenant investigations on your machine and approve every Graph change before it happens.";

export const SOCIAL_IMAGE_PATH = "/opengraph-image.png";
export const TWITTER_IMAGE_PATH = "/twitter-image.png";

interface PageMetadataInput {
  title: string;
  description: string;
  path: string;
  absoluteTitle?: boolean;
}

export function absoluteUrl(path: string) {
  return new URL(path, SITE_URL).toString();
}

export function pageMetadata({
  title,
  description,
  path,
  absoluteTitle = false,
}: PageMetadataInput): Metadata {
  const url = absoluteUrl(path);

  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
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
      title,
      description,
      images: [absoluteUrl(TWITTER_IMAGE_PATH)],
    },
  };
}

export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export function organizationSchema() {
  return {
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    alternateName: "Open Admin OS",
    url: SITE_URL,
    logo: absoluteUrl("/apple-icon.png"),
    sameAs: [GITHUB_URL, LINKEDIN_URL, DOCS_URL],
    contactPoint: {
      "@type": "ContactPoint",
      email: "support@openadminos.com",
      contactType: "support",
    },
  };
}

export function websiteSchema() {
  return {
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: SITE_NAME,
    alternateName: "Open Admin OS",
    url: SITE_URL,
    publisher: { "@id": `${SITE_URL}/#organization` },
    inLanguage: "en",
  };
}

export function softwareApplicationSchema(input?: {
  version?: string;
  downloadUrl?: string;
}) {
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Microsoft 365 administration",
    operatingSystem: "macOS, Windows",
    softwareVersion: input?.version,
    description: HOME_DESCRIPTION,
    isAccessibleForFree: true,
    license: `${GITHUB_URL}/blob/main/LICENSE`,
    codeRepository: GITHUB_URL,
    downloadUrl: input?.downloadUrl ?? `${GITHUB_URL}/releases/latest`,
    publisher: { "@id": `${SITE_URL}/#organization` },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
  };
}

export function webPageSchema(input: {
  path: string;
  name: string;
  description: string;
  dateModified: string;
}) {
  const url = absoluteUrl(input.path);

  return {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: input.name,
    description: input.description,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#software` },
    dateModified: input.dateModified,
    inLanguage: "en",
  };
}

export function breadcrumbSchema(
  items: Array<{
    name: string;
    path: string;
  }>,
) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}
