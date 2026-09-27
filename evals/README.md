# Eval fixtures and their sources

Recipe pages here are cached copies of other people's work. Each belongs to
its author and publisher; the copies exist only so `npm run test:import`
runs offline and repeatably, without fetching at eval time. Do not publish,
redistribute, or serve them.

Every page fixture's `sourceUrl.txt` has the page URL on its first line,
then `#` lines naming the site, recipe and author, plus how and when the
page was fetched. The table below lists the same information in one place.

## `evals/import/`

Wired into `evals/recipeImport.eval.ts`, with `golden.json` expected results.
The harness lives here rather than in `server/` so it is not copied into the
runtime image.

| Fixture | Site | Recipe | Author | Notes |
| --- | --- | --- | --- | --- |
| `beef-noodle-soup` | The Woks of Life | [Taiwanese Beef Noodle Soup: In an Instant Pot or On the Stove](https://thewoksoflife.com/taiwanese-beef-noodle-soup-instant-pot/) | Kaitlin (The Woks of Life) |  |
| `beef-stew` | Serious Eats | [All-American Beef Stew](https://www.seriouseats.com/all-american-beef-stew-recipe) | J. Kenji López-Alt | Cached from a Wayback Machine snapshot (see below). |
| `gumbo` | Red Beans and Eric | [Chef Isaac Toups Chicken and Sausage Gumbo](https://redbeansanderic.com/chef-isaac-toups-chicken-and-sausage-gumbo/) | Red Beans and Eric (recipe credited to chef Isaac Toups) |  |

| Fixture | Source |
| --- | --- |
| `pomodoro` | Pasted-text fixture. No external source is recorded; added in PR #1. |
| `messy-sections` | Pasted-text fixture. No external source is recorded; added in PR #1. |
| `not-a-recipe` | Pasted-text fixture (deliberately not a recipe). No external source is recorded; added in PR #1. |

## `evals/import-handwritten/`

Photos of handwritten recipes, for the photo import path
(`importFromImages`). Bound by `docs/constitutions/image-import.md`.
`evals/handwrittenFixtures.ts` discovers whatever is here.

Ten single-page fixtures, added 2026-09-27 from publicly accessible photos the
repo owner supplied as stock images. Their redistribution licences have not
been independently verified; each `source.txt` records the original file name.
Goldens were transcribed from the photos by hand-checked model reading and
still need the owner's review.

| Fixture | What it tests |
| --- | --- |
| `blueberry-muffins` | Low-resolution scan (500 px wide); yield written as "Makes 1 dozen". |
| `broccoli-salad` | Ingredients only, no method: the importer must not invent steps. |
| `choc-pie-tea-towel` | Handwriting printed on a tea towel, photographed at an angle with props. |
| `hundred-good-cookies` | Two ingredient columns; card continues on the back ("over"). |
| `lemon-tea-bread` | Loose cursive on a printed card; card continues on the back ("over"). |
| `peanut-butter-cookies` | Two ingredient columns, ditto marks, no mixing method written. |
| `potatoe-pancakes-platter` | Block capitals on a decorated platter; misspelled title kept as written. |
| `split-pea-soup` | Filled-in printed card at an angle; "Serves 8" written; a correction above the line. |
| `sweet-sour-pork` | Heavily stained card; numbered steps. |
| `taffy-apple-salad` | Braces group ingredients with the method written beside them; a quantity range (4-6). |

**Layout.** One directory per fixture:

```
<name>/page-1.jpg … page-4.jpg   # or .jpeg, .png, .webp; 1–4 pages, numbered from 1
<name>/golden.json               # an ImportedRecipe of what is actually written
<name>/source.txt                # provenance and permission, see below
```

`golden.json` records what the pages say, not a tidied-up recipe: servings
`1` if none is written, no invented quantities.

**`source.txt` format.** The first lines are:

```
provenance: <whose notes, when written, how photographed>
permission: <owner's own notes | written permission from …, date>
```

then any `#` notes.

**Preparation.** Pages must look like what the app sends: upright, at most
2048 px on the long edge, JPEG at about 85, and metadata stripped. For
example:

```bash
magick in.heic -auto-orient -resize '2048x2048>' -quality 85 -strip page-1.jpg
```

The harness rejects EXIF, more than 4 pages, gaps in the numbering, and any
page `checkImportImages` would refuse. A broken fixture fails the run with
`evals/import-handwritten/<name>: <problem>`; it is never skipped silently.

**Warning.** This repository is **public**. Committing a fixture publishes
the photo. Only commit the owner's own notes, or notes with recorded
permission to publish, and never other people's private notes.

**Running.** `npm run test:import` runs the handwritten suite alongside the
others, and shows `1 skipped` when there are no fixtures.
`npm run eval:ocr-compare` compares A (the photos straight to Gemini, as
production does) with B (Cloud Vision OCR, then Gemini on the text), with
latency, tokens, estimated cost, and the judge's verdict per fixture. Pass
fixture names to limit it and `--runs=N` (1–5) to repeat. B needs
Application Default Credentials and `vision.googleapis.com` enabled on
`cooking-assistant-508423`, and is skipped with a message otherwise. It
prints to stdout only and writes no files.

## `evals/import-sites/`

22 pages from a spread of site types, fetched 2026-09-23 with a desktop Chrome
User-Agent. No goldens yet; not wired into the harness.

| Fixture | Site | Recipe | Author | Notes |
| --- | --- | --- | --- | --- |
| `atk-chicken-noodle-soup` | America's Test Kitchen | [Old-Fashioned Chicken Noodle Soup](https://www.americastestkitchen.com/recipes/10555-old-fashioned-chicken-noodle-soup) | Morgan Bolling |  |
| `bbcgoodfood-bolognese` | BBC Good Food | [The best spaghetti bolognese](https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe) | Andrew Balmer |  |
| `cookpad-bbq-chicken` | Cookpad | [Easy Sweet & Sour BBQ Chicken](https://cookpad.com/us/recipes/347447-easy-chicken-fried-rice) | ChefDoogles (Cookpad user) | The URL slug says "chicken fried rice"; the page is this recipe. |
| `delish-marry-me-chicken` | Delish | [Creamy Tuscan Chicken (Marry Me Chicken)](https://www.delish.com/cooking/recipe-ideas/a19636089/marry-me-chicken-recipe/) | Lena Abraham |  |
| `foodcom-banana-bread` | Food.com | [Best Banana Bread](https://www.food.com/recipe/best-banana-bread-2886) | lkadlec (Food.com user) |  |
| `giallozafferano-carbonara` | GialloZafferano | [Spaghetti alla Carbonara](https://ricette.giallozafferano.it/Spaghetti-alla-Carbonara.html) | GialloZafferano |  |
| `hebbarskitchen-paneer-butter-masala` | Hebbar's Kitchen | [Paneer Butter Masala (Restaurant Style)](https://hebbarskitchen.com/paneer-butter-masala-recipe/) | Archana (Hebbar's Kitchen) |  |
| `indianhealthyrecipes-chicken-biryani` | Swasthi's Recipes | [Chicken Biryani](https://www.indianhealthyrecipes.com/chicken-biryani-recipe/) | Swasthi Shreekanth |  |
| `justonecookbook-okonomiyaki` | Just One Cookbook | [Okonomiyaki](https://www.justonecookbook.com/okonomiyaki/) | Namiko Hirasawa Chen |  |
| `kingarthur-sandwich-bread` | King Arthur Baking | [Classic Sandwich Bread](https://www.kingarthurbaking.com/recipes/classic-sandwich-bread-recipe) | PJ Hamel |  |
| `loveandlemons-guacamole` | Love and Lemons | [Best Guacamole](https://www.loveandlemons.com/guacamole-recipe/) | Jeanine Donofrio |  |
| `marmiton-boeuf-bourguignon` | Marmiton | [Boeuf bourguignon](https://www.marmiton.org/recettes/recette_boeuf-bourguignon_18889.aspx) | Marmiton contributor (listed as "Anonyme") |  |
| `natashaskitchen-borscht` | Natasha's Kitchen | [Classic Borscht (Beet Soup)](https://natashaskitchen.com/classic-russian-borscht-recipe/) | Natasha Kravchuk |  |
| `nytcooking-chocolate-chip-cookies` | NYT Cooking (The New York Times) | [Best Chocolate Chip Cookies](https://cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies) | David Leite |  |
| `ottolenghi-shakshuka` | Ottolenghi | [Shakshuka](https://ottolenghi.co.uk/pages/recipes/shakshuka) | Ottolenghi | The page credits the recipe to the book Jerusalem. |
| `patijinich-chicken-tinga` | Pati Jinich | [Chicken Tinga](https://patijinich.com/chicken-tinga/) | Pati Jinich |  |
| `recipetineats-chicken-chow-mein` | RecipeTin Eats | [Chow Mein](https://www.recipetineats.com/chicken-chow-mein/) | Nagi Maehashi (RecipeTin Eats) |  |
| `seriouseats-chocolate-chip-cookies` | Serious Eats | [The Food Lab's Chocolate Chip Cookies](https://www.seriouseats.com/the-food-lab-best-chocolate-chip-cookie-recipe) | J. Kenji López-Alt |  |
| `spendwithpennies-beef-stew` | Spend With Pennies | [Beef Stew](https://www.spendwithpennies.com/beef-stew-recipe/) | Holly Nilsson |  |
| `tasty-garlic-parmesan-pasta` | Tasty (BuzzFeed) | [One-Pot Garlic Parmesan Pasta](https://tasty.co/recipe/one-pot-garlic-parmesan-pasta) | Tasty |  |
| `wikibooks-pancake` | Wikibooks | [Cookbook:Pancake](https://en.wikibooks.org/wiki/Cookbook:Pancake) | Wikibooks contributors | Licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). |
| `woksoflife-ma-po-tofu` | The Woks of Life | [Mapo Tofu: The Real Deal](https://thewoksoflife.com/ma-po-tofu-real-deal/) | Kaitlin (The Woks of Life) |  |

Wikibooks content: "Cookbook:Pancake", Wikibooks contributors,
https://en.wikibooks.org/wiki/Cookbook:Pancake, licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
