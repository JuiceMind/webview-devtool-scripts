// Inspector tool for the JuiceMind web preview.
//
// Injected into served student pages alongside eruda.js/devtools.js. The
// parent IDE toggles it with postMessage({type: 'setInspector', enabled}).
// While enabled, hovering an element draws a highlight box plus a
// "tag #id .class" chip, and the element's descriptor is posted to the parent
// so it can highlight the matching source code. Clicking pins the highlight,
// posts an 'inspectorSelect' descriptor, and turns the inspector off
// (the parent syncs its toggle button from that message).
//
// Reverse direction ("Live Highlight"): the parent can also push highlights
// INTO the page — {type: 'highlightFromSource', domPath} draws an overlay on
// the element at that structural path (editor cursor inside an HTML tag), and
// {type: 'highlightSelector', selector} overlays every element matching a CSS
// selector (editor cursor inside a CSS rule). These draw overlay boxes only
// (no chip), never echo messages back, and clear on null payloads or when the
// inspector is disabled.
(function () {
  'use strict';

  if (window.__jmInspector) {
    return;
  }
  window.__jmInspector = true;

  var OWN_ATTR = 'data-jm-inspector';

  // Overlay stacking contract: iframe shields sit under the highlight boxes
  // (so a shielded iframe's hover box still shows), and the chip tops all.
  var Z_IFRAME_SHIELD = 2147483645;
  var Z_HIGHLIGHT_BOX = 2147483646;
  var Z_CHIP = 2147483647;

  // Shared look of every highlight box (hover and programmatic).
  var HIGHLIGHT_BOX_CSS =
    'position:fixed;z-index:' +
    Z_HIGHLIGHT_BOX +
    ';pointer-events:none;' +
    'background:rgba(99,155,255,0.25);border:1px solid #639bff;' +
    'border-radius:2px;display:none;';

  // The chip sits this far above the element; with no room it flips below.
  var CHIP_HEIGHT_PX = 24;
  var CHIP_FLIP_GAP_PX = 4;

  // domPath segment shape, e.g. "div:nth-of-type(2)". Case-insensitive so
  // spec-cased foreign elements (foreignObject, clipPath, ...) pass.
  var SEGMENT_REGEX = /^([a-z0-9-]+):nth-of-type\((\d+)\)$/i;

  // --- State ---

  var enabled = false;
  var hoverEl = null;
  var pinnedEl = null;
  var box = null;
  var chip = null;
  var cursorStyle = null;
  var repositionAttached = false;
  // Transparent blockers drawn over nested iframes while the inspector is
  // on: mouse events over an embed go to the inner document, so without a
  // shield the <iframe> can't be hovered/selected and its clicks aren't
  // swallowed like every other click.
  var iframeShields = [];
  // Origin of the embedding IDE, learned from its first accepted message;
  // descriptors are only posted back to that origin.
  var parentOrigin = '*';
  // Reverse-direction ("Live Highlight") state: elements highlighted from the
  // editor, and the pool of overlay divs drawn on them.
  var programmaticEls = [];
  var programmaticBoxes = [];
  var MAX_PROGRAMMATIC_HIGHLIGHTS = 50;

  // --- Parent messaging ---

  function post(type, payload) {
    parent.postMessage({ type: type, payload: payload }, parentOrigin);
  }

  // --- Element classification & descriptors (live DOM -> protocol) ---

  // Nodes we (or the other devtool scripts) put on the page. They must be
  // invisible to hit-testing AND to sibling counting, so student domPaths
  // match what a parser sees in the original HTML.
  function isInjectedNode(node) {
    if (!node || node.nodeType !== 1) {
      return true;
    }
    if (node.id === 'eruda') {
      return true;
    }
    return node.hasAttribute(OWN_ATTR);
  }

  function isInspectable(el) {
    if (!el || el.nodeType !== 1 || el === document.documentElement) {
      return false;
    }
    if (el.closest('#eruda') || el.closest('[' + OWN_ATTR + ']')) {
      return false;
    }
    return true;
  }

  // HTML tagNames read uppercase from the live DOM while foreign elements
  // (SVG/MathML, e.g. foreignObject/clipPath) keep their spec case — which
  // is also how the source-side parser reports them. Lowercase only HTML so
  // path segments stay comparable on both sides.
  function pathTagName(node) {
    return node.namespaceURI === 'http://www.w3.org/1999/xhtml'
      ? node.tagName.toLowerCase()
      : node.tagName;
  }

  // Structural path from <body> down, e.g.
  // ["body", "div:nth-of-type(1)", "p:nth-of-type(2)"]. nth-of-type counts
  // same-tag element siblings only, skipping injected nodes.
  function getDomPath(el) {
    var path = [];
    var node = el;
    while (node && node !== document.body) {
      var index = 0;
      var sib = node;
      while (sib) {
        // Case-insensitive to mirror how both resolvers count (live DOM
        // uppercase vs parser lowercase/spec-case).
        if (
          sib.tagName.toLowerCase() === node.tagName.toLowerCase() &&
          !isInjectedNode(sib)
        ) {
          index++;
        }
        sib = sib.previousElementSibling;
      }
      path.unshift(pathTagName(node) + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    if (node !== document.body) {
      return null;
    }
    path.unshift('body');
    return path;
  }

  function getDescriptor(el) {
    return {
      pagePath: window.location.pathname,
      tagName: pathTagName(el),
      id: el.id || '',
      classes: Array.prototype.slice.call(el.classList),
      domPath: getDomPath(el),
    };
  }

  // --- Hover overlay rendering ---

  function chipText(el) {
    var text = pathTagName(el);
    if (el.id) {
      text += ' #' + el.id;
    }
    for (var i = 0; i < el.classList.length; i++) {
      text += ' .' + el.classList[i];
    }
    return text;
  }

  function ensureOverlay() {
    if (box) {
      return;
    }
    box = document.createElement('div');
    box.setAttribute(OWN_ATTR, '');
    box.style.cssText = HIGHLIGHT_BOX_CSS;
    chip = document.createElement('div');
    chip.setAttribute(OWN_ATTR, '');
    chip.style.cssText =
      'position:fixed;z-index:' +
      Z_CHIP +
      ';pointer-events:none;' +
      'background:#1e1e1e;color:#fff;font:12px/1.7 monospace;' +
      'padding:1px 6px;border-radius:3px;white-space:nowrap;display:none;' +
      'box-shadow:0 1px 4px rgba(0,0,0,0.4);';
    document.body.appendChild(box);
    document.body.appendChild(chip);
  }

  function drawOverlay(el) {
    ensureOverlay();
    var rect = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    chip.textContent = chipText(el);
    chip.style.display = 'block';
    chip.style.left = Math.max(0, rect.left) + 'px';
    var chipTop = rect.top - CHIP_HEIGHT_PX;
    chip.style.top =
      (chipTop < 0 ? rect.bottom + CHIP_FLIP_GAP_PX : chipTop) + 'px';
  }

  function clearOverlay() {
    if (box) {
      box.style.display = 'none';
      chip.style.display = 'none';
    }
  }

  // --- Reverse-direction overlays (editor -> preview) ---

  function positionBoxOnElement(boxEl, el) {
    var rect = el.getBoundingClientRect();
    boxEl.style.display = 'block';
    boxEl.style.left = rect.left + 'px';
    boxEl.style.top = rect.top + 'px';
    boxEl.style.width = rect.width + 'px';
    boxEl.style.height = rect.height + 'px';
  }

  function drawProgrammaticOverlays(els) {
    programmaticEls = els.slice(0, MAX_PROGRAMMATIC_HIGHLIGHTS);
    while (programmaticBoxes.length < programmaticEls.length) {
      var newBox = document.createElement('div');
      newBox.setAttribute(OWN_ATTR, '');
      newBox.style.cssText = HIGHLIGHT_BOX_CSS;
      document.body.appendChild(newBox);
      programmaticBoxes.push(newBox);
    }
    for (var i = 0; i < programmaticBoxes.length; i++) {
      if (i < programmaticEls.length) {
        positionBoxOnElement(programmaticBoxes[i], programmaticEls[i]);
      } else {
        programmaticBoxes[i].style.display = 'none';
      }
    }
  }

  function clearProgrammaticOverlays() {
    programmaticEls = [];
    for (var i = 0; i < programmaticBoxes.length; i++) {
      programmaticBoxes[i].style.display = 'none';
    }
  }

  // --- DOM path resolution (protocol -> live element) ---

  // Walk a body-down structural path (same nth-of-type semantics the forward
  // direction uses) to a live element.
  function resolveDomPath(domPath) {
    if (!domPath || !domPath.length || domPath[0] !== 'body') {
      return null;
    }
    var current = document.body;
    for (var i = 1; i < domPath.length; i++) {
      var match = SEGMENT_REGEX.exec(domPath[i]);
      if (!match) {
        return null;
      }
      // Case-insensitive: live HTML tagNames are uppercase, foreign elements
      // camelCase, and source-derived paths lowercase/spec-case.
      var tag = match[1].toLowerCase();
      var nth = Number(match[2]);
      var count = 0;
      var found = null;
      for (var c = 0; c < current.children.length; c++) {
        var child = current.children[c];
        if (child.tagName.toLowerCase() === tag && !isInjectedNode(child)) {
          count++;
          if (count === nth) {
            found = child;
            break;
          }
        }
      }
      if (!found) {
        return null;
      }
      current = found;
    }
    return current;
  }

  // --- Iframe shields (see declaration comment) ---

  function addIframeShields() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (!isInspectable(frames[i])) {
        continue;
      }
      var shield = document.createElement('div');
      shield.setAttribute(OWN_ATTR, '');
      // normalizeTarget maps hits on the shield back to its iframe.
      shield.__jmShieldFor = frames[i];
      shield.style.cssText =
        'position:fixed;z-index:' + Z_IFRAME_SHIELD + ';background:transparent;';
      positionBoxOnElement(shield, frames[i]);
      document.body.appendChild(shield);
      iframeShields.push(shield);
    }
  }

  function removeIframeShields() {
    for (var i = 0; i < iframeShields.length; i++) {
      if (iframeShields[i].parentNode) {
        iframeShields[i].parentNode.removeChild(iframeShields[i]);
      }
    }
    iframeShields = [];
  }

  function repositionIframeShields() {
    for (var i = 0; i < iframeShields.length; i++) {
      var frame = iframeShields[i].__jmShieldFor;
      if (document.contains(frame)) {
        positionBoxOnElement(iframeShields[i], frame);
      } else {
        iframeShields[i].style.display = 'none';
      }
    }
  }

  // --- Overlay repositioning lifecycle ---

  function reposition() {
    var el = pinnedEl || hoverEl;
    if (el && document.contains(el)) {
      drawOverlay(el);
    } else {
      clearOverlay();
    }
    if (programmaticEls.length) {
      drawProgrammaticOverlays(
        programmaticEls.filter(function (p) {
          return document.contains(p);
        }),
      );
    }
    repositionIframeShields();
    syncRepositionListeners();
  }

  function attachReposition() {
    if (!repositionAttached) {
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      repositionAttached = true;
    }
  }

  function detachReposition() {
    if (repositionAttached) {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      repositionAttached = false;
    }
  }

  // The scroll/resize listeners are only needed while something is drawn;
  // keep them attached exactly when that's the case so a cleared highlight
  // doesn't leave a capture-phase scroll handler running forever.
  function syncRepositionListeners() {
    if (enabled || pinnedEl || programmaticEls.length) {
      attachReposition();
    } else {
      detachReposition();
    }
  }

  // --- Pointer handling (inspect mode) ---

  function setHover(el) {
    if (el === hoverEl) {
      return;
    }
    hoverEl = el;
    if (el) {
      drawOverlay(el);
      post('inspectorHover', getDescriptor(el));
    } else {
      clearOverlay();
      post('inspectorHover', null);
    }
  }

  // The empty area below the page content belongs to <html> (browsers just
  // paint the body's background across it), so students read it as "the
  // body". Map hits on <html> to <body> — like classic Web Lab, <html>
  // itself has no source mapping anyway.
  function normalizeTarget(el) {
    if (el && el.__jmShieldFor) {
      return el.__jmShieldFor;
    }
    return el === document.documentElement ? document.body : el;
  }

  function onMouseMove(event) {
    var el = normalizeTarget(
      document.elementFromPoint(event.clientX, event.clientY),
    );
    setHover(el && isInspectable(el) ? el : null);
  }

  function onMouseLeave() {
    setHover(null);
  }

  function onClick(event) {
    var el = normalizeTarget(
      document.elementFromPoint(event.clientX, event.clientY),
    );
    // Clicks on the devtools UI (eruda) must keep working while the
    // inspector is on — only the student page's own clicks are swallowed.
    if (el && !isInspectable(el)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!el) {
      return;
    }
    pinnedEl = el;
    hoverEl = null;
    drawOverlay(el);
    post('inspectorSelect', getDescriptor(el));
    // Classic Web Lab behavior: a click pins the selection and exits
    // inspector mode. The parent updates its toggle from inspectorSelect.
    setEnabled(false);
  }

  // --- Inspect-mode lifecycle ---

  function enable() {
    pinnedEl = null;
    clearOverlay();
    addIframeShields();
    syncRepositionListeners();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.documentElement.addEventListener('mouseleave', onMouseLeave);
    if (!cursorStyle) {
      cursorStyle = document.createElement('style');
      cursorStyle.setAttribute(OWN_ATTR, '');
      cursorStyle.textContent = '* { cursor: crosshair !important; }';
    }
    document.documentElement.appendChild(cursorStyle);
  }

  function disable() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.documentElement.removeEventListener('mouseleave', onMouseLeave);
    if (cursorStyle && cursorStyle.parentNode) {
      cursorStyle.parentNode.removeChild(cursorStyle);
    }
    hoverEl = null;
    clearProgrammaticOverlays();
    removeIframeShields();
    // A pinned highlight survives leaving inspector mode (until the next
    // enable or a page reload); a plain toggle-off clears everything.
    if (pinnedEl) {
      reposition();
    } else {
      clearOverlay();
    }
    syncRepositionListeners();
  }

  function setEnabled(value) {
    if (value === enabled) {
      return;
    }
    enabled = value;
    if (enabled) {
      enable();
    } else {
      disable();
    }
  }

  // --- Protocol handler (parent -> page) ---

  window.addEventListener('message', function (event) {
    // Only the embedding IDE (our direct parent) may drive the inspector —
    // not nested iframes, popups, or the page's own JS. An origin allowlist
    // isn't possible here: the IDE runs on several origins (prod, previews,
    // localhost dev) and the scripts are also used in app webviews — so a
    // page that embeds a student site can still command its own iframe.
    if (event.source !== window.parent || event.source === window) {
      return;
    }
    var data = event.data;
    if (typeof data !== 'object' || data === null || !('type' in data)) {
      return;
    }
    // Reply only to the origin that is driving us ('null' is the opaque
    // origin of a sandboxed embedder, which postMessage can't target).
    if (event.origin && event.origin !== 'null') {
      parentOrigin = event.origin;
    }
    if (data.type === 'setInspector') {
      setEnabled(!!data.enabled);
      return;
    }
    if (data.type === 'highlightFromSource') {
      if (!data.domPath) {
        clearProgrammaticOverlays();
        syncRepositionListeners();
        return;
      }
      var el = resolveDomPath(data.domPath);
      if (el) {
        drawProgrammaticOverlays([el]);
      } else {
        clearProgrammaticOverlays();
      }
      syncRepositionListeners();
      return;
    }
    if (data.type === 'highlightSelector') {
      if (!data.selector) {
        clearProgrammaticOverlays();
        syncRepositionListeners();
        return;
      }
      var matches = [];
      try {
        var nodeList = document.querySelectorAll(data.selector);
        for (var i = 0; i < nodeList.length; i++) {
          // Unlike hover, allow <html> here so `html { ... }` rules light up.
          if (
            !isInjectedNode(nodeList[i]) &&
            (nodeList[i] === document.documentElement ||
              isInspectable(nodeList[i]))
          ) {
            matches.push(nodeList[i]);
          }
        }
      } catch (err) {
        // Students type selectors incrementally — invalid ones just clear.
      }
      if (matches.length) {
        drawProgrammaticOverlays(matches);
      } else {
        clearProgrammaticOverlays();
      }
      syncRepositionListeners();
      return;
    }
  });
})();
