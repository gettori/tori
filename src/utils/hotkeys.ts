import {
  emit,
  emitWith,
  FOCUS_SEARCH,
  FOCUS_TERMINAL,
  FOCUS_PROJECT_SEARCH,
  TAB_JUMP,
  TAB_CYCLE,
  NEXT_WAITING_SESSION,
  OPEN_PALETTE,
} from "./events";

// Matches a global hotkey and fires its window-event side effect, returning
// whether it was handled. Shared between App.tsx's window-level keydown
// listener and TerminalView's attachCustomKeyEventHandler, so these bindings
// still fire while an xterm textarea has DOM focus (which otherwise swallows
// keydown before it reaches window - adversary E3). Cmd+P (QuickOpen) stays a
// plain window-level binding in App.tsx, not routed through here, since it
// isn't part of the named remap list.
export function dispatchHotkey(e: KeyboardEvent): boolean {
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "Tab") {
    emit(TAB_CYCLE);
    return true;
  }
  if (!e.metaKey) return false;
  if (e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "f") {
      emit(FOCUS_PROJECT_SEARCH);
      return true;
    }
    if (k === "a") {
      emit(NEXT_WAITING_SESSION);
      return true;
    }
    if (k === "e") {
      emit(FOCUS_SEARCH);
      return true;
    }
    return false;
  }
  if (e.key === "j") {
    emit(FOCUS_TERMINAL);
    return true;
  }
  if (e.key === "k") {
    emit(OPEN_PALETTE);
    return true;
  }
  if (/^[1-9]$/.test(e.key)) {
    emitWith(TAB_JUMP, { index: Number(e.key) - 1 });
    return true;
  }
  return false;
}
