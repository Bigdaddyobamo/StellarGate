//! Static checks on the embedded dashboard assets.

const HTML: &str = include_str!("../static/dashboard.html");
const CSS: &str = include_str!("../static/dashboard.css");
const JS: &str = include_str!("../static/dashboard.js");
const I18N: &str = include_str!("../static/i18n.js");

#[test]
fn skip_link_is_first_focusable_in_app_and_targets_table() {
    let app = &HTML[HTML.find(r#"<div id="app""#).expect("app container")..];
    let skip = app
        .find(r##"<a class="skip-link" href="#payments""##)
        .expect("skip link");
    let first_focusable = ["<a ", "<button", "<input", "<select", "<textarea"]
        .iter()
        .filter_map(|tag| app.find(tag))
        .min()
        .expect("focusable element");
    assert_eq!(skip, first_focusable);
    assert!(HTML.contains(r#"<table id="payments""#));
}

#[test]
fn skip_link_is_visible_on_focus() {
    assert!(CSS.contains(".skip-link:focus"));
}

/// Keys defined in one locale block of `i18n.js`, e.g. `catalog_keys("en")`.
fn catalog_keys(locale: &str) -> Vec<String> {
    let start = I18N
        .find(&format!("\n    {locale}: {{"))
        .expect("locale block");
    let block = &I18N[start..];
    let block = &block[..block.find("\n    },").expect("block end")];
    block
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.split_once("\":"))
        .map(|(key, _)| key.to_string())
        .collect()
}

/// Every `prefix…"key"` occurrence in `source`.
fn used_keys(source: &str, prefix: &str) -> Vec<String> {
    source
        .match_indices(prefix)
        .filter(|(i, _)| {
            !source[..*i].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.')
        })
        .map(|(i, _)| {
            let rest = &source[i + prefix.len()..];
            rest[..rest.find('"').unwrap()].to_string()
        })
        .collect()
}

#[test]
fn every_used_message_key_exists_in_catalog() {
    let en = catalog_keys("en");
    let mut used = used_keys(JS, "t(\"");
    for attr in [
        "data-i18n=\"",
        "data-i18n-placeholder=\"",
        "data-i18n-title=\"",
        "data-i18n-aria-label=\"",
    ] {
        used.extend(used_keys(HTML, attr));
    }
    assert!(
        used.len() > 20,
        "expected the UI strings to use the catalog"
    );
    for key in used {
        assert!(en.contains(&key), "missing message key: {key}");
    }
}

#[test]
fn extra_locale_covers_every_english_key() {
    assert_eq!(catalog_keys("en"), catalog_keys("es"));
}

#[test]
fn language_switcher_sets_lang_and_dir() {
    assert!(HTML.contains(r#"<select id="language""#));
    assert!(HTML.find("/dashboard/i18n.js") < HTML.find("/dashboard/app.js"));
    assert!(I18N.contains("navigator.language"));
    assert!(I18N.contains("root.lang =") && I18N.contains("root.dir ="));
}

#[test]
fn layout_uses_logical_properties() {
    for physical in [
        "left:",
        "right:",
        "-left",
        "-right:",
        "text-align: left",
        "text-align: right",
    ] {
        assert!(
            !CSS.contains(physical),
            "physical property in CSS: {physical}"
        );
    }
    assert!(CSS.contains("inset-inline-end: 0"));
}
