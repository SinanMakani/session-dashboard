# Session Dashboard

A Claude Code mod that adds a **Claude sessions** pane beside the chat, showing every Claude session on your machine — from the terminal or the desktop app — grouped into three sections:

- **Running / In progress** — what each session is doing right now (thinking, running a tool), its prompt, a context-window bar and its output token rate.
- **Waiting for input** — sessions that finished on a question, have a question or plan approval open, or have a tool call with no result for 45 s (usually a permission prompt).
- **Idle** — one compact line per session with context % and when it was last active.

**Choose sessions** lets you hide or show individual sessions; your choice is remembered. Sessions active in the last 12 hours are listed, refreshed every 3 seconds.

The pane opens when a session starts; type `/sessions` to bring it back. It only reads the session transcripts Claude Code already keeps in `~/.claude/projects` and changes nothing.

## Install

At the prompt of a terminal session:

```
/plugin install session-dashboard --marketplace SinanMakani/session-dashboard
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```
claude plugin install session-dashboard --marketplace SinanMakani/session-dashboard
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `SinanMakani/session-dashboard`, then **Add plugin**.

## Notes

- Token rates are averages over the last 60 s: a reply is written to the transcript once it completes, so this is not a live per-token speed.
- "Waiting for input" from a long-running tool is a guess; the card says so.
- Context window is 200k, switching to 1M once a session goes past 200k.

## License

MIT
