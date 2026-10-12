---
summary: settings search is fuzzy over label and hint, so any new row can change a hardcoded match count in settingsPanel.test
status: current
updated: 2026-10-12
source: Conflict radar plan (branch `phase-1-block-2`, gettori/tickets#33); commits 8bf7aed9, 7cfd89cb, e15376c2; `src/utils/settingsCatalog.ts`, `src/panels/Settings/settingsPanel.test.tsx` ("announces the aggregate once the typing stops")
---

# Settings search is fuzzy, so a new row moves match counts

Do not read a failing "N settings match" count as a search bug after adding a settings row. Check whether the new row's label or hint matches the query as a subsequence, then update the count. Why: the filter is fuzzy over both fields, so "Watch branches for conflicts" with its hint matches "font".

## Related

- [[component_settings_store]]: the rows the catalog mirrors
- [[component_conflict_radar]]: the row that first moved it
