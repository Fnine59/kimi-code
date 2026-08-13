# agent-core Agent Guide

## Hard rules

- The `Agent` class in `packages/agent-core/src/agent` must be usable on its own. The constructor must not force the caller to create a `Session` instance, nor require an `agentId` or `session`. It may accept an optional `sessionId` as a request-config hint — for example mapped to the provider's `prompt_cache_key` — but the instance must not hold `sessionId`, and must not depend on the Session lifecycle, metadata, or parent/child relationship logic.

## MCP management plane

- `src/mcp/registry.ts` (`McpServerRegistry`) is the single config view for MCP servers: `global` (layered mcp.json files) / `plugin` (manifests, read-only, final effective config via `PluginManager.mcpServerEntries`) / `caller` (SDK session injection). All management lookups in `src/rpc/core-impl.ts` go through it; mutations only accept mutable (user-level) entries and push changes into live sessions.
- One process-wide `McpOAuthService` lives on `KimiCore` and is shared with every `Session`; each `Session` subscribes to its credential events (save/invalidate/refresh-failed) in its constructor and unsubscribes on close, so even sessions still initializing see every event. Never construct a per-scope OAuth service in new code. Token writes go through the process-local `OAuthTokenTransaction` (`@moonshot-ai/kimi-code-oauth`), which serializes refresh grants per credential identity and stamps `obtained_at` on every durable write.
