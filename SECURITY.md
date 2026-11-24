# Security

Cortex reads a lot of personal text, so security problems matter. Thanks for reporting them.

## Report a vulnerability privately

Use GitHub's private reporting: open the [Security tab](https://github.com/A21-devs/cortex/security) and choose **Report a vulnerability** ([direct link](https://github.com/A21-devs/cortex/security/advisories/new)). Only the maintainer sees it.

Please don't open a public issue or discussion for a security problem.

Include what you found, how to reproduce it, which version, and what someone could do with it. You'll get a reply within a few days. Once it's fixed and released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the [latest release](https://github.com/A21-devs/cortex/releases/latest) gets fixes.

## What counts

Things like:

- text from the record reaching a model, a file or a network address it shouldn't
- Cortex writing to, deleting or changing files outside its own folders (`.raw/`, `wiki/derived/`, `.vault-meta/cortex/`, its plugin folder)
- an `obsidian://cortex` link, an imported export, or a page on a captured site making Cortex run an import, an agent, an Ask request or a change
- the live capture server (`127.0.0.1`) accepting requests without the token, or from another machine
- secrets in imported text that aren't screened before a model call
- getting past **Cortex: Lock**

What Cortex is supposed to read, send and never touch is written down in the README's Privacy section and the wiki's [Privacy and safety](https://github.com/A21-devs/cortex/wiki/Privacy-and-safety) page. Anything that breaks those promises is in scope.
