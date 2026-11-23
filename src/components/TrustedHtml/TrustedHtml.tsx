import { omit } from "solid-js";
import { dynamic, type JSX } from "@solidjs/web";

type Props = JSX.HTMLAttributes<HTMLElement> & {
  as?: "code" | "div" | "span";
  html: string;
};

// Every JSX innerHTML comes through here, so lint fails on a new one written anywhere else.
// `html` must be sanitized, generated from escaped text, or bundled with the app.
export default function TrustedHtml(props: Props) {
  const Control = dynamic(() => props.as ?? "div");
  const rest = omit(props, "as", "html");
  // oxlint-disable-next-line solid/no-innerhtml
  return <Control {...rest} innerHTML={props.html} />;
}
