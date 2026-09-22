/**
 * Serialized into the page by `chrome.scripting.executeScript({ func })`, which
 * passes it through `toString()`. It therefore closes over nothing: the cap
 * arrives in `args`, and every helper is nested inside the function body.
 *
 * This prunes the DOM; it does not parse recipes. `extractRecipeSource` in
 * `api/import.ts` stays the only thing that knows what a schema.org/Recipe
 * block looks like.
 */
export function grabPageSource(maxChars) {
  const LD_JSON = 'script[type="application/ld+json"]';
  // News-article recipes (AP News, etc.) often have no schema.org/Recipe block
  // and live inside <main>/<article> after hundreds of KB of chrome. The cap
  // would otherwise send only the nav.
  const PRIMARY = 'article, main, [role="main"]';
  const MARKERS = ['ingredient', 'ingredients', 'recipe', 'kapusnyak', 'sauerkraut', 'pork'];

  function prune(doc) {
    for (const node of doc.querySelectorAll('style, noscript, svg, iframe, canvas, template')) {
      node.remove();
    }
    for (const node of doc.querySelectorAll('script')) {
      if (node.getAttribute('type') !== 'application/ld+json') {
        node.remove();
      }
    }
  }

  /**
   * Over the cap, linked-data blocks and the primary content regions are moved
   * ahead of the cut in their original relative order. `extractRecipeSource`
   * returns the first Recipe node it finds, so reordering ld+json blocks could
   * select a different recipe. A block the cut bisects simply fails the
   * closing-tag match and the import falls back to the stripped-text path,
   * which is intended.
   */
  function capped(doc, limit) {
    const html = doc.documentElement.outerHTML;
    if (html.length <= limit) {
      return html;
    }
    let hoisted = '';
    for (const block of doc.querySelectorAll(LD_JSON)) {
      hoisted += block.outerHTML;
    }
    for (const node of doc.querySelectorAll(PRIMARY)) {
      hoisted += node.outerHTML;
    }
    if (hoisted.length >= limit) {
      return hoisted.slice(0, limit);
    }
    return hoisted + html.slice(0, limit - hoisted.length);
  }

  function hits(text) {
    const lower = text.toLowerCase();
    return MARKERS.filter((word) => lower.includes(word));
  }

  const clone = document.documentElement.cloneNode(true);
  const doc = document.implementation.createHTMLDocument('');
  doc.replaceChild(doc.importNode(clone, true), doc.documentElement);
  prune(doc);

  const primaries = [];
  for (const node of doc.querySelectorAll(PRIMARY)) {
    primaries.push({
      tag: node.tagName,
      className: typeof node.className === 'string' ? node.className : '',
      htmlChars: node.outerHTML.length,
      textChars: (node.textContent || '').replace(/\s+/g, ' ').trim().length,
    });
  }

  const html = capped(doc, maxChars);
  const visible = document.body && document.body.innerText ? document.body.innerText : '';
  const visibleCompact = visible.replace(/\s+/g, ' ').trim();
  const debug = {
    url: location.href,
    htmlChars: html.length,
    uncappedChars: doc.documentElement.outerHTML.length,
    visibleChars: visibleCompact.length,
    visibleHead: visibleCompact.slice(0, 160),
    ldJsonCount: doc.querySelectorAll(LD_JSON).length,
    primaryCount: primaries.length,
    primaries,
    hasMain: /<main\b/i.test(html),
    hasArticle: /<article\b/i.test(html),
    hits: hits(html),
  };
  // Page console (the tab) and, via the return value, the popup console.
  console.info('sous grab', debug);

  return { url: location.href, html, debug };
}
