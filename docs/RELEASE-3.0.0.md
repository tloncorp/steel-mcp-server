# Steel MCP 3.0.0

This release fixes browser action safety, page-content isolation, concurrent session limits,
hosted tenant retention, shutdown cleanup, waits, handoff negotiation, and listener cleanup.

## API contracts

- `browser_navigate` and `browser_session_release` omit `structuredContent.title`.
  Page titles remain available in fenced page-state text. Keep that text fenced when passing it
  to a model: page-controlled titles are untrusted content.
- Custom `HandleRegistry` implementations must implement `reserveSessionSlot` and
  `releaseSessionSlot`. Reservations must atomically count pending creates and live sessions
  against the principal's limit, expire at the session's hard expiry, and be released after
  confirmed session cleanup. Shared stores must coordinate across replicas. The built-in memory
  and Redis registries implement this contract.
- `browser_wait_for` requires every supplied condition to match. To wait for only text, a
  selector, or a URL, pass only that condition.

Claude Desktop uses the Steel API key configured in the MCPB. Self-hosters deploy the server
separately; publishing the MCPB does not update a hosted service. All replicas in a shared Redis
deployment must use the same session reservation contract to enforce the atomic capacity limit.

## Fixes

- Overlay dismissal only clicks verified consent controls with an unobstructed hit target.
- Page titles stay inside untrusted-content fences.
- Hosted discovery does not retain a tenant; tenant caches have bounded capacity and idle eviction.
- Shutdown attempts every session and pool cleanup, including sessions under human control.
- Concurrent session creation reserves capacity before contacting Steel and preserves reservations
  when cleanup cannot be confirmed.
- Wait descriptions and evaluation use the same set of conditions.
- URL-only elicitation clients are not treated as form-elicitation clients.
- Failed navigation and actions dispose their page-settling listeners.
