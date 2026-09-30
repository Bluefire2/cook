# Replace the hand-rolled HTML scanner in recipe import

Issue [#91](https://github.com/Bluefire2/cook/issues/91). `server/recipeImport.ts`
finds recipe JSON-LD and the article/main region with its own tag scanner.
The cached pages already pass. This slice replaces the scanner so the next
broken page is handled by a real HTML parser, and deletes the scanner once
that parser covers the same product rules.

No UI. This slice deploys nothing.

## BLOCKING

None.

## Constitutions

None apply.

- **i18n** lists `server/recipeImport.ts` only for `lang` on the extraction
  schema and `translateTo`. This slice does not touch those, `RECIPE_SCHEMA`,
  catalogs, or any user-facing string.
- **Image import** lists `server/recipeImport.ts` only for `importFromImages`.
  This slice does not touch that function, the `images` field, or handwritten
  evals.
- **Client state** and **cook log** do not cover HTML extraction.

`evals/AGENTS.md` was read. A parser swap is not a prompt, model, output-check,
retry, or golden change, so it is not a qualifying experiment. Do not log it
in `evals/EXPERIMENTS.md`.

## Decisions (settled — do not reopen while implementing)

1. **Library is `parse5` 8.0.1** (`npm view parse5 version` on 2026-09-30;
   latest dist-tag `8.0.1`). Add `"parse5": "^8.0.1"` to `dependencies`,
   same caret style as the other runtime packages. It is imported by
   `server/recipeImport.ts`, which Cloud Run installs with
   `npm ci --omit=dev`, so it is not a devDependency. Types ship in the
   package; do not add `@types/parse5`. `entities` is its dependency and
   stays transitive. `npm install parse5@8.0.1` updates `package-lock.json`.

   `linkedom` (0.18.13, "A triple-linked lists based DOM implementation")
   is rejected. The repo forbids a DOM testing library, and a DOM
   implementation is the wrong tool for a tree walk in Vitest. `parse5` is
   the HTML parser: `parse(html, { sourceCodeLocationInfo: true })` returns
   a document of elements, text, and comments, with no DOM and no browser.
   It accepts comments, unclosed tags, unquoted attributes, and `>` inside
   quoted attributes. Confirmed on 8.0.1: `type=application/ld+json` and
   `type` after an attribute that contains `>` both yield
   `application/ld+json`; a script inside `<!-- -->` yields no script
   element; an unclosed `<article>` after `<nav>` slices only the article.

2. **`extractRecipeSource(html: string): string` stays the export.** Callers
   (`importFromHtml`, and the tests) do not change. `normalizeImportedRecipe`
   stays the only cleanup of model output.

3. **JSON-LD preference stays this loop.** Only the way script bodies are
   found changes. Keep `collectedText`, `recipeJsonLdHasBody`,
   `recipeNodeSource`, and `NON_RECIPE_JSON_LD_KEYS` as they are:

   - Walk `script` elements in source order. A script counts when its
     `type` attribute, with surrounding whitespace trimmed, equals
     `application/ld+json` case-insensitively. That covers a quoted type
     and the unquoted `type=application/ld+json` minifiers emit.
     `application/ld+jsonp` does not count. A value with extra tokens
     (`application/ld+json extra`, `application/ld+json;charset=utf-8`)
     does not count. The old regex treated some of those as matches
     because `[^>]*` ran after a lookahead; that quirk is not the product
     rule.
   - Take the script's raw text: the source slice from the end of the
     start tag to the start of the end tag (`sourceCodeLocation.startTag.endOffset`
     through `endTag.startOffset`). On 8.0.1 that slice equals the script
     text node for these blocks. `JSON.parse` that string. Do not
     re-serialize the script. Entity decoding belongs to the HTML parser
     for normal text, and script data stays raw either way.
   - Skip a script whose `sourceCodeLocation.endTag` is missing. In
     parse5 8.0.1 `endTag` is optional, and an unclosed `<script>` has
     none (the element span can be empty while its text node holds the
     rest of the file). The current regex only matches when `</script>`
     is present, so an unclosed script is not a JSON-LD candidate.
   - The node walk is unchanged. An array is the node list. Any other
     value uses `parsed['@graph'] ?? [parsed]`. One level only: a Recipe
     nested inside a graph node is not unwrapped further. `@type === 'Recipe'`
     or an array `@type` that `includes('Recipe')` — case-sensitive, as
     now. `recipeJsonLdHasBody`: a node that omits both `recipeIngredient`
     and `recipeInstructions` still counts; a node that lists either and
     whose `collectedText` of both is blank does not (empty Maangchi-style
     shells). The first such node, in walk order, wins. Return
     `recipeNodeSource` (full `JSON.stringify`, or, only when that string
     is longer than 60,000 characters, the same object without `review`,
     `comment`, `aggregateRating`, `interactionStatistic`, and `video`,
     then sliced to 60,000).
   - `JSON.parse` failure, `null`, and a non-iterable `@graph` stay inside
     the existing per-block `try/catch`: skip that block and keep looking.
   - Scripts inside comments are not scripts. A Recipe that exists only
     inside `<!-- -->` does not win.

4. **Otherwise the text path is unchanged in form.** `stripToText` and
   `regionTextLength` stay, and they run on slices of the **original**
   HTML, not on parser text nodes and not on `serialize`. Parser text
   decodes entities (`&nbsp;` becomes U+00A0, `&amp;` becomes `&`).
   `stripToText` only rewrites `&nbsp;` and leaves every other entity
   encoded. Serializing would also add `<html>` / `<body>` and change
   the bytes under the 60,000 cap.

   `stripToText`, kept verbatim:

   ```ts
   html
     .replace(/<script[\s\S]*?<\/script>/gi, ' ')
     .replace(/<style[\s\S]*?<\/style>/gi, ' ')
     .replace(/<[^>]+>/g, ' ')
     .replace(/&nbsp;/gi, ' ')
     .replace(/\s+/g, ' ')
     .slice(0, MAX_SOURCE_CHARS); // 60000, no trim
   ```

   `regionTextLength`, kept verbatim (script and style **bodies still
   count**; this is not `stripToText`):

   ```ts
   region.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
   ```

   Region choice, kept verbatim, applied to original-HTML slices of the
   parser's elements:

   ```ts
   if (article && main) {
     if (regionTextLength(article) * 2 >= regionTextLength(main)) return article;
     return main;
   }
   return article ?? main ?? html;
   ```

   - `article` is the slice of the `article` element with the greatest
     `regionTextLength`. `main` is the slice of the greatest element that
     is a `main` tag **or** whose `role` attribute, trimmed, equals `main`
     case-insensitively. Equal lengths keep the earlier candidate in
     source order (`longestRegion` uses `len > bestLen`, not `>=`).
     `role=main`, `role="main"`, and `role='main'` all count.
     `role=main-content` and `role="main navigation"` do not. The old
     scanner's `\b` made `role=main-content` count; that is not the
     product rule.
   - An `<article role="main">` is in both sets. Equal lengths then keep
     the article, because `length * 2 >= length`.
   - Nested articles are separate candidates. The outer one wins when it
     is longer, which is the usual case, so a header teaser or a nested
     related-story card does not replace the story.
   - No qualifying element: `stripToText` of the original string, not of
     a serialized document.
   - Skip an element whose `sourceCodeLocation` is missing (implied nodes
     the parser invented). `endOffset` is exclusive.
   - Parse with the defaults (`scriptingEnabled` stays `true`). Do not
     turn `<noscript>` contents into elements to imitate the old regex.

5. **Delete the scanner once the parser covers the rules above.** Delete
   `HtmlTag`, `isTagStart`, `tagEnd`, `scanTags`, `balancedElement`, and
   `longestRegion`. Rewrite `primaryRegion`. Delete the
   `application/ld+json` regex in `extractRecipeSource`.

## Non-goals

- Leave `normalizeImportedRecipe`, `importFromSource`, `importFromImages`,
  `fetchPageHtml`, `RECIPE_SCHEMA`, prompts, model settings, output checks,
  and retry as they are.
- Leave `evals/**/golden.json`, `evals/import-handwritten/`, and
  `evals/EXPERIMENTS.md` as they are. Do not open holdout image cards.
- Do not run `npm run test:import` or `npm run eval:ocr-compare`.
- No UI, no `src/i18n/` edits, no privacy or terms edits.
- Do not rewrite fixture `page.html` files.
- Do not change `extension/extract-page.js`. It prunes the live tab; it is
  not this scanner.
- Do not add jsdom, linkedom, or any other DOM library.
- Do not replace article/main selection with a readability heuristic.

## Steps

### 1. [core] Plans table row

This file is the plan. Append one row to the Plans table in `AGENTS.md`.
Do not add a second row later.

```
| `docs/plans/html-parser-recipe-import.md` | Open, not started. Replace the hand-rolled HTML scanner in `server/recipeImport.ts` with parse5 (issue #91). |
```

### 2. [core] Add `parse5`

`npm install parse5@8.0.1`. Confirm `package.json` `dependencies` contains
`"parse5": "^8.0.1"` and that `package-lock.json` updated. Do not add
`@types/parse5`, `linkedom`, or `jsdom`.

`tsconfig.node.json` typechecks `server/` with `verbatimModuleSyntax` and
`erasableSyntaxOnly`. Import `parse` as a value. Any parse5 types use
`import type`. No enums and no constructor parameter properties in our code.

### 3. [core] Replace extraction internals

In `server/recipeImport.ts` only:

- `parse(html, { sourceCodeLocationInfo: true })`.
- Walk elements in source order, including `template.content`. Collect
  `script` elements for Decision 3 and `article` / main candidates for
  Decision 4. Comments are not elements; do not read them.
- Feed each matching script's raw text into the existing JSON-LD loop.
- Choose the region with the existing `* 2` rule on original slices, then
  `stripToText`.
- Delete `scanTags` and the helpers named in Decision 5.
- Update the comment on `extractRecipeSource` so it describes the parser
  and the same product rules (unquoted `type`, `@graph`, empty Recipe
  shells, article yielding to main). Leave the `stripToText` and
  `regionTextLength` comments accurate, including that a `>` inside a
  quoted attribute can still leak into the text fallback. That leak is
  `stripToText`. Do not rewrite `stripToText` to fix it.

`extension/extract-page.js` stays. Its closing-tag note is about the
extension's own cap, not this function.

### 4. [core] Unit tests for markup the scanner mis-reads

Add cases to `describe('extractRecipeSource')` in
`server/recipeImport.test.ts`. The existing cases in that block stay, and
they must still pass, including unquoted `type=application/ld+json`, the
`ld+jsonp` rejection, `@graph`, blank Recipe shells, the 60,000 caps,
`&nbsp;`, nested articles, `role="main"`, and the bare `<350°F` comparison.

New cases, each of which the current scanner gets wrong:

- **`>` inside an earlier attribute.**  
  `<script data-note="Say 'heat > 180'" type="application/ld+json">` plus
  a Recipe object that has ingredients, then `<p>Plain page</p>`. Expect
  the Recipe object. The regex stops at the `>` and returns the paragraph.
- **Comment.** A Recipe script that has ingredients, wrapped in
  `<!-- -->`, then `<p>Real ingredients: beets</p>`. Expect text that
  contains `beets` and does not contain the decoy recipe name. The regex
  returns the decoy object.
- **Unclosed quote that stops the scan.** A long `<nav>` (same shape as
  the existing "Menu item" nav) and then  
  `<article><div data-x="foo><span>nope</span></div><p>Ingredients: beets</p></article>`.  
  Expect `beets` and no `Menu item`. `tagEnd` never finds a `>` outside
  the quote, `scanTags` stops, and the nav eats the cap.
- **Unclosed article.** The same long nav and  
  `<article><h1>Borscht</h1><p>Ingredients: beets` with no `</article>`.  
  Expect `Borscht` and `beets` and no `Menu item`. The scanner has no
  balanced article, so it returns the whole page.

Keep these as plain strings and `extractRecipeSource`. No DOM, no fixture
HTML, no Gemini.

### 5. [core] Cached pages

Run the extraction step over every cached page before editing any
expectation:

```
npx vitest run evals/pageFixtures.test.ts
```

`evals/pageFixtures.test.ts` compares the branch (`jsonld` or `text`), and
for text only `mustContain`. It does not snapshot the whole string. A
same-branch run with the same words needs no edit. Do not rewrite
`page.html`.

When a fixture fails, diff it before changing `EXPECTED`:

- The new text is the recipe that fixture was meant to capture (the Recipe
  node that actually has ingredients or steps, or the article/main text
  that contains the dish): update that `EXPECTED` entry and add a comment
  on it, in the same style as the food.com and Love & Lemons notes.
- The new text is worse — nav or chrome included, the recipe dropped, or
  a real Recipe JSON-LD missed so a `jsonld` fixture flips to `text`:
  that is a bug in the port. Fix step 3. Do not edit `EXPECTED` to absorb
  it.

`import-sites/wikibooks-pancake` is the only `text` entry today. The others
expect `jsonld`. Love & Lemons is the unquoted-type page; it has to stay
`jsonld`.

A green run is not proof the extracted bytes were unchanged. `jsonld`
checks only the branch, and the wikibooks `text` check only `mustContain`.
After the test passes, diff `extractRecipeSource` on every cached
`page.html` against the pre-change function (run the old scanner from
`git show HEAD:server/recipeImport.ts` in a scratch file outside the
repo, or compare before editing). A same-string diff needs no
`EXPECTED` edit. A different string follows the failure rule above:
update `EXPECTED` only when the new text is the recipe that fixture was
meant to capture; otherwise fix step 3.

## Risks

`parse5` and the regex will disagree on malformed markup. That is the point
of the swap, and it can still change bytes on a cached page when the chosen
slice differs: implied end tags, a comment the regex used to treat as a
script, or a `<noscript>` the regex used to parse as tags (`scriptingEnabled`
stays at the default `true`). Whitespace and entities stay put whenever the
slice is the same string the scanner would have cut, because `stripToText`
still runs on that slice.

The implementer diffs fixture failures and accepts a change only when the
new text is more correct. A fixture that gets worse (nav or chrome included,
recipe dropped) is a bug in the port, not a fixture update.

## Verification

- `npm test` — `server/recipeImport.test.ts` and `evals/pageFixtures.test.ts`
  are both in this run.
- `npm run build` — `tsc -b` is the only typecheck of `server/`.
- Do not run `npm run test:import` or `npm run eval:ocr-compare`.
