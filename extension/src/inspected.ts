import type { CommentOn, ContextOf, ElementContext, PanelRequest } from "./pick";

const COMMENT_ON: CommentOn = "toriComment";
const CONTEXT_OF: ContextOf = "toriContext";
export const UNREACHABLE = "Tori could not reach the page. Reload it and try again.";

export const tabId = chrome.devtools.inspectedWindow.tabId;

export function ask<T>(message: PanelRequest): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

// Answered with null once the picker is in the page, otherwise the sentence saying why it is not.
export function inject(): Promise<string | null> {
  return ask<string | null>({ type: "panel.inject", tabId }).catch((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  );
}

// Runs in the picker's world, where `$0` is the element selected in Elements; false means no picker answered.
function callOnSelected<T>(name: string): Promise<T | false> {
  return new Promise((resolve) =>
    chrome.devtools.inspectedWindow.eval<T | false>(
      `globalThis.${name} ? globalThis.${name}($0) : false`,
      { useContentScriptContext: true },
      (...[result, failed]) => resolve(failed ? false : result),
    ),
  );
}

// A refusal, or null once the page's comment box is open.
export async function commentOnSelected(): Promise<string | null> {
  const why = await inject();
  if (why) return why;
  const result = await callOnSelected<string | null>(COMMENT_ON);
  return result === false ? UNREACHABLE : result;
}

// False when no picker answered, so the caller can inject and ask again.
export function contextOfSelected(): Promise<string | ElementContext | false> {
  return callOnSelected<string | ElementContext>(CONTEXT_OF);
}
