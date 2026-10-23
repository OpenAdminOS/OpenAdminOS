import {
  DocsRoutePage,
  type DocsRouteProps,
  docsMetadata,
  docsStaticParams,
} from "../../docs/_components/DocsPage";

export const generateStaticParams = docsStaticParams;
export const generateMetadata = docsMetadata;

export default function DocsHostPage(props: DocsRouteProps) {
  return <DocsRoutePage {...props} base="" />;
}
