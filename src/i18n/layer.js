// The language layer: translates the page in place once React has hydrated it, and keeps it translated.
// Only text node values and a few attribute values change; no node is added, moved or removed, so React
// goes on updating the page as before. When React writes new English text, the observer translates it again
// before the browser paints. Text the dictionary doesn't know stays English.

const ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];
const WITH_ATTRIBUTES = '[placeholder], [title], [aria-label], [alt]:not([alt=""]), meta[name="description"]';
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "svg"]);
// set on <html> once the page is translated; until then it stays hidden (see Translate.js)
const MARK = "data-i18n";

// Where the page shows names and titles from the library or from YouTube. These are never translated, so a
// category called "Home" or a video called "Settings" stays as it is. Found from the page structure.
const DATA = [
  'a[href="/"] > span', // the logo's word mark
  '[class*="_chips"] > button:not(:first-child)', // category chips after "All" (home, Shorts)
  '[class*="_upNextChips"] > button:nth-last-child(n+3)', // up next: the category chip, before "From …" and "All"
  "nav section > div > button > span", // sidebar: category names
  'nav a[href^="/channel/"]', // sidebar: channel names
  'a[href^="/watch/"] h3', // video titles on cards
  'a[href^="/shorts/"] h3', // Short titles on cards
  'a[href^="/watch/"] h3 + span', // the channel under a card's title
  "div > h1", // the watch page's video title, the channel page's name
  'a[href^="/channel/"] b', // the channel next to a video or a Short
  'a[href^="/channel/"] + p', // a Short's title
  'li > a[href^="/channel/"]', // Settings › Storage: channels
  "[data-open] > p", // a video's description
  '[role="dialog"] b', // autoplay: the next video's title
  '[class*="_importTitle"]', // Get videos: titles on YouTube
].join(",");
// what the interface itself puts in those places when there is no name
const FALLBACKS = new Set(["Unknown channel", "No description."]);
// a category <option> carries the category's id
const ID = /^[0-9a-f]{24}$/;
// a download error from YouTube, shown in full on hover: kept in English like the message itself
const RAW_TITLE = '[class*="_error"][title], [class*="_waiting"][title]';

const own = (el) =>
  el.matches(DATA) ||
  (el.tagName === "OPTION" && ID.test(el.value)) ||
  // "<video or channel> · HomeTube" while the page shows one
  (el.tagName === "TITLE" && !!document.querySelector("div > h1"));

const inherited = (el) => !!el.parentElement?.closest(DATA);
const isData = (el) => own(el) || inherited(el);

export const start = (tr, lang) => {
  const root = document.documentElement;
  // text node → the English text React wrote last
  const english = new WeakMap();
  // element → { attribute: [English, shown] }
  const attributes = new WeakMap();
  const stats = { firstPass: 0, firstPassElements: 0, callbacks: 0, lastCallback: 0, maxCallback: 0 };

  // what React wrote: the English we keep for a text node we changed, else its value
  const source = (node) => (english.has(node) ? english.get(node) : node.nodeValue);

  const show = (node, value) => {
    if (node.nodeValue === value) return;
    if (!english.has(node)) english.set(node, node.nodeValue);
    node.nodeValue = value;
  };

  // One run of an element's own text nodes, which child elements break. React renders `{n} videos · {size}` as
  // several text nodes: a run is translated as a whole and shown in its first node, the others left empty.
  const translateRun = (nodes, data, beforeElement) => {
    if (nodes.length === 1) {
      const node = nodes[0];
      const text = source(node);
      const out = data ? FALLBACKS.has(text.trim()) && tr.run(text) : tr.run(text) ?? (beforeElement && tr.prefix(text));
      show(node, out || text);
      return;
    }
    const parts = nodes.map(source);
    const joined = parts.join("");
    const out = data ? null : tr.run(joined) ?? (beforeElement ? tr.prefix(joined) : null);
    if (out != null) {
      nodes.forEach((n, i) => show(n, i ? "" : out));
      return;
    }
    // nothing for the run as a whole: each node on its own ("Retrying automatically" + " at 22:31")
    nodes.forEach((n, i) => show(n, (!data && tr.run(parts[i])) || parts[i]));
  };

  const translateText = (el, data) => {
    let nodes = null;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) (nodes ||= []).push(n);
      else if (n.nodeType === 1 && nodes) {
        translateRun(nodes, data, true);
        nodes = null;
      }
      // comments (React's <!-- --> between text nodes) don't break a run
    }
    if (nodes) translateRun(nodes, data, false);
  };

  const translateAttributes = (el, data) => {
    const names = el.tagName === "META" ? (el.getAttribute("name") === "description" ? ["content"] : []) : ATTRIBUTES;
    for (const name of names) {
      const value = el.getAttribute(name);
      let seen = attributes.get(el);
      if (value === null) {
        if (seen) delete seen[name];
        continue;
      }
      if (!seen) attributes.set(el, (seen = {}));
      const [before, shown] = seen[name] || [];
      // a value we didn't write is React's (new) English
      const text = value === shown ? before : value;
      const keep = data || (name === "title" && el.matches(RAW_TITLE));
      const out = (!keep && tr.run(text)) || text;
      seen[name] = [text, out];
      if (value !== out) el.setAttribute(name, out);
    }
  };

  // Text first, element by element (data: an ancestor shows names or titles), then the attributes, found in one query.
  const walk = (top) => {
    let count = 0;
    const visit = (el, data) => {
      if (SKIP.has(el.tagName)) return;
      const inData = data || own(el);
      count += 1;
      if (el.firstChild) translateText(el, inData);
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) visit(c, inData);
    };
    visit(top, inherited(top));
    if (top.matches(WITH_ATTRIBUTES)) translateAttributes(top, isData(top));
    top.querySelectorAll(WITH_ATTRIBUTES).forEach((el) => translateAttributes(el, isData(el)));
    return count;
  };

  const ready = () => {
    if (root.getAttribute(MARK) !== lang) root.setAttribute(MARK, lang);
    if (root.lang !== lang) root.lang = lang;
  };

  const observer = new MutationObserver((records) => {
    const t0 = performance.now();
    const added = new Set();
    const changed = new Set();
    const touched = new Set();
    for (const r of records) {
      if (r.type === "characterData") {
        // React wrote this text node: that is its English now
        english.set(r.target, r.target.nodeValue);
        if (r.target.parentElement) changed.add(r.target.parentElement);
      } else if (r.type === "childList") {
        changed.add(r.target);
        r.addedNodes.forEach((n) => n.nodeType === 1 && added.add(n));
      } else if (r.target === root) {
        // React put <html> back together (a new root layout): mark it again
        ready();
      } else {
        touched.add(r.target);
      }
    }
    added.forEach((el) => el.isConnected && walk(el));
    changed.forEach((el) => el.isConnected && !SKIP.has(el.tagName) && translateText(el, isData(el)));
    touched.forEach((el) => el.isConnected && translateAttributes(el, isData(el)));
    // our own writes above queued records too: drop them
    observer.takeRecords();
    const ms = performance.now() - t0;
    stats.callbacks += 1;
    stats.lastCallback = ms;
    stats.maxCallback = Math.max(stats.maxCallback, ms);
  });

  const t0 = performance.now();
  stats.firstPassElements = walk(root);
  stats.firstPass = performance.now() - t0;
  ready();
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES, "content", MARK],
  });

  // for checking a dictionary against the running app: what is still English, and how long the passes take
  window.__i18n = {
    stats,
    missing: () => {
      const out = [];
      const tree = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = tree.nextNode(); n; n = tree.nextNode()) {
        const el = n.parentElement;
        const text = n.nodeValue.trim();
        if (!el || text.length < 2 || !/[A-Za-z]/.test(text) || el.closest("script,style,noscript,svg")) continue;
        if (n.nodeValue !== source(n) || tr.kept(text) || isData(el)) continue;
        // translated to the same text ("320 MB"), or a message shown in full on hover too, such as a download error
        if (tr.run(n.nodeValue) === n.nodeValue || el.getAttribute("title") === text) continue;
        out.push({ text, visible: !!el.getClientRects().length, tag: el.tagName.toLowerCase() });
      }
      document.body.querySelectorAll(ATTRIBUTES.map((a) => `[${a}]`).join(",")).forEach((el) => {
        if (isData(el)) return;
        ATTRIBUTES.forEach((name) => {
          const value = el.getAttribute(name);
          const seen = attributes.get(el)?.[name];
          if (name === "title" && el.matches(RAW_TITLE)) return;
          if (!value || !/[A-Za-z]/.test(value) || tr.kept(value) || (seen && seen[0] !== seen[1])) return;
          out.push({ text: value, attribute: name, visible: !!el.getClientRects().length, tag: el.tagName.toLowerCase() });
        });
      });
      return out;
    },
  };

  return () => {
    observer.disconnect();
    delete window.__i18n;
  };
};
