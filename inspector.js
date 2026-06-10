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

  var enabled = false;
  var hoverEl = null;
  var pinnedEl = null;
  var box = null;
  var chip = null;
  var cursorStyle = null;
  var repositionAttached = false;
  // Reverse-direction ("Live Highlight") state: elements highlighted from the
  // editor, and the pool of overlay divs drawn on them.
  var programmaticEls = [];
  var programmaticBoxes = [];
  var MAX_PROGRAMMATIC_HIGHLIGHTS = 50;

  function post(type, payload) {
    parent.postMessage({ type: type, payload: payload }, '*');
  }

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
        if (sib.tagName === node.tagName && !isInjectedNode(sib)) {
          index++;
        }
        sib = sib.previousElementSibling;
      }
      path.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
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
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.prototype.slice.call(el.classList),
      domPath: getDomPath(el),
    };
  }

  function chipText(el) {
    var text = el.tagName.toLowerCase();
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
    box.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;' +
      'background:rgba(99,155,255,0.25);border:1px solid #639bff;' +
      'border-radius:2px;display:none;';
    chip = document.createElement('div');
    chip.setAttribute(OWN_ATTR, '');
    chip.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;' +
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
    var chipTop = rect.top - 24;
    chip.style.top = (chipTop < 0 ? rect.bottom + 4 : chipTop) + 'px';
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
      newBox.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;' +
        'background:rgba(99,155,255,0.25);border:1px solid #639bff;' +
        'border-radius:2px;display:none;';
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

  // Walk a body-down structural path (same nth-of-type semantics the forward
  // direction uses) to a live element.
  function resolveDomPath(domPath) {
    if (!domPath || !domPath.length || domPath[0] !== 'body') {
      return null;
    }
    var current = document.body;
    for (var i = 1; i < domPath.length; i++) {
      var match = /^([a-z0-9-]+):nth-of-type\((\d+)\)$/i.exec(domPath[i]);
      if (!match) {
        return null;
      }
      var tag = match[1].toUpperCase();
      var nth = Number(match[2]);
      var count = 0;
      var found = null;
      for (var c = 0; c < current.children.length; c++) {
        var child = current.children[c];
        if (child.tagName === tag && !isInjectedNode(child)) {
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

  function onMouseMove(event) {
    var el = document.elementFromPoint(event.clientX, event.clientY);
    setHover(isInspectable(el) ? el : null);
  }

  function onMouseLeave() {
    setHover(null);
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    var el = document.elementFromPoint(event.clientX, event.clientY);
    if (!isInspectable(el)) {
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

  function enable() {
    pinnedEl = null;
    clearOverlay();
    attachReposition();
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
    // A pinned highlight survives leaving inspector mode (until the next
    // enable or a page reload); a plain toggle-off clears everything.
    if (pinnedEl) {
      reposition();
    } else {
      clearOverlay();
      detachReposition();
    }
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

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (typeof data !== 'object' || data === null || !('type' in data)) {
      return;
    }
    if (data.type === 'setInspector') {
      setEnabled(!!data.enabled);
      return;
    }
    if (data.type === 'highlightFromSource') {
      if (!data.domPath) {
        clearProgrammaticOverlays();
        return;
      }
      var el = resolveDomPath(data.domPath);
      if (el) {
        attachReposition();
        drawProgrammaticOverlays([el]);
      } else {
        clearProgrammaticOverlays();
      }
      return;
    }
    if (data.type === 'highlightSelector') {
      if (!data.selector) {
        clearProgrammaticOverlays();
        return;
      }
      var matches = [];
      try {
        var nodeList = document.querySelectorAll(data.selector);
        for (var i = 0; i < nodeList.length; i++) {
          if (!isInjectedNode(nodeList[i]) && isInspectable(nodeList[i])) {
            matches.push(nodeList[i]);
          }
        }
      } catch (err) {
        // Students type selectors incrementally — invalid ones just clear.
      }
      if (matches.length) {
        attachReposition();
        drawProgrammaticOverlays(matches);
      } else {
        clearProgrammaticOverlays();
      }
      return;
    }
  });
})();
