import { BrowserClipboardProvider } from "@xterm/addon-clipboard";

// A program may set the clipboard through OSC 52, which is how a copy over ssh
// works, and may never ask for it: the query would hand whatever was last
// copied to anything that prints one sequence.
export class WriteOnlyClipboard extends BrowserClipboardProvider {
  override readText(): Promise<string> {
    return Promise.resolve("");
  }
}
