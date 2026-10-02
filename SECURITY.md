# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
reporting instead: on this repository, **Security > Report a vulnerability**.
The report is visible only to you and the maintainer.

Include what you can of:

- the Tori version and the macOS version,
- the steps, or a small folder or file that shows the problem,
- what an attacker gains from it.

One person maintains Tori. Expect an answer within a week, and a fix in the next
release for anything that lets someone else's content run code or read data on
your machine. You are credited in the changelog unless you would rather not be.

## Supported versions

Only the latest release gets fixes. Tori is pre-1.0 and ships often, so the fix
for a problem in an older build is the current one.

## What counts

Tori opens folders, transcripts and documents that somebody else may have
written, and runs agents inside them. The line it tries to hold:

- **A folder you have not trusted runs nothing.** No git, no language server,
  no debugger, no formatter, and no agent that would load the folder's own
  configuration. Code that runs from an untrusted folder is a vulnerability.
- **Rendered content cannot script the app.** Markdown, agent transcripts and
  language server documentation are sanitized and sit behind a content security
  policy. Script execution from any of them is a vulnerability.
- **The remote front answers only a paired device.** It listens on Tailscale
  and loopback, and is off by default. Reaching it without a device credential
  is a vulnerability.

## What does not

- What an agent does in a project you trusted and a session you started. Tori
  starts the same CLI you would run in a terminal, under its own permission
  settings.
- A problem that needs a trusted project's own configuration to be malicious.
  Trusting a project means trusting what it runs.
- A problem in an agent CLI, a language server or a debug adapter that Tori
  starts. Report those to their own projects; tell us too if Tori makes it
  worse.
