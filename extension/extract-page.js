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
   * Over the cap, the linked-data blocks are moved ahead of the cut in their
   * original relative order — `extractRecipeSource` returns the first Recipe
   * node it finds, so reordering them could select a different recipe. A block
   * the cut bisects simply fails the closing-tag match and the import falls
   * back to the stripped-text path, which is intended.
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
    if (hoisted.length >= limit) {
      return hoisted.slice(0, limit);
    }
    return hoisted + html.slice(0, limit - hoisted.length);
  }

  const clone = document.documentElement.cloneNode(true);
  const doc = document.implementation.createHTMLDocument('');
  doc.replaceChild(doc.importNode(clone, true), doc.documentElement);
  prune(doc);

  return { url: location.href, html: capped(doc, maxChars) };
}
