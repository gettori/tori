---
summary: handing a Kobalte control value undefined flips it uncontrolled, so it visibly moves on click even when refused
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phase 1), branch `chat-transcription`; `src/components/RadioGroup/RadioGroup.tsx:76`; commit `6933de0`
---

# Kobalte treats an undefined controlled value as uncontrolled

Do NOT hand a Kobalte value-carrying primitive `value={undefined}` to mean "nothing chosen"; it reads that as **uncontrolled** and starts keeping its own state, so the control visibly moves on click even when the caller's value never did. Why: measured against 0.13.13 with `RadioGroup`, a group whose handler refuses the change is left showing a state its store never took, which is the exact drift a controlled component exists to prevent. Map "nothing chosen" to the **empty string** instead, which is a value like any other and matches no option; the cost is that `""` can no longer be an option value, so say so on the option type.
