// Every suite sees macOS unless it stubs `navigator` and re-imports, as the
// hotkey table's per-platform test does. Without the pin node would report the
// host, and jsdom reports no platform at all.
Object.defineProperty(globalThis.navigator, "platform", { value: "MacIntel", configurable: true });
