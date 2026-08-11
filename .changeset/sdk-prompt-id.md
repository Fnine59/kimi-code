---
"@moonshot-ai/kimi-code-sdk": patch
---

Add an optional `promptId` to session prompt submissions for correlating submissions with turn-started events; IDs are unique within an agent's persisted history and duplicates are rejected. Requires the v2 harness.
