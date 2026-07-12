# Optional Copilot email classifier

This on-demand worker accepts one bounded JSON request on stdin and emits one
bounded JSON response on stdout. It uses the logged-in local Copilot runtime
only. The worker has no filesystem, shell, browser, MCP, database, Gmail, or
custom tools; all permission requests are rejected.

Only redacted ambiguous email subject/snippet, sender domain/time, and up to
five candidate application metadata records cross this boundary. It cannot
update an application; the Windows companion independently validates output and
creates only a pending proposal for user review.
