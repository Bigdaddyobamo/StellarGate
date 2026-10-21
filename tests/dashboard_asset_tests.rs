//! Static checks on the embedded dashboard assets.

const HTML: &str = include_str!("../static/dashboard.html");
const CSS: &str = include_str!("../static/dashboard.css");

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
