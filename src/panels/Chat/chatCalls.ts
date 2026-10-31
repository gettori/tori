import { invoke } from "@tauri-apps/api/core";

export type ChatCall = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

let current: ChatCall = (command, args) => invoke(command, args);

export const chatCall: ChatCall = (command, args) => current(command, args);

export function setChatCall(next: ChatCall) {
  current = next;
}
