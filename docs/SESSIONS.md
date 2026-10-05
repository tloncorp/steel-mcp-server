# Sessions, handoff, and saved identity

How a browser session is watched, handed to a person and back, given a saved profile or managed
login, and read after it has finished. The README covers the short version; this is the reference.

## Session lifetime

Session continuity is bounded by both inactivity and an immutable `expires_at`. A visible viewer
alone does not reserve a session. An explicit handoff suspends local idle reclamation until hard
expiry, and real human browser input resets Steel's inactivity clock. Release finished sessions
promptly; a replacement session inherits no page or cart state.

## Watching, and taking over

On a host that supports MCP Apps, Claude among them, `browser_session_create` renders the running
browser inline in the conversation. Frames are painted to a canvas from the session's own CDP
screencast. **Take control** acquires a renewable exclusive lease before clicks, typing or scrolling
go back to the page, so the agent and a person cannot drive at the same time. **Hand back** returns
ownership. During a `browser_session_handoff`, accept the pending handoff prompt afterward; the agent
then re-reads the page before continuing.

Chat hosts size an inline view for a card rather than a browser, so the view asks for the height its
page needs and offers **Full screen** on a host that grants it; the control removes itself on one
that does not.

`browser_session_handoff` invokes that flow for sensitive information, review, manual writing, local
files, or whenever you ask to take over. Login walls and CAPTCHAs can invoke it automatically. The
tool answers `input_required`, waits for hand-back, and verifies the current page before the agent
continues. Clients with URL elicitation open Steel's external player when no inline app is available.
To watch a cloud browser outside an MCP Apps host, open the `viewer_url` returned by
`browser_session_create`. Active sessions also appear in the [Steel dashboard](https://app.steel.dev).

### Local files

When a remote file input opens while you control the inline viewer, **Choose local file** opens a
trusted local picker. After confirmation, up to 5 MB travels over the session-scoped browser socket
directly into that page. The model and the MCP server receive neither the local path nor the file
bytes, and the file is not staged in Steel's persistent Files API. A client that cannot render the
inline viewer reports local upload as unavailable instead of pretending it can read your machine.

## Saved identity and non-default sessions

Call `browser_session_options` with an absolute target URL, a `read`, `interact`, or `account` goal,
and only the needs the task explicitly requires. Plain reads still recommend `browser_scrape`.
Non-default plans return a short-lived signed `configuration` for `browser_session_create`; the token
is bound to this Steel credential and expires after ten minutes. When a request says "my profile",
"saved login", or "Steel credentials", discover the account options first; never guess a profile
UUID or credential namespace.

```json
{
  "url": "https://example.com/account",
  "goal": "account",
  "needs": ["persist_profile", "location"],
  "country": "DE"
}
```

The account catalog exposes only profile UUID, status and timestamps, and exact-origin credential
namespace and timestamps. Stored values, cookies, fingerprints, proxy configuration, usernames,
passwords, and TOTP secrets never enter model context. Select a `READY` profile by UUID; names are
not guessed. Loading a profile is read-only unless `persist_profile` was explicitly planned. With
persistence, Steel creates or updates the profile on release; it may be `UPLOADING` before it
becomes `READY`. One existing profile cannot have two persistent writers through this MCP at once.
Managed login uses the returned exact-origin namespace and may auto-submit a matching form.

`STEEL_PROFILE=browse|scrape` selects this server's tool preset and is unrelated to saved browser
profiles. Profile discovery, managed credentials, proxies, and CAPTCHA assistance are Steel
Cloud features; self-hosted deployments return a named unsupported-capability result.

Self-hosted Steel runs one browser session at a time per credential. Each credential transparently
selects one durable browser profile: releasing or idling a session closes Chrome, while cookies and
other profile state are reused by the next session for that credential. Callers cannot select an
arbitrary self-hosted profile ID. The profile root must be durable storage if login state must survive
a Pod replacement. Self-hosted Steel does not support Steel-managed profiles, managed credentials,
or CAPTCHA solving. The server returns a specific explanation if a tool requests one of those
cloud-only features.

## Reading a session afterwards

`browser_session_diagnostics` accepts a live MCP `session_id`, a finished session UUID from the Steel
dashboard, `list_live: true` to recover this credential's active handles, or no id to inspect the
most recent released session. It never starts a browser. Direct clicks, scrolling and typing
performed through the live viewer travel over CDP and may be absent from its agent-trace timeline;
hidden counts refer only to routine browser network Request/Response logs.

For a browser that has already finished, explicitly ask to watch or replay it and pass its Steel
dashboard UUID to `browser_session_replay`, or omit the UUID to select the latest released session.
This release returns a sanitized Steel dashboard link. Inline finished-session playback is disabled
until its browser asset can be hosted immutably without inflating the MCP Apps payload.
## Page metadata and waits

Page titles are returned in fenced page-state text alongside the page URL. Navigation and release
results do not repeat the raw title in `structuredContent`; consumers should read the fenced text.
When `browser_wait_for` receives several conditions (text, selector, URL), all must match before it
reports success.
