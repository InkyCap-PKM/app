# Security policy

InkyCap is local-first by design. It collects no telemetry or analytics, makes
no remote calls without an explicit user action, and keeps your notebox on your
device unless you opt into a sync backend. Note contents and filesystem paths
are treated as sensitive and never appear in any outbound request.

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue for a
suspected vulnerability.

- Email **jc@inkycap.org** with a description of the issue, the InkyCap version
  and platform, and steps to reproduce if you have them.
- You will receive an acknowledgement, and we will work with you on a fix and a
  coordinated disclosure timeline.

If you are unsure whether something is a security issue, err on the side of
reporting it privately.

## Scope

Issues of particular interest:

- Anything that lets notebox content or filesystem paths escape the device
  without the user's action (including via crash reports or error output, should
  any ever be added).
- Path traversal or sandbox escape in the Typst compile path, file I/O, the git
  package import boundary, or archive extraction.
- Code execution from untrusted notebox content, imported packages, or shared
  noteboxes.
- Mishandling of credentials stored for sync or backup (OS keychain entries).

## Supported versions

InkyCap is pre-1.0 and ships from a single active release line. Security fixes
land on the current release; there is no separate long-term support branch yet.
