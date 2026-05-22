# CLIO Skill

Installable agent skill for using a CLIO / LLM Wiki knowledge base as local
development memory.

The distributed skill name is `clio`. The canonical source lives in this
directory:

```text
clio-skill/clio/
```

## Install

Install globally to `~/.agents/skills/clio`:

```bash
./clio-skill/skills.sh install
```

Install into a specific CLIO project:

```bash
./clio-skill/skills.sh install project --project-dir /path/to/clio
```

Install both:

```bash
./clio-skill/skills.sh install both --project-dir /path/to/clio
```

## Installer Integration

`setup.sh` installs this skill globally by default. The release installer runs
`setup.sh`, so `scripts/install.sh` gets the same behavior. Use `--clio-skill`
to change the target:

```bash
scripts/install.sh --clio-skill global
scripts/install.sh --clio-skill project
scripts/install.sh --clio-skill both
scripts/install.sh --clio-skill none

./setup.sh --clio-skill both
```

The global target is `~/.agents/skills/clio`. Agent runtimes need to include
`~/.agents/skills` in their skill search path to discover the global skill.
