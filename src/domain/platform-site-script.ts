// Platform-owned runtime appended to every generated site's site.js at
// assembly time (2026-11-24).
//
// Why this is NOT left to the Builder model:
//  - The Builder was told "no client-side sending logic", so a plain HTML form
//    posted urlencoded to a JSON-only endpoint (and its own script revealed a
//    fake success message before anything was sent). Sending must be
//    deterministic, identical on every site, and testable.
//  - WhatsApp links need a sensible pre-filled message ("Hello <business>, ...")
//    on every site without asking the model to remember it.
//
// What it does:
//  1. Every https://wa.me/<number> link without ?text= gets a pre-filled,
//     business- and context-aware message.
//  2. The enquiry form (form[action*="/api/v2/forms/submit"]) submits as JSON
//     via fetch, shows a REAL success only after the platform accepted it, and
//     offers "Send on WhatsApp" with the visitor's details pre-composed (the
//     contact form doubles as a WhatsApp lead channel). If sending fails it
//     degrades to WhatsApp rather than losing the lead.
//  3. Without JavaScript the form still posts (urlencoded, handled server-side)
//     and the page shows the outcome from ?form=sent|error.
//
// ES5, no dependencies, no globals, and wrapped so a failure here can never
// break the site's own script.
export const PLATFORM_SITE_SCRIPT = `
/* --- WAZIBIZ platform runtime: forms + WhatsApp (do not edit; generated sites) --- */
(function () {
  'use strict';
  try {
    var doc = document;

    function businessName() {
      var og = doc.querySelector('meta[property="og:site_name"]');
      if (og && og.content) return og.content.trim();
      // The header logo/brand text is the most reliable name on a generated
      // site; a <title> tagline ("Brand | Garden Venue in Ngong") is not.
      var logo = doc.querySelector('header .brand, header .logo, header .site-logo, header a[href="/"], header a[href="index.html"], .brand, .logo');
      var logoText = logo && logo.textContent ? logo.textContent.replace(/\\s+/g, ' ').trim() : '';
      if (logoText && logoText.length <= 60) return logoText;
      var parts = (doc.title || '').split(/\\s+[|\\u2013\\u2014-]\\s+/);
      return (parts[0] || '').trim();
    }

    function waNumber(href) {
      var m = /^https:\\/\\/wa\\.me\\/(\\d{6,15})/.exec(href || '');
      return m ? m[1] : null;
    }

    function waLink(number, text) {
      return 'https://wa.me/' + number + '?text=' + encodeURIComponent(text);
    }

    function intro() {
      var name = businessName();
      return name ? 'Hello ' + name + ',' : 'Hello,';
    }

    function contextFor(link) {
      var explicit = link.getAttribute('data-wa-text');
      if (explicit) return explicit;
      if (link.closest('header, nav, footer')) return '';
      var scope = link.closest('article, li, [class*="card"]');
      var heading = scope && scope.querySelector('h1, h2, h3');
      var label = heading && heading.textContent ? heading.textContent.replace(/\\s+/g, ' ').trim() : '';
      return label && label.length <= 80 ? label : '';
    }

    /* 1. WhatsApp links get a pre-filled message. */
    var links = doc.querySelectorAll('a[href^="https://wa.me/"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (/[?&]text=/.test(link.getAttribute('href'))) continue;
      var number = waNumber(link.getAttribute('href'));
      if (!number) continue;
      var about = contextFor(link);
      var text = intro() + ' I found your website and ' +
        (about ? "I'd like to ask about " + about + '.' : "I'd like to make an enquiry.");
      link.setAttribute('href', waLink(number, text));
      if (!link.getAttribute('target')) link.setAttribute('target', '_blank');
      if (!link.getAttribute('rel')) link.setAttribute('rel', 'noopener');
    }

    /* 2. Enquiry form. */
    var form = doc.querySelector('form[action*="/api/v2/forms/submit"]');
    if (!form) return;

    var firstWa = doc.querySelector('a[href^="https://wa.me/"]');
    var number = form.getAttribute('data-wa-number') || (firstWa ? waNumber(firstWa.getAttribute('href')) : null);

    var status = form.querySelector('[data-form-success]') || doc.querySelector('[data-form-success]');
    if (!status) {
      status = doc.createElement('div');
      status.setAttribute('data-form-success', '');
      form.appendChild(status);
    }
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    function show(message, waHref, isError) {
      while (status.firstChild) status.removeChild(status.firstChild);
      var p = doc.createElement('p');
      p.textContent = message;
      status.appendChild(p);
      if (waHref) {
        var a = doc.createElement('a');
        a.href = waHref;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'btn btn-whatsapp wb-wa-followup';
        a.textContent = 'Send this on WhatsApp too';
        status.appendChild(a);
      }
      status.setAttribute('data-state', isError ? 'error' : 'sent');
      status.hidden = false;
      if (status.scrollIntoView) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function composeWhatsApp(data, sent) {
      if (!number) return null;
      var lines = [intro() + (sent ? ' I just sent an enquiry through your website.' : " I'd like to make an enquiry.")];
      var skip = { siteFormId: 1, message: 1 };
      for (var key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key) || skip[key] || !data[key]) continue;
        var label = key.replace(/[-_]+/g, ' ');
        label = label.charAt(0).toUpperCase() + label.slice(1);
        lines.push(label + ': ' + data[key]);
      }
      if (data.message) lines.push('', data.message);
      return waLink(number, lines.join('\\n'));
    }

    /* No-JS fallback outcome (server redirects back with ?form=...). */
    var outcome = /[?&]form=(sent|error)/.exec(location.search);
    if (outcome) {
      show(outcome[1] === 'sent'
        ? 'Thank you - your enquiry was sent. We will get back to you shortly.'
        : 'Sorry, we could not send your enquiry. Please try again or contact us on WhatsApp.',
        null, outcome[1] === 'error');
    }

    doc.addEventListener('submit', function (event) {
      if (event.target !== form) return;
      // Our handler owns the submit: stop the Builder's own (premature "success")
      // listener and the browser's navigation.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (form.reportValidity && !form.reportValidity()) return;

      var data = {};
      var fd = new FormData(form);
      fd.forEach(function (value, key) { if (typeof value === 'string') data[key] = value.trim(); });
      var button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;

      var waSent = composeWhatsApp(data, true);
      var waUnsent = composeWhatsApp(data, false);
      fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (response) {
        if (response.status === 202) {
          form.reset();
          show('Thank you - your enquiry was sent. We will get back to you shortly.', waSent, false);
        } else {
          show('Sorry, we could not send your enquiry just now.' + (waUnsent ? ' You can send it on WhatsApp instead.' : ' Please try again or call us.'), waUnsent, true);
        }
      }).catch(function () {
        show('Sorry, we could not reach the server.' + (waUnsent ? ' You can send your enquiry on WhatsApp instead.' : ' Please try again or call us.'), waUnsent, true);
      }).then(function () {
        if (button) button.disabled = false;
      });
    }, true);
  } catch (e) {
    if (window.console && console.warn) console.warn('wazibiz platform runtime:', e);
  }
})();
`;
