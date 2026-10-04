// The preview's lexer, off the main thread. Tokens come back whole: reference
// links are resolved inside the lex, so the parser on the page needs nothing
// else from here.
import { marked } from "marked";

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<{ id: number; text: string }>) => void) | null;
};

scope.postMessage({ ready: true });

scope.onmessage = ({ data: { id, text } }) => {
  try {
    scope.postMessage({ id, tokens: marked.lexer(text) });
  } catch (e) {
    scope.postMessage({ id, error: String(e) });
  }
};
