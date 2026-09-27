# Constitution template

The file is `docs/constitutions/<slug>.md`. `<slug>` is kebab-case and matches
`docs/plans/<slug>.md` when that plan exists.

```md
---
name: <Title Case Name>
description: <What the feature is>. Read before changing <concrete concepts, data, and surfaces>.
status: draft
scope:
  - path/to/owned-file.ts
  - path/to/shared-file.ts (the part in scope)
---

# <Name> constitution

Status: draft. It becomes ratified when <the implementing plan> merges. At that
point, set `status: ratified` in the frontmatter.

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
- `name` and `description` each fit on one line.
- `description` is at most about 300 characters.
- `status` is `draft` or `ratified`.
- `scope` has at least one `- ` item.
- `ratified` is allowed only once the feature has merged.
