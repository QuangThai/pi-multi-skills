# pi-multi-skills

Multi-skill invocation extension for [pi coding agent](https://pi.dev).

Reference any installed skill from anywhere in your prompt using `$skill_name`
syntax — works inline, not just at the start of a message like `/skill:name`.

```text
Apply $code-review and $ui-ux-pro-max to review this UI

Run $karpathy-guidelines on the latest changes,
then $interview-me on the architecture
```

## Install

```bash
pi install npm:pi-multi-skills
```

Or install directly from GitHub:

```bash
pi install git:github.com/QuangThai/pi-multi-skills
```

Reload the session:

```bash
/reload
```

Verify installation:

```bash
/skills
```

## Usage

Reference one or more skills inline within any prompt:

```text
Apply $code-review and $ui-ux-pro-max to review this UI
```

Skills resolve regardless of their position in the message:

```text
Run $karpathy-guidelines on the latest changes, then $interview-me on the architecture
```

A bare skill reference also works:

```text
$interview-me
```

### Autocomplete

Press **Tab** after typing `$` to browse available skills:

```text
Apply $code- [Tab]
  ↓
┌─ $code-change-verification       ─┐
│ $code-review-and-quality          │
│ $code-simplification              │
└───────────────────────────────────┘
```

### Commands

| Command | Description |
|---------|-------------|
| `/skills` | List every installed skill with `$name` syntax |
| `/skills-search <keyword>` | Search skills by name or description |

## How it works

| Step | Component | Role |
|------|-----------|------|
| 1 | **Resolver** | Reads Pi's loaded `/skill:name` commands so `$skill_name` respects Pi trust, settings, package filters, and CLI-loaded skills |
| 2 | **Parser** | Extracts `$skill_name` references from user input using regex |
| 3 | **Input event** | Intercepts user input, expands each `$skill_name` into a `<skill>` XML block — the **same format** Pi's native `/skill:xxx` command produces |
| 4 | **Autocomplete** | Registers a `$`-triggered autocomplete provider so the TUI suggests skills as the user types |

### Comparison: `$skill_name` vs `/skill:name`

| Aspect | `$skill_name` (extension) | `/skill:name` (native Pi) |
|--------|--------------------------|--------------------------|
| Position | **Anywhere** in prompt | **Start** of message only |
| Format | `<skill name="..." location="...">` | `<skill name="..." location="...">` |
| Persistence | ✅ In conversation history | ✅ In conversation history |
| Multiple skills | ✅ Multiple per message | ❌ One per message |

Both produce identical `<skill>` XML blocks that the LLM can read. The `$skill_name`
syntax is simply more ergonomic for inline and multi-skill usage.

## Architecture

```
pi-multi-skills/
├── package.json       Pi package metadata
├── index.ts           Extension entry — input event handler + commands
├── resolver.ts        Skill registry from Pi's loaded skill commands
├── parser.ts          $skill_name regex parsing and replacement
├── tests/             Unit tests (29) + E2E integration tests (14)
└── tsconfig.json      TypeScript strict configuration
```
