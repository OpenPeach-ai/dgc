---
name: skill-author
description: Create or revise a reusable DGC skill package with precise discovery, portable metadata and tested supporting resources. Use for authoring skills, not ordinary coding instructions.
---
Build the requested skill: $ARGUMENTS

Define the requests it should handle and the decisions that reusable instructions improve. Use the
user's chosen location; project `.dgc/skills/NAME/SKILL.md` or portable `.agents/skills/NAME/SKILL.md`
is suitable for a project skill. User-wide installation is a separate scope. Inspect existing packages
and preserve useful content instead of overwriting or duplicating them.

Use a lowercase hyphenated name and frontmatter with `name` and a precise `description`, followed by
self-contained instructions. `$ARGUMENTS` is the invocation argument placeholder. Describe capability
requirements and useful examples; do not invent tools, credentials or authority. Keep the body focused
on non-obvious decisions, with substantial conditional material in relative supporting references.
Distinguish reusable requirements from example names, temporary environment limits and restrictions
on this authoring run. Do not turn one-off constraints into permanent policy for every future use.

Optional `agents/openai.yaml` supports interface display_name, short_description, default_prompt and
policy allow_implicit_invocation. Quote strings; a default prompt should mention `$NAME`. Preserve the
user's invocation policy and normal automatic discovery by default. Dependencies in metadata do not
install tools. DGC reads a bounded scalar subset of YAML, so avoid tags, anchors and complex values.

`dgc skills create NAME` creates a project starter; `dgc skills install DIR` installs a reviewed local
package. These owner commands are available in the CLI and skill management UI. They refuse overwrites;
use ordinary authorized file edits to update an existing package. Model-authored changes retain file
permissions. Do not install a generated skill globally or activate a remote service without scope.

Keep SKILL.md within 64 KiB and 30,000 body characters. Local package installation is bounded to 128
files, 4 MiB total, 512 KiB per supporting file and eight directory levels. No symlinks, credentials,
private/generated files or unused scaffolds. Add scripts only when reusable deterministic behavior
justifies them; test scripts with synthetic inputs before proposing installation.

Reload with `dgc skills reload` or the Skills UI. Confirm discovery, metadata and exact `$NAME`
invocation in an isolated task, plus a nearby request that should not select it. Validate behavior,
not only frontmatter. Example: an API-migration skill should not intercept every unrelated API edit.
