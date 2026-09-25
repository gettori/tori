---
summary: Switch fires onChange when a store reload moves its checked prop, so a handler that saves then reloads loops unless it drops no-op changes
status: current
updated: 2026-09-26
source: gettori/tori#213 on branch orchestrator; src/panels/Settings/panes/RemotePane/RemotePane.tsx (`setRemote`); src/panels/Settings/remotePane.test.tsx
---

# A Switch fires onChange when a reload moves checked

Do not write a Switch `onChange` that saves and then reloads the store without first dropping a change equal to what is stored. Why: when the reload puts `checked` somewhere the click did not, the Switch fires `onChange` again with the reloaded value, the handler saves and reloads again, and it never ends; every round is async, so it shows as a hung vitest run at low CPU rather than a stack overflow. One click produced eight `remote_set` calls against a mock that did not persist. Handlers that only call `saveSettings` never reloaded, so never met it.

## Related

- [[component_remote_front]]: `setRemote`, the handler that met it
- [[component_settings_store]]: the store a reload refills
