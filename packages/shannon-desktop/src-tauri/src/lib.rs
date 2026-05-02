// The Tauri shell is a thin wrapper: it loads the prebuilt static SPA from
// packages/shannon/out (configured via build.frontendDist in tauri.conf.json)
// and exposes the http and fs plugins so the SPA's platform adapters can call
// providers and read/write ~/.shannon/ without going through a localhost server.
//
// Phase 4 additions:
//   * dialog plugin — native save / open file dialogs (HTML / .shannon export).
//   * `save_file_to_path` command — writes UTF-8 text to a user-chosen path.
//     Bypasses fs:scope intentionally: the path is one the user just confirmed
//     in a save dialog. Cleaner than expanding fs:scope to the entire disk.
//   * Native menu bar (File / Edit / View / Window) wired to webview events
//     that the React side picks up via @tauri-apps/api/event.

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Deserialize)]
pub struct RecentItem {
    pub id: String,
    pub title: String,
}

#[tauri::command]
fn save_file_to_path(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ── Page-region print ────────────────────────────────────────────────────────
// Replaces the kick-to-default-browser fallback. Caller writes the print HTML
// (with @page sizing, region clip, etc.) and invokes `open_print_window` with
// it. Rust persists the payload to ~/.shannon/.print-tmp.html, opens a small
// helper WebviewWindow pointing at the `shannon-print://` custom scheme
// (which streams that file back), and on page-load calls `Webview::print()`
// to surface the native macOS print panel. The helper page listens for
// `afterprint` and invokes `close_print_helper` to dismiss the helper window.

const PRINT_HELPER_LABEL: &str = "shannon-print-helper";

fn print_tmp_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME unset".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".shannon").join(".print-tmp.html"))
}

#[tauri::command]
fn open_print_window<R: Runtime>(app: AppHandle<R>, html: String) -> Result<(), String> {
    let path = print_tmp_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, html).map_err(|e| format!("write {}: {e}", path.display()))?;

    if let Some(existing) = app.get_webview_window(PRINT_HELPER_LABEL) {
        let _ = existing.close();
    }

    let url: tauri::Url = "shannon-print://localhost/print"
        .parse()
        .map_err(|e| format!("parse url: {e}"))?;

    WebviewWindowBuilder::new(&app, PRINT_HELPER_LABEL, WebviewUrl::CustomProtocol(url))
        .title("Print")
        .inner_size(420.0, 240.0)
        .center()
        .visible(true)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Err(e) = webview.print() {
                    eprintln!("[print] webview.print() failed: {e}");
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn close_print_helper<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PRINT_HELPER_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}


fn truncate_title(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return "Untitled".into();
    }
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}

fn build_recent_submenu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    recents: &[RecentItem],
) -> tauri::Result<Submenu<R>> {
    if recents.is_empty() {
        // Greyed-out "(No recent notes)" placeholder so the submenu still
        // appears in the menu bar but signals state.
        let placeholder = MenuItem::with_id(
            app,
            "recent.__none__",
            "(No recent notes)",
            false,
            None::<&str>,
        )?;
        return Submenu::with_items(app, "Open Recent", true, &[&placeholder]);
    }

    // Build the items first; their refs need a stable backing Vec so the
    // `&[&dyn IsMenuItem<R>]` slice we pass to Submenu::with_items is valid
    // for the call duration.
    let mut items: Vec<MenuItem<R>> = Vec::with_capacity(recents.len());
    for r in recents {
        let id = format!("recent.{}", r.id);
        let label = truncate_title(&r.title, 60);
        items.push(MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
    }
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i as &dyn IsMenuItem<R>).collect();
    Submenu::with_items(app, "Open Recent", true, &refs)
}

fn build_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    recents: &[RecentItem],
) -> tauri::Result<Menu<R>> {
    let new_note = MenuItem::with_id(app, "menu.new_note", "New Note", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "menu.open", "Open .shannon…", true, Some("CmdOrCtrl+O"))?;
    let recent_submenu = build_recent_submenu(app, recents)?;
    let export_shannon = MenuItem::with_id(
        app,
        "menu.export_shannon",
        "Export Active Note as .shannon…",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let export_html = MenuItem::with_id(
        app,
        "menu.export_html",
        "Export Active Note as HTML…",
        true,
        Some("CmdOrCtrl+Shift+E"),
    )?;
    let print = MenuItem::with_id(app, "menu.print", "Print Page Region", true, Some("CmdOrCtrl+P"))?;
    let reveal = MenuItem::with_id(app, "menu.reveal_data_dir", "Reveal ~/.shannon", true, None::<&str>)?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_note,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &recent_submenu,
            &PredefinedMenuItem::separator(app)?,
            &export_shannon,
            &export_html,
            &print,
            &PredefinedMenuItem::separator(app)?,
            &reveal,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let toggle_sidebar = MenuItem::with_id(
        app,
        "menu.toggle_sidebar",
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // The "app" submenu (macOS application menu). On other platforms Tauri
    // folds these items into the File menu's tail.
    let about = PredefinedMenuItem::about(
        app,
        Some("About Shannon"),
        Some(AboutMetadata {
            name: Some("Shannon".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            website: Some("https://github.com/myxamediyar/shannon".into()),
            ..Default::default()
        }),
    )?;
    let app_menu = Submenu::with_items(
        app,
        "Shannon",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

fn on_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, event: MenuEvent) {
    // Custom menu items have ids prefixed with `menu.`. We forward the suffix
    // verbatim to the webview as `menu:<suffix>` so the React-side hook can
    // route it. Predefined items (cut/copy/quit/etc.) carry their own ids
    // and are handled by Tauri itself — they never reach this branch.
    let id = event.id().0.as_str();
    if let Some(rest) = id.strip_prefix("menu.") {
        let event_name = format!("menu:{}", rest.replace('_', "-"));
        let _ = app.emit(&event_name, ());
    } else if let Some(note_id) = id.strip_prefix("recent.") {
        if note_id == "__none__" {
            return;
        }
        let _ = app.emit("menu:open-recent", note_id.to_string());
    }
}

#[tauri::command]
fn set_recent_notes<R: Runtime>(app: AppHandle<R>, items: Vec<RecentItem>) -> Result<(), String> {
    // Tauri 2 doesn't have a clean per-submenu replace API; rebuilding the
    // entire menu is fast (a few dozen items) and keeps state ownership in
    // JS where the recents file is.
    let menu = build_menu(&app, &items).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Custom URI scheme that serves the print payload the JS caller just
        // wrote to ~/.shannon/.print-tmp.html. Used by the helper webview
        // window opened in `open_print_window` — gives WKWebView a real HTTP
        // origin so its print API can rasterize the page.
        .register_uri_scheme_protocol("shannon-print", |_ctx, _request| {
            let path = match print_tmp_path() {
                Ok(p) => p,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            match std::fs::read(&path) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_file_to_path,
            open_print_window,
            close_print_helper,
            set_recent_notes
        ])
        .setup(|app| {
            // Empty recents at startup — JS calls set_recent_notes after it
            // reads ~/.shannon/recents.json, which fills the submenu.
            let menu = build_menu(app.handle(), &[])?;
            app.set_menu(menu)?;
            app.on_menu_event(on_menu_event);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
