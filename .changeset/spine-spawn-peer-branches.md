---
"@moonshot-ai/kimi-code": patch
---

Improve the experimental spine_spawn branch tool: branch prompts now carry a peer roster and a shared-workspace coordination contract, branches that fail on a salvageable error return their progress as terminal memory, and the branch limit is configurable via the `[spine_spawn] max_concurrent_threads_per_session` config.toml section.
