# Security Policy

Toolgate handles paid or quota-limited tool-call flows, so security issues can affect billing,
trace integrity, and payment recovery behavior.

## Supported versions

| Version    | Support                   |
| ---------- | ------------------------- |
| 0.3.x beta | Security reports accepted |
| < 0.3.0    | Best-effort only          |

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities.

Email: talha.korkmazeth@gmail.com

Include:

- affected version or commit,
- reproduction steps,
- expected and actual behavior,
- whether money movement, duplicate charging, idempotency, traces, or payment verification are involved.

We try to acknowledge reports quickly. Developer-preview status means timelines may vary,
but billing correctness and duplicate-charge issues are high priority.

## Current security boundaries

- In-memory idempotency is for local development and single-process prototypes.
- Multi-instance production requires a durable idempotency store.
- Stripe production paths must be validated against your own webhook deployment.
- x402 mainnet has not been tested by this project.
- MPP support is mocked / spec-path unless verified with a real `mppx` integration.
