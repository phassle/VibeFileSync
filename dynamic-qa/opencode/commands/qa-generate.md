---
description: Generate, adopt, or repair a deterministic QA Binding for one flow
---

QA_GENERATE_SLASH_ENTRY=1

Load the installed `qa-generate` skill through the native skill tool. With no
arguments, print usage only and stop — it must not write any repository file,
provider policy, secret, or infrastructure change. Otherwise pass through
exactly what was typed after the command name: a flow ID, `--all-ready`, or
`repair --evidence <path>`: $ARGUMENTS
