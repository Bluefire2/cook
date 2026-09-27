---
name: write-constitution
description: Use only when the user explicitly asks to create, write, or draft a feature constitution (for example "make a constitution for this feature", "write down the principles for X", /write-constitution). Writes docs/constitutions/<slug>.md in the standard format, adds it to the Feature constitutions index in root AGENTS.md, and runs the drift test.
---

# write-constitution

Write a feature constitution and register it in the root `AGENTS.md` index.
This skill writes constitutions. It does not amend one that already exists.

Once `docs/constitutions/cook-log.md` exists, it is the worked example to
imitate. Until then, `template.md` in this folder is the only reference. Read
`template.md` and follow its skeleton, frontmatter rules, and amendment
procedure.

## 1. Collect the inputs

Collect the feature name and slug, its job (what it is for), and the content
the user wants covered: decisions, trade-offs, and non-goals. Take whatever
the user supplied, whether "job XYZ, content XYZ", a plan file, or the
conversation. Fill gaps by reading `docs/plans/<slug>.md` and the code. Use
AskQuestion only for what cannot be derived, at most 3 questions, typically
which decisions are firm and which are provisional.

`<slug>` is kebab-case. When `docs/plans/<slug>.md` exists, use that same slug.

## 2. Check for an existing constitution or overlap

Read the Feature constitutions index in root `AGENTS.md`.

- If a constitution already covers this feature, stop and propose an amendment
  following that constitution's procedure. Wait for the user to confirm.
- If another constitution's `scope` overlaps, cross-reference it rather than
  restating its principles.

## 3. Research the mechanisms

Every **Why** must name a real mechanism or risk. For a built feature, confirm
with grep that the named files and symbols exist. For an unbuilt feature, use
`status: draft` and name the planned symbols as planned.

## 4. Write the principles

Write `docs/constitutions/<slug>.md` from `template.md`. Aim for 5–15 principles.

- Each **Rule** must be checkable against a diff.
- Each **Why** gives the failure prevented or the value protected, not a
  restatement of the rule.
- Record known costs as **Accepted side effect**.
- Do not restate general repo rules unless the feature depends on them, and
  then link the `AGENTS.md` section.
- Include Non-goals, Tests, the verbatim amendment procedure from `template.md`,
  and "Amendment log: None yet."

Use `status: draft` until the implementing plan has merged. Set
`status: ratified` only after that merge.

## 5. Write the frontmatter

Follow the frontmatter rules in `template.md`. The description follows the
pattern "<what the feature is>. Read before changing <concrete concepts, data,
and surfaces>." Use nouns an agent will see in a task, such as type names,
routes, and screens. `name` and `description` each fit on one line, and
`description` is at most about 300 characters. `scope` lists the owned files,
and for a shared file names the part in parentheses.

## 6. Register it

Add this line to the Feature constitutions index in root `AGENTS.md`, replacing
`None yet.` when that placeholder is present:

```md
- **<name>** (`docs/constitutions/<slug>.md`): <description>
```

`<name>` and `<description>` must match the frontmatter character for character,
including spaces. One line per constitution.

## 7. Link it

If `docs/plans/<slug>.md` exists, add a link to the constitution at the top of
that plan, immediately under the title:

```md
Constitution: `docs/constitutions/<slug>.md`
```

## 8. Verify

Run `npx vitest run scripts/constitutions.test.ts` and fix any failure. `npm test`
must still pass.

## 9. Report back

Give the path, the principle headings, the scope, and the assumptions or
provisional decisions the user should confirm.
