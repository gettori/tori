---
summary: marking a replace write as a self write suppresses the reload an open buffer needs, so the next save reverts it
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 4; `src/panels/Editor/SearchPanel.tsx:267` (`applyReplace`); PR #81"
---

# A replace must not mark its own writes as self-writes

Don't call `markSelfWrite` after replace-in-files writes a file, even though every other Tori write does. Why: `isSelfWrite` short-circuits `handleExternalChange` (`CodeEditor.tsx:158`), which is exactly the clean-buffer reload a replace needs. A save marks its path because the buffer *already holds* the written text; a replace writes text the buffer does not have, so suppressing the echo leaves an open clean tab showing pre-replace content with a matching `savedText`, and the next save silently reverts the replace with nothing marked dirty. Dirty buffers are withheld from the targets up front instead.
