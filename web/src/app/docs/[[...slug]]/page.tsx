import {
  DocsRoutePage,
  type DocsRouteProps,
  docsMetadata,
  docsStaticParams,
} from "../_components/DocsPage";

export const generateStaticParams = docsStaticParams;
export const generateMetadata = docsMetadata;

export default function DocsPage(props: DocsRouteProps) {
  return <DocsRoutePage {...props} base="/docs" />;
}
