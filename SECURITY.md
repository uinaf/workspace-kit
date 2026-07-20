# Security

Do not open public issues for vulnerabilities.

Report privately via GitHub's private vulnerability reporting on this
repository (Security tab → "Report a vulnerability"). Include the affected
command or check, a minimal reproduction (a small fixture workspace is
ideal), and the impact you see.

Scope notes: workspace-kit runs offline with zero runtime dependencies and
no postinstall scripts; the highest-value reports are anything that makes a
check write outside the workspace, follow hostile symlinks, execute
repository content, or let a denylisted path pass the handoff gate.
