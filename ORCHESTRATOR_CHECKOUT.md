# Orchestrator checkout contract (P1)

When `ORCHESTRATOR_CHECKOUT_URL` is set, `start.sh` runs `orchestrator-checkout.sh` to clone the user repo into `ORCHESTRATOR_CHECKOUT_PATH` (default `/data/workspace`) and create/checkout `ORCHESTRATOR_CHECKOUT_BRANCH` from `ORCHESTRATOR_CHECKOUT_BASE`.

Also honors `OPENCODE_WORKSPACE` / `OPENCODE_WORKSPACE_PATH` for the OpenCode cwd.
