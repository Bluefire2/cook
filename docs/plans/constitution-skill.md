# `write-constitution` Cursor skill

Add a project Cursor skill that writes a **feature constitution** in a
standard format, adds it to an index in root `AGENTS.md`, and checks the
result with a test. The user triggers it on purpose, either by typing
`/write-constitution` or by asking something like "make a constitution for this
new feature".

This plan is self-contained. Nothing else needs to be read first, apart from
root `AGENTS.md`, which applies as always.

## What a feature constitution is

A constitution records one feature's principles and **why** each one exists.
Its purpose is that a later agent working on that feature either keeps to the
principles or deliberately amends the constitution in the same PR, saying why
the break is worth it. Breaking a principle silently is a defect.

Agents find constitutions the way they find skills. Root `AGENTS.md` is loaded
into every agent session, and it holds a short **index** with only each
constitution's name, path, and one-line description. An agent reads a full
constitution only when that description matches its work, which keeps the
context window small.

A cook log feature is planned separately. It will add the first constitution
at `docs/constitutions/cook-log.md`. That plan is not in the repo yet, so do
not look for it. If `docs/constitutions/cook-log.md` exists when you implement
this, the setup below may already be present. Step 1 covers both cases.

## Decisions

- **The skill is a project skill at `.cursor/skills/write-constitution/`,**
  versioned in the repo. That makes it available in local Cursor, in Cloud
  Agents, and to anyone who clones the repo. Agents that don't use Cursor can
  still read the file by path. `.claude/skills/write-constitution/SKILL.md`
  is a symlink to that copy, so Claude Code finds the same skill.
- **It is triggered by `/write-constitution` or by plain language.** Do **not**
  set `disable-model-invocation: true`, because that would turn off the plain
  language trigger.
- **It runs only on explicit request.** The description starts with "Use only
  when the user explicitly asks …". That keeps agents from invoking it on their
  own during ordinary feature work, for example a planner that sees the
  constitutions index.
- **The skill folder is the only full copy of the format.** The `AGENTS.md`
  section gives a one-sentence summary and points to the skill. The test
  enforces the parts that can be checked mechanically.
- **The skill writes constitutions and does not amend them.** If a
  constitution already covers the feature, or `docs/constitutions/<slug>.md`
  already exists, the skill stops, proposes an amendment following that
  constitution's own procedure, and leaves the edit to normal feature work.
- **No new dependencies.** The test parses frontmatter with a small parser, not
  a YAML library.

## The constitution format (what the skill produces)

The file is `docs/constitutions/<slug>.md`. `<slug>` is kebab-case and matches
`docs/plans/<slug>.md` when that plan exists.

```md
---
name: <Title Case Name>
description: <What the feature is>. Read before changing <concrete concepts, data, and surfaces>.
status: <draft or ratified>
scope:
  - path/to/owned-file.ts
  - path/to/shared-file.ts (the part in scope)
---

# <Name> constitution

<One paragraph: this document binds changes to `scope`; for shared files only
the part in parentheses; breaking a principle requires an amendment in the same
PR; a silent break is a defect even if tests pass. The frontmatter name and
description are copied word for word into the root AGENTS.md index and checked
by scripts/constitutions.test.ts.>

## What <feature> is for

<Two to four sentences on the feature's job and the value it protects.>

## Principles

### 1. <The rule, stated as a heading.>

**Rule.** <Concrete and checkable against a diff.>

**Why.** <The failure it prevents or the value it protects, naming the real
mechanism: a file, function, test, or AGENTS.md rule. Not a restatement of the
rule.>

**Accepted side effect.** <Optional. A known cost, recorded so nobody "fixes"
it by accident.>

## Non-goals (a PR that adds one of these amends this document)

- <Item> (Principle N)

## Tests

<Which tests protect which principles, consistent with the root AGENTS.md
testing rules: pure tests only, no emulators or DOM library.>

## Amending this constitution

A change that breaks or relaxes a principle must, in the same PR:

1. Edit the principle so it describes the new rule, keeping the **Why**
   accurate. Do not leave the old text in place with an exception bolted on.
2. Add an entry to the amendment log with the principle number, what changed,
   why the change is worth breaking the original intent, what risk the
   original principle guarded against, and how the new design handles that
   risk.
3. Say in the PR description, under a "Constitution amendment" heading, that
   the PR amends `docs/constitutions/<slug>.md`.

A reviewer or verifier who finds a principle broken without an amendment
should treat it as a failing check.

## Amendment log

None yet.
```

Frontmatter rules:
- `name`, `description`, `status`, and `scope` are required.
- Unquoted, single-line values; `scope` items indented exactly two spaces.
- `name` and `description` each fit on one line.
- `description` is at most 300 characters.
- `status` is `draft` or `ratified`. A built feature (already in the code, or its implementing plan has merged) uses `ratified`. An unbuilt feature uses `draft`.
- `scope` has at least one `- ` item.
- Do not repeat `status` in the body.

## The index in root `AGENTS.md`

Put this section immediately before `## Plans`. If it already exists, change
only the second paragraph to the version below.

```md
## Feature constitutions

A constitution records a feature's principles and why each exists. The index
below lists every constitution by name and description only. Before planning
or editing, check your change against these descriptions. If one plausibly
applies, read that constitution in full before you write code; when unsure,
read it. Its frontmatter `scope` lists the exact files and concepts it covers.
You may break a principle only by amending the constitution in the same PR:
rewrite the principle, add an amendment-log entry saying why the break is
worth it, and flag it in the PR description. An unacknowledged break is a
defect. Plans, audits, and verifications name the constitutions they applied.

Create a constitution only when asked, with the `write-constitution` skill
(`.cursor/skills/write-constitution/SKILL.md`), which defines the format.
`scripts/constitutions.test.ts` checks that this index matches each file's
frontmatter.

None yet.
```

Index entries replace "None yet." and use exactly this form, one line each:

```md
- **<name>** (`docs/constitutions/<slug>.md`): <description>
```

## The drift test: `scripts/constitutions.test.ts`

This is a pure Vitest file. `vitest.config.ts` uses the default include, so
`npm test` and CI (`tsc -b` + `npm test`) pick it up with no config or workflow
change. `tsconfig.node.json` includes `scripts`, so `tsc -b` type-checks it.
Keep to `erasableSyntaxOnly`: no enums and no constructor parameter
properties.

Contents:
- `parseFrontmatter(text)` handles only the format above: a leading `---`
  block, `key: value` lines, and a `scope:` key followed by `  - item` lines.
  It returns the parsed fields or a list of errors.
- For every `docs/constitutions/*.md` file, the test checks that:
  - the frontmatter parses;
  - all required keys are present;
  - `status` is valid;
  - `scope` is not empty.
- It parses the index lines inside the `## Feature constitutions` section of
  `AGENTS.md`, meaning the lines that start with `- **`. It fails if:
  - a constitution has no index line;
  - an index line points to a missing file;
  - an index `name` or `description` differs from the frontmatter by even one
    character.
- It passes when there are zero constitutions and the index says "None yet."
- Negative cases on inline fixture strings:
  - frontmatter missing `description` must be reported;
  - a one-character description mismatch must be reported.

## Steps

### 1. [core] Set up the constitution structure

- Do not create `docs/constitutions/` yet. Git does not track empty
  directories, so the first real constitution creates it. The test treats a
  missing directory as zero constitutions.
- Add or adjust the `## Feature constitutions` section in root `AGENTS.md`
  exactly as shown in "The index in root `AGENTS.md`". Keep any index entries
  already present.
- Add `scripts/constitutions.test.ts` as specified. If it already exists, make
  sure it meets the spec: tolerating zero constitutions and both negative
  cases.
- Add a row to the Plans table in `AGENTS.md`:
  `| docs/plans/constitution-skill.md | Implementing. write-constitution skill + constitutions index and drift test. |`

### 2. [core] Write `.cursor/skills/write-constitution/SKILL.md`

Frontmatter:

```yaml
---
name: write-constitution
description: Use only when the user explicitly asks to create, write, or draft a feature constitution (for example "make a constitution for this feature", "write a constitution for X", /write-constitution). Writes docs/constitutions/<slug>.md in the standard format, adds it to the Feature constitutions index in root AGENTS.md, and runs the drift test.
---
```

The body is the workflow below. Write it as instructions to the agent that
runs the skill:

1. **Collect the inputs.** These are the feature name and slug, its job (what
   it is for), and the content the user wants covered: decisions, trade-offs,
   and non-goals. Take whatever the user supplied, whether "job XYZ, content
   XYZ", a plan file, or the conversation. Fill gaps by reading
   `docs/plans/<slug>.md` and the code. Ask the user only for what cannot be
   derived, at most 3 questions, typically which decisions are firm and which
   are provisional.
2. **Check for an existing constitution or overlap.** Read the index in root
   `AGENTS.md`, and check whether `docs/constitutions/<slug>.md` already exists.
   - If a constitution already covers this feature, or that file already
     exists, stop. Propose the amendment following that constitution's
     procedure, and leave the edit to normal feature work. Do not change the
     constitution.
   - If another constitution's `scope` overlaps, cross-reference it rather than
     restating its principles.
3. **Research the mechanisms.** Every **Why** must name a real mechanism or
   risk. For a built feature, confirm with grep that the named files and
   symbols exist, and set `status: ratified`. For an unbuilt feature, set
   `status: draft` and name the planned symbols as planned. A built feature is
   one already in the code, or one whose implementing plan has merged. Status
   lives only in the frontmatter. Do not repeat it in the body.
4. **Write the principles.** Aim for 5–15; fewer is fine if every one is real.
   Follow `template.md`.
   - Each **Rule** must be checkable against a diff.
   - Each **Why** gives the failure prevented or the value protected, not a
     restatement of the rule.
   - Record known costs as **Accepted side effect**.
   - Do not restate general repo rules unless the feature depends on them, and
     then link the `AGENTS.md` section.
   - Include Non-goals, Tests, the verbatim amendment procedure, and the
     Amendment log section, containing None yet.
5. **Write the frontmatter** following the rules in `template.md`. Unquoted,
   single-line values; `scope` items indented exactly two spaces. The
   description follows the pattern "<what the feature is>. Read before
   changing <concrete concepts, data, and surfaces>." Use nouns an agent will
   see in a task, such as type names, routes, and screens. `description` is
   at most 300 characters.
6. **Register it.** Add
   `- **<name>** (\`docs/constitutions/<slug>.md\`): <description>` to the
   index, replacing "None yet." if present. The description must match the
   frontmatter character for character.
7. **Link it.** If `docs/plans/<slug>.md` exists, add a link to the
   constitution at the top of that plan.
8. **Verify.** Run `npx vitest run scripts/constitutions.test.ts` and fix any
   failure. `npm test` must still pass.
9. **Report back.** Give the path, the principle headings, the scope, and the
   assumptions or provisional decisions the user should confirm.

Also state in `SKILL.md`: once `docs/constitutions/cook-log.md` exists, it is
the worked example to imitate. Until then, `template.md` is the only reference.

Add `.claude/skills/write-constitution/SKILL.md` as a relative symlink to
`.cursor/skills/write-constitution/SKILL.md`.

### 3. [core] Write `.cursor/skills/write-constitution/template.md`

This is the skeleton from "The constitution format", including the frontmatter
rules and the amendment procedure word for word. `SKILL.md` refers to it rather
than repeating it.

### 4. [core] Verify

- `npm test` and `npm run build` pass.
- The skill appears in Cursor's `/` menu or skill list. If this can't be
  checked in the environment, say so; don't claim it.
- **Dry run.** Invoke the skill's workflow on a finished feature, such as
  `docs/plans/sync-toast.md`. Confirm that it writes a valid constitution and a
  matching index line, and that the drift test passes. Change the index
  description by one character and confirm the test fails. Then **discard the
  sample**: do not commit the dry-run constitution or its index line.

## Out of scope

- Writing any real constitution, including cook log.
- Enforcing constitutions beyond the index and the drift test: no Cursor
  rules, CI workflow changes, or hooks.
- A skill for amending constitutions.
