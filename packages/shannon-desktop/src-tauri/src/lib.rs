use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

const SERVER_ADDR: &str = "127.0.0.1:1948";
const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);
const READY_TIMEOUT_TICKS: u32 = 150; // ~30s total

struct ServerProcess(Mutex<Option<Child>>);

fn port_open(addr: &str) -> bool {
    addr.parse::<SocketAddr>()
        .ok()
        .and_then(|sa| TcpStream::connect_timeout(&sa, Duration::from_millis(200)).ok())
        .is_some()
}

fn spawn_shannon() -> Option<Child> {
    let bin = std::env::var("SHANNON_BIN").unwrap_or_else(|_| "shannon".into());
    match Command::new(&bin)
        .env("SHANNON_NO_OPEN", "1")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("shannon_desktop: failed to spawn `{}`: {}", bin, e);
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let child = if port_open(SERVER_ADDR) {
                None
            } else {
                spawn_shannon()
            };
            app.manage(ServerProcess(Mutex::new(child)));

            let window = app
                .get_webview_window("main")
                .expect("main window missing from tauri.conf.json");
            thread::spawn(move || {
                for _ in 0..READY_TIMEOUT_TICKS {
                    if port_open(SERVER_ADDR) {
                        let _ = window.eval("window.location.reload()");
                        let _ = window.show();
                        return;
                    }
                    thread::sleep(READY_POLL_INTERVAL);
                }
                let _ = window.show();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
