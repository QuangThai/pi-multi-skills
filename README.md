# pi-multi-skills

Multi-skill invocation extension for [pi coding agent](https://pi.dev).

Reference any installed skill from anywhere in your prompt using `$skill_name` syntax — no need to restrict skill references to the beginning of a message.

## Install

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
| 1 | **Resolver** | Scans all skill locations — global (`~/.pi/agent/skills/`, `~/.agents/skills/`), project (`.pi/skills/`), git and npm packages |
| 2 | **Parser** | Extracts `$skill_name` references from user input using regex with negative lookbehind |
| 3 | **Injector** | Reads each referenced `SKILL.md` and appends its content to the system prompt before the agent begins |
| 4 | **Autocomplete** | Registers a `$`-triggered autocomplete provider so the TUI suggests skills as the user types |

## Architecture

```
pi-multi-skills/
├── package.json       Pi package metadata
├── index.ts           Event wiring — input → before_agent_start → turn_end
├── resolver.ts        Skill discovery across all locations
├── parser.ts          $skill_name regex parsing and replacement
├── tests/             Unit tests (24 tests)
└── tsconfig.json      TypeScript strict configuration
```
