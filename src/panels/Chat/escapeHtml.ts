const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
