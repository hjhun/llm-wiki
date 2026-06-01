# Raw Immutability as a Design Constraint

Author: synthetic example, 2026-05-18

Wiki-style knowledge bases blur the line between source material and synthesis.
A reader cannot easily tell which sentences came from the source and which came
from an interpretation written years later. CLIO's response is a strict
ownership split: the original material lives in `raw/` and is treated as
immutable by all agents. The synthesized wiki lives in `wiki/` and is freely
maintained by the LLM.

This split has three consequences. First, every claim in the wiki is traceable
back to a stable source path. Second, the LLM cannot accidentally "improve"
the original text, which would silently destroy evidence. Third, contradictions
become first-class: when two sources disagree, both stay verbatim under `raw/`
and the wiki page records the conflict with a block quote.

The only sanctioned mutation path for `raw/` is `/preprocess`, which moves
noisy files to `raw/.trash/` with a timestamp prefix so they remain
recoverable. Even that path is gated behind a dry-run plan that the user must
explicitly apply.
