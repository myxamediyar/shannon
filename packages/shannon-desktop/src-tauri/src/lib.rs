// The Tauri shell is a thin wrapper now: it loads the prebuilt static SPA
// from packages/shannon/out (configured via build.frontendDist in
// tauri.conf.json) and exposes the http and fs plugins so the SPA's
// platform adapters can call providers and read/write
// ~/.shannon/config.json without going through a localhost server.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
