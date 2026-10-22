/* StellarGate dashboard message catalog.
 *
 * Flat key -> string maps, one per locale. `en` is the source of truth: a key
 * missing from another locale falls back to it. Strings are always written
 * with textContent (or as attribute values), never as markup.
 *
 * Static markup opts in with data attributes:
 *   data-i18n="key"              -> textContent
 *   data-i18n-placeholder="key"  -> placeholder
 *   data-i18n-title="key"        -> title
 *   data-i18n-aria-label="key"   -> aria-label
 */

(function () {
  "use strict";

  var LOCALE_KEY = "stellargate.locale";
  var RTL = ["ar", "fa", "he", "ur"];

  var catalogs = {
    en: {
      "app.title": "StellarGate Dashboard",
      "gate.intro": "Sign in with a merchant API key to view payments.",
      "gate.apiKey": "API key",
      "gate.apiKeyPlaceholder": "merchant API key",
      "gate.remember": "Keep me signed in on this device",
      "gate.signIn": "Sign in",
      "gate.notice":
        "The key is held in your browser only and sent as a bearer token directly to this gateway. It is never stored on the server.",
      "nav.skip": "Skip to payments",
      "nav.language": "Language",
      "health.title": "Gateway health",
      "health.checking": "checking…",
      "health.healthy": "healthy",
      "health.unavailable": "unavailable",
      "health.unreachable": "unreachable",
      "nav.signOut": "Sign out",
      "filter.label": "Filter by status",
      "filter.all": "All",
      "filter.pending": "Pending",
      "filter.completed": "Completed",
      "filter.underpaid": "Underpaid",
      "filter.expired": "Expired",
      "list.refresh": "Refresh",
      "list.empty": "No payments match this filter.",
      "list.loadMore": "Load more",
      "field.status": "Status",
      "field.amount": "Amount",
      "field.received": "Received",
      "field.memo": "Memo",
      "field.destination": "Destination",
      "field.transaction": "Transaction",
      "field.paymentId": "Payment ID",
      "field.merchant": "Merchant",
      "field.created": "Created",
      "field.updated": "Updated",
      "field.expires": "Expires",
      "detail.label": "Payment detail",
      "detail.title": "Payment",
      "detail.close": "Close",
      "detail.deliveries": "Webhook deliveries",
      "detail.noDeliveries": "No delivery attempts recorded for this payment.",
      "delivery.webhook": "webhook",
      "delivery.meta": "attempt {attempts} · last {last}",
      "delivery.redeliver": "Redeliver",
      "delivery.sending": "Sending…",
      "error.rejected": "That API key was rejected. Please sign in again.",
      "error.requestFailed": "Request failed ({status})",
      "error.restore": "Could not restore your session: {message}",
    },
    es: {
      "app.title": "Panel de StellarGate",
      "gate.intro": "Inicia sesión con una clave API de comerciante para ver los pagos.",
      "gate.apiKey": "Clave API",
      "gate.apiKeyPlaceholder": "clave API de comerciante",
      "gate.remember": "Mantener la sesión iniciada en este dispositivo",
      "gate.signIn": "Iniciar sesión",
      "gate.notice":
        "La clave solo se guarda en tu navegador y se envía como token bearer directamente a esta pasarela. Nunca se almacena en el servidor.",
      "nav.skip": "Saltar a los pagos",
      "nav.language": "Idioma",
      "health.title": "Estado de la pasarela",
      "health.checking": "comprobando…",
      "health.healthy": "operativa",
      "health.unavailable": "no disponible",
      "health.unreachable": "inaccesible",
      "nav.signOut": "Cerrar sesión",
      "filter.label": "Filtrar por estado",
      "filter.all": "Todos",
      "filter.pending": "Pendientes",
      "filter.completed": "Completados",
      "filter.underpaid": "Pago insuficiente",
      "filter.expired": "Caducados",
      "list.refresh": "Actualizar",
      "list.empty": "Ningún pago coincide con este filtro.",
      "list.loadMore": "Cargar más",
      "field.status": "Estado",
      "field.amount": "Importe",
      "field.received": "Recibido",
      "field.memo": "Memo",
      "field.destination": "Destino",
      "field.transaction": "Transacción",
      "field.paymentId": "ID de pago",
      "field.merchant": "Comerciante",
      "field.created": "Creado",
      "field.updated": "Actualizado",
      "field.expires": "Caduca",
      "detail.label": "Detalle del pago",
      "detail.title": "Pago",
      "detail.close": "Cerrar",
      "detail.deliveries": "Entregas de webhooks",
      "detail.noDeliveries": "No hay intentos de entrega registrados para este pago.",
      "delivery.webhook": "webhook",
      "delivery.meta": "intento {attempts} · último {last}",
      "delivery.redeliver": "Reenviar",
      "delivery.sending": "Enviando…",
      "error.rejected": "Esa clave API fue rechazada. Vuelve a iniciar sesión.",
      "error.requestFailed": "La solicitud falló ({status})",
      "error.restore": "No se pudo restaurar tu sesión: {message}",
    },
  };

  var names = { en: "English", es: "Español" };
  var locale = "en";

  /** Look up `key` in the active locale, falling back to `en`, then the key. */
  function t(key, params) {
    var table = catalogs[locale] || catalogs.en;
    var text = key in table ? table[key] : key in catalogs.en ? catalogs.en[key] : key;
    return text.replace(/\{(\w+)\}/g, function (whole, name) {
      return params && name in params ? String(params[name]) : whole;
    });
  }

  /** Pick the first supported locale: stored choice, then the browser's. */
  function detect() {
    var stored = null;
    try {
      stored = window.localStorage.getItem(LOCALE_KEY);
    } catch (e) {
      /* storage blocked: fall through to the browser language */
    }
    if (stored && catalogs[stored]) return stored;
    var langs = navigator.languages || [navigator.language || "en"];
    for (var i = 0; i < langs.length; i++) {
      var base = String(langs[i]).toLowerCase().split("-")[0];
      if (catalogs[base]) return base;
    }
    return "en";
  }

  function setAttr(attr, prop) {
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-i18n-" + attr + "]"),
      function (node) {
        node.setAttribute(prop, t(node.getAttribute("data-i18n-" + attr)));
      }
    );
  }

  /** Translate every data-i18n* element and set <html lang> and dir. */
  function apply() {
    var root = document.documentElement;
    root.lang = locale;
    root.dir = RTL.indexOf(locale) >= 0 ? "rtl" : "ltr";
    document.title = t("app.title");
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (node) {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    setAttr("placeholder", "placeholder");
    setAttr("title", "title");
    setAttr("aria-label", "aria-label");
  }

  function setLocale(next) {
    if (!catalogs[next]) return;
    locale = next;
    try {
      window.localStorage.setItem(LOCALE_KEY, next);
    } catch (e) {
      /* the choice just won't persist */
    }
    apply();
  }

  locale = detect();

  window.I18N = {
    catalogs: catalogs,
    names: names,
    t: t,
    apply: apply,
    setLocale: setLocale,
    locale: function () {
      return locale;
    },
  };
})();
