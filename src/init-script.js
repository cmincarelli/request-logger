// Page-side instrument. Injected via Page.addScriptToEvaluateOnNewDocument
// (runs before page scripts on every navigation) and Runtime.evaluate (for
// the already-loaded document). Idempotent — safe to install twice.
//
// Events are delivered back to the Logger process over the CDP channel via
// Runtime.addBinding("__loggerEvent"). No fetch-to-localhost, no CSP fights.
(function () {
  if (window.__loggerInstalled) return;
  window.__loggerInstalled = true;

  var send = function (obj) {
    try {
      window.__loggerEvent(JSON.stringify(obj));
    } catch (e) {
      /* binding may not be ready; drop */
    }
  };

  var trunc = function (s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };

  var selector = function (el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      var part = cur.tagName.toLowerCase();
      if (cur.parentElement) {
        var sibs = Array.prototype.filter.call(
          cur.parentElement.children,
          function (c) {
            return c.tagName === cur.tagName;
          }
        );
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };

  var describe = function (e) {
    var el = e instanceof Element ? e : e && e.target;
    if (!(el instanceof Element)) return {};
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      css: selector(el),
      text: trunc(el.innerText || el.textContent || "", 80),
      cls: el.className && el.className.toString ? trunc(el.className.toString(), 120) : null,
    };
  };

  // capture phase so we see events before app handlers can stopPropagation.
  document.addEventListener(
    "click",
    function (e) {
      send({
        type: "click",
        t: Date.now(),
        target: describe(e),
        meta: { x: e.clientX, y: e.clientY, button: e.button },
      });
    },
    true
  );

  document.addEventListener(
    "change",
    function (e) {
      var v = e.target && "value" in e.target ? trunc(String(e.target.value), 300) : null;
      send({ type: "change", t: Date.now(), target: describe(e), value: v });
    },
    true
  );

  var inputTimer = null;
  var inputLast = null;
  document.addEventListener(
    "input",
    function (e) {
      var v = e.target && "value" in e.target ? trunc(String(e.target.value), 300) : null;
      inputLast = { type: "input", t: Date.now(), target: describe(e), value: v };
      if (inputTimer) return;
      inputTimer = setTimeout(function () {
        send(inputLast);
        inputTimer = null;
      }, 600);
    },
    true
  );

  document.addEventListener(
    "submit",
    function (e) {
      send({ type: "submit", t: Date.now(), target: describe(e) });
    },
    true
  );

  window.addEventListener(
    "popstate",
    function () {
      send({ type: "popstate", t: Date.now(), meta: { url: location.href } });
    },
    true
  );
  window.addEventListener(
    "hashchange",
    function () {
      send({ type: "hashchange", t: Date.now(), meta: { url: location.href } });
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key === "Enter")
        send({ type: "keydown", t: Date.now(), target: describe(e), meta: { key: e.key } });
    },
    true
  );

  var scrollTimer = null;
  window.addEventListener(
    "scroll",
    function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        send({ type: "scroll", t: Date.now(), meta: { x: window.scrollX, y: window.scrollY } });
        scrollTimer = null;
      }, 500);
    },
    true
  );

  send({ type: "install", t: Date.now(), meta: { url: location.href, ua: navigator.userAgent } });
})();
