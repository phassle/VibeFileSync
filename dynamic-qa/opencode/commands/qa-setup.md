---
description: Start or resume the QA-owned critical-flow contract for this repository
---

QA_SETUP_SLASH_ENTRY=1

Load the installed `qa-setup` skill through the native skill tool. With no
arguments, run its read-only orientation report and stop — it must not write
any repository file, provider policy, secret, or infrastructure change.
Otherwise pass through exactly what was typed after the command name:
`resume`, `review <flow-id>`, or nothing: $ARGUMENTS
