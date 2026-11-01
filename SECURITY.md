# Security

MooPay moves money, so please report problems privately and give us a chance to fix them before they are public.

**Report a problem:** open a private security advisory on this repository (Security tab, then "Report a vulnerability"). Please do not post details in a public issue.

Helpful to include: what you did, what you expected, what happened, and the page or endpoint involved. Please use test amounts only, and do not access other people's accounts or data.

**What to expect:** a reply within a few days, and a fix or a clear answer after that.

Good to know:
- Testers should only add small amounts. MooPay is a small-float wallet, not a vault.
- The recovery code is the key to an account. Never share it, and never paste it anywhere except `/restore`.
- Keys and secrets never belong in this repository. If you spot one, tell us right away so it can be rotated.
