# LLM Wiki Demo Note

This is a sample source used to verify the first ingest flow in LLM Wiki.

## Core Idea

Instead of answering by searching the original source material from scratch every time, LLM Wiki is a pattern where an LLM gradually maintains a human-readable Markdown wiki.

It has three components.

1. `raw/` — source material collected by the user.
2. `wiki/` — the workspace where the LLM writes summaries, concepts, entities, and comparisons.
3. Operating rules — `AGENTS.md`, `CLAUDE.md`, and `.agents/skills/` define how the agent behaves.

## Leaf-First Merge Pass

When there is a lot of material, the whole folder is not processed at once. The agent starts with leaf directories that have no child directories, reads them as small chunks, saves partial outputs for each chunk, and then runs a merge pass at the end.

This reduces the following problems:

- Coding agent context overflow.
- Full reruns after an intermediate failure.
- Duplicate summaries and inconsistent indexes.
- Loss of partial results during graph builds.

## Graphify Integration

The Graph tab does not execute graphify directly. The web app asks the default coding agent to run `wiki-graphify build` or `wiki-graphify update`.

The coding agent reads the `wiki-graphify` skill and uses the global `graphify` command from `PATH`. If the package is installed but the script path is not on `PATH`, it can use `python3 -m graphify`.

## Demo Questions

After ingest, these questions can be used to verify query behavior.

- Why is the leaf-first merge pass necessary in LLM Wiki?
- Why does the Graph tab avoid executing graphify directly?
- How are the roles of `raw/` and `wiki/` different?
