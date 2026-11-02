// Antigravity In-Page Element Inspector Script
(function () {
  if (window.__antigravityInspectorInitialized) return;
  window.__antigravityInspectorInitialized = true;

  let isInspectMode = false;
  let hoveredElement = null;

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = '__antigravity_overlay';
  overlay.setAttribute('data-antigravity-internal', 'true');
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2147483647';
  overlay.style.transition = 'top 0.04s ease-out, left 0.04s ease-out, width 0.04s ease-out, height 0.04s ease-out';
  overlay.style.display = 'none';
  overlay.style.border = '2px solid #0284c7';
  overlay.style.backgroundColor = 'rgba(2, 132, 199, 0.2)';
  overlay.style.borderRadius = '4px';
  overlay.style.boxSizing = 'border-box';

  const badge = document.createElement('div');
  badge.id = '__antigravity_badge';
  badge.setAttribute('data-antigravity-internal', 'true');
  badge.style.position = 'absolute';
  badge.style.pointerEvents = 'none';
  badge.style.bottom = '100%';
  badge.style.left = '0';
  badge.style.backgroundColor = '#0284c7';
  badge.style.color = '#ffffff';
  badge.style.fontSize = '11px';
  badge.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  badge.style.fontWeight = '600';
  badge.style.padding = '3px 8px';
  badge.style.borderRadius = '4px 4px 0 0';
  badge.style.whiteSpace = 'nowrap';
  badge.style.boxShadow = '0 2px 8px rgba(0,0,0,0.35)';
  badge.style.lineHeight = '1.2';
  overlay.appendChild(badge);

  function attachOverlay() {
    const root = document.body || document.documentElement;
    if (root && !root.contains(overlay)) {
      root.appendChild(overlay);
    }
  }

  function getElementClassName(el) {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
    return '';
  }

  function getCssSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return `#${el.id}`;
    
    let parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.body && cur !== document.documentElement) {
      let tag = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      const rawClass = getElementClassName(cur);
      let className = rawClass
        ? '.' + rawClass.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') 
        : '';
      
      let parent = cur.parentElement;
      if (parent) {
        let siblings = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          let idx = siblings.indexOf(cur) + 1;
          tag += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(tag + className);
      cur = parent;
      if (parts.length >= 4) break;
    }
    return parts.join(' > ');
  }

  function getReactInfo(dom) {
    try {
      let cur = dom;
      let hostSource = null;
      let compName = null;
      let compSource = null;

      while (cur) {
        const key = Object.keys(cur).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (key) {
          let fiber = cur[key];
          while (fiber) {
            // Check debugSource or source on fiber or props
            const src = fiber._debugSource || fiber._source || fiber.memoizedProps?.__source || fiber.pendingProps?.__source;
            if (src && !hostSource) {
              hostSource = src;
            }

            const type = fiber.type;
            if (type && (typeof type === 'function' || typeof type === 'object')) {
              const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name));
              if (name && name !== 'Anonymous' && !name.startsWith('styled.') && !compName) {
                compName = name;
                compSource = src;
              }
            }

            if (hostSource && compName) break;
            fiber = fiber.return;
          }
          if (hostSource || compName) break;
        }
        cur = cur.parentElement;
      }

      // Check data attributes like data-source-file / data-source-line
      if (!hostSource && !compSource) {
        let p = dom;
        while (p && p !== document.body && p !== document.documentElement) {
          const dsFile = p.getAttribute('data-source-file') || p.getAttribute('data-loc-file') || p.getAttribute('data-astro-source-file');
          const dsLine = p.getAttribute('data-source-line') || p.getAttribute('data-loc-line') || p.getAttribute('data-astro-source-loc');
          if (dsFile) {
            hostSource = {
              fileName: dsFile,
              lineNumber: parseInt(dsLine, 10) || 1
            };
            break;
          }
          p = p.parentElement;
        }
      }

      const finalSource = hostSource || compSource;
      if (compName || finalSource) {
        return {
          componentName: compName || (dom.tagName ? dom.tagName.toLowerCase() : 'Element'),
          fileName: finalSource ? finalSource.fileName : null,
          lineNumber: finalSource ? finalSource.lineNumber : null,
          columnNumber: finalSource ? finalSource.columnNumber : null
        };
      }
    } catch (e) {}
    return null;
  }

  function getVueInfo(dom) {
    try {
      let cur = dom;
      while (cur) {
        if (cur.__vueParentComponent) {
          const vcomp = cur.__vueParentComponent;
          return {
            componentName: vcomp.type?.name || vcomp.type?.__name || 'VueComponent',
            fileName: vcomp.type?.__file || null
          };
        }
        cur = cur.parentElement;
      }
    } catch (e) {}
    return null;
  }

  function updateHighlight(el) {
    if (!el || el === overlay || overlay.contains(el) || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      return;
    }
    attachOverlay();
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      overlay.style.display = 'none';
      return;
    }

    overlay.style.display = 'block';
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    // Position badge above or inside if near top
    if (rect.top < 28) {
      badge.style.bottom = 'auto';
      badge.style.top = '0';
      badge.style.borderRadius = '0 0 4px 4px';
    } else {
      badge.style.top = 'auto';
      badge.style.bottom = '100%';
      badge.style.borderRadius = '4px 4px 0 0';
    }

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const rawClass = getElementClassName(el);
    const firstClass = rawClass.trim() ? '.' + (rawClass.trim().split(/\s+/).filter(Boolean)[0] || '') : '';
    badge.textContent = `${tag}${id}${firstClass} (${Math.round(rect.width)}×${Math.round(rect.height)})`;
  }

  function onMouseMove(e) {
    if (!isInspectMode) return;
    const target = e.target && e.target !== overlay && !overlay.contains(e.target) 
      ? e.target 
      : document.elementFromPoint(e.clientX, e.clientY);

    if (target && target !== overlay && !overlay.contains(target)) {
      hoveredElement = target;
      updateHighlight(target);
    }
  }

  function onIntercept(e) {
    if (!isInspectMode) return;
    // Intercept mousedown, pointerdown, etc. to prevent navigation / click events in inspected page
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!isInspectMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = hoveredElement || e.target || document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === overlay || overlay.contains(target)) return;

    // Green flash animation to confirm selection
    overlay.style.border = '2px solid #22c55e';
    overlay.style.backgroundColor = 'rgba(34, 197, 94, 0.4)';
    badge.style.backgroundColor = '#16a34a';

    setTimeout(() => {
      overlay.style.border = '2px solid #0284c7';
      overlay.style.backgroundColor = 'rgba(2, 132, 199, 0.2)';
      badge.style.backgroundColor = '#0284c7';
    }, 400);

    const reactInfo = getReactInfo(target);
    const vueInfo = getVueInfo(target);
    const cssSelector = getCssSelector(target);

    // Extract attributes
    const attrs = {};
    if (target.attributes) {
      for (let i = 0; i < target.attributes.length; i++) {
        const a = target.attributes[i];
        if (!a.name.startsWith('style') && !a.name.startsWith('data-antigravity') && a.value.length < 200) {
          attrs[a.name] = a.value;
        }
      }
    }

    let outerHtmlClean = '';
    try {
      const clone = target.cloneNode(true);
      const internals = clone.querySelectorAll('[data-antigravity-internal]');
      internals.forEach(n => n.remove());
      outerHtmlClean = clone.outerHTML ? clone.outerHTML.slice(0, 1500) : '';
    } catch (e) {
      outerHtmlClean = target.outerHTML ? target.outerHTML.slice(0, 1500) : '';
    }

    const payload = {
      type: 'AGY_ELEMENT_SELECTED',
      data: {
        tagName: target.tagName.toLowerCase(),
        id: target.id || '',
        className: getElementClassName(target),
        innerText: (target.innerText || target.textContent || '').trim().slice(0, 300),
        html: outerHtmlClean,
        cssSelector,
        attributes: attrs,
        react: reactInfo,
        vue: vueInfo,
        bounds: {
          width: Math.round(target.offsetWidth || 0),
          height: Math.round(target.offsetHeight || 0)
        }
      }
    };

    try {
      window.parent.postMessage(payload, '*');
    } catch (err) {}
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && isInspectMode) {
      try {
        window.parent.postMessage({ type: 'AGY_DISABLE_INSPECTOR' }, '*');
      } catch (err) {}
    }
  }

  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'AGY_SET_INSPECT_MODE') {
      isInspectMode = !!event.data.enabled;
      if (document.body) {
        document.body.style.cursor = isInspectMode ? 'crosshair' : 'default';
      }
      if (!isInspectMode) {
        overlay.style.display = 'none';
        hoveredElement = null;
      }
      try {
        window.parent.postMessage({
          type: 'AGY_INSPECT_MODE_ACK',
          enabled: isInspectMode
        }, '*');
      } catch (err) {}
    }
  });

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('pointerdown', onIntercept, true);
  document.addEventListener('mousedown', onIntercept, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', () => {
    if (isInspectMode && hoveredElement) {
      updateHighlight(hoveredElement);
    }
  }, { passive: true });

  // Notify parent of location changes (SPA routing & navigation)
  function notifyUrl() {
    try {
      window.parent.postMessage({
        type: 'AGY_URL_CHANGED',
        url: window.location.href,
        title: document.title
      }, '*');
    } catch (e) {}
  }

  // Handshake announcement to parent webview
  function announceReady() {
    try {
      window.parent.postMessage({
        type: 'AGY_INSPECTOR_READY',
        url: window.location.href,
        title: document.title
      }, '*');
    } catch (e) {}
  }

  const origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    notifyUrl();
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    notifyUrl();
  };
  window.addEventListener('popstate', notifyUrl);
  window.addEventListener('hashchange', notifyUrl);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady);
  } else {
    announceReady();
  }
})();
