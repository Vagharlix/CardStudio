//! Card library on disk: every gallery card is a real file in a folder the
//! user can choose, so cards survive restarts, updates and reinstalls, and
//! the folder can be copied to another device.
//!
//! A location is named by a token:
//! - desktop: "default" (Documents/Card Studio) or the absolute path of a
//!   folder picked by the user;
//! - Android: "private" (the app's own storage) or the content:// URI of a
//!   folder picked with the system folder picker. Those folders are read and
//!   written by the Kotlin LibraryPlugin (Storage Access Framework), since
//!   Android only gives access to them through content URIs.
//!
//! Small settings (current card, file index) are kept in the app's private
//! data folder ("state").

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Passed back to the other commands as `at`.
    pub token: String,
    /// Shown to the user.
    pub label: String,
    /// A folder the user picked (not the default one).
    pub custom: bool,
    /// The folder picked before can no longer be opened (permission lost):
    /// the default location is used instead.
    #[serde(default)]
    pub lost: bool,
    /// Folder that receives a copy of every card (Android app storage only).
    #[serde(default)]
    pub backup: Option<String>,
    /// Why the last copy to `backup` failed, if it did.
    #[serde(default)]
    pub backup_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified: u64,
}

/// Plain file name inside the library folder: no folders, no "..".
fn check_name(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name.len() > 200
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
    if bad {
        Err(format!("invalid file name: {name}"))
    } else {
        Ok(name)
    }
}

fn check_state_key(key: &str) -> Result<&str, String> {
    if !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(key)
    } else {
        Err(format!("invalid state key: {key}"))
    }
}

// ---------------------------------------------------------------------------
// Folder on disk (desktop, Android private storage)
// ---------------------------------------------------------------------------

fn dir_list(dir: &Path) -> Result<Vec<FileEntry>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let Ok(item) = item else { continue };
        let Ok(meta) = item.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Some(name) = item.file_name().to_str().map(str::to_string) else { continue };
        if name.starts_with('.') {
            continue; // our temporary files, hidden files
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(FileEntry { name, size: meta.len(), modified });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn dir_read(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    let path = dir.join(check_name(name)?);
    fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes through a temporary file, flushed to disk, then renamed over the
/// target: a crash or a killed app never leaves a half-written card.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    let tmp = dir.join(format!(".{file_name}.tmp"));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        // make the rename itself durable (not possible on Windows)
        #[cfg(unix)]
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("{}: {e}", path.display()))
}

fn dir_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    write_atomic(&dir.join(check_name(name)?), bytes)
}

fn dir_delete(dir: &Path, name: &str) -> Result<(), String> {
    let path = dir.join(check_name(name)?);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct Config {
    /// Token of the chosen location; none = default.
    location: Option<String>,
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("library.json"))
}

fn read_config<R: Runtime>(app: &AppHandle<R>) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_config<R: Runtime>(app: &AppHandle<R>, config: &Config) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    write_atomic(&config_path(app)?, &bytes)
}

fn state_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("state"))
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/// Where a token points to.
enum Place {
    Dir(PathBuf),
    #[cfg(target_os = "android")]
    Tree(String),
}

#[cfg(not(target_os = "android"))]
const DEFAULT_TOKEN: &str = "default";
#[cfg(target_os = "android")]
const DEFAULT_TOKEN: &str = "private";

fn default_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "android"))]
    if let Ok(docs) = app.path().document_dir() {
        return Ok(docs.join("Card Studio"));
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("gallery"))
}

fn place<R: Runtime>(app: &AppHandle<R>, token: &str) -> Result<Place, String> {
    if token == DEFAULT_TOKEN {
        return Ok(Place::Dir(default_dir(app)?));
    }
    #[cfg(target_os = "android")]
    if token.starts_with("content://") {
        return Ok(Place::Tree(token.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    {
        let path = PathBuf::from(token);
        if path.is_absolute() {
            return Ok(Place::Dir(path));
        }
    }
    Err(format!("unknown library location: {token}"))
}

fn default_location<R: Runtime>(app: &AppHandle<R>, lost: bool) -> Result<Location, String> {
    #[cfg(target_os = "android")]
    let label = {
        let _ = app;
        String::from("App storage")
    };
    #[cfg(not(target_os = "android"))]
    let label = default_dir(app)?.display().to_string();
    let backup = backup_dir_for(DEFAULT_TOKEN).map(|_| BACKUP_LABEL.to_string());
    let backup_error = backup.as_ref().and_then(|_| BACKUP_ERROR.lock().ok().and_then(|e| e.clone()));
    Ok(Location { token: DEFAULT_TOKEN.into(), label, custom: false, lost, backup, backup_error })
}

// ---------------------------------------------------------------------------
// Backup copy (Android app storage)
// ---------------------------------------------------------------------------

/// While cards are kept in the Android app storage (the default), each card
/// file is also written to Documents/Card Studio: a folder the user can see
/// and copy, which stays when the app is uninstalled. Choosing it with
/// "Change folder" (on this or another phone) brings the cards back.
#[allow(dead_code)]
const BACKUP_LABEL: &str = "Documents/Card Studio";

fn backup_dir_for(token: &str) -> Option<PathBuf> {
    #[cfg(target_os = "android")]
    if token == DEFAULT_TOKEN {
        return Some(PathBuf::from("/storage/emulated/0/Documents/Card Studio"));
    }
    let _ = token;
    None
}

static BACKUP_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn note_backup(result: Result<(), String>) {
    if let Ok(mut slot) = BACKUP_ERROR.lock() {
        *slot = result.err();
    }
}

fn is_library_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".cardconjurer") || lower.ends_with(".jpg")
}

/// Copies to `backup` the card files of `primary` it does not have yet (or
/// has with another size). Never deletes anything there.
fn sync_backup(primary: &Path, backup: &Path) -> Result<u32, String> {
    let there: std::collections::HashMap<String, u64> =
        dir_list(backup).unwrap_or_default().into_iter().map(|f| (f.name, f.size)).collect();
    let mut copied = 0;
    for file in dir_list(primary)? {
        if !is_library_file(&file.name) || there.get(&file.name) == Some(&file.size) {
            continue;
        }
        let bytes = dir_read(primary, &file.name)?;
        dir_write(backup, &file.name, &bytes)?;
        copied += 1;
    }
    Ok(copied)
}

#[cfg(target_os = "android")]
mod android {
    use serde::{Deserialize, Serialize};
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    pub struct Library<R: Runtime>(pub PluginHandle<R>);

    #[derive(Deserialize)]
    pub struct Described {
        pub ok: bool,
        pub name: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct Picked {
        pub tree: Option<String>,
        pub name: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct Listed {
        pub files: Vec<super::FileEntry>,
    }

    #[derive(Deserialize)]
    pub struct Read {
        pub text: Option<String>,
        pub base64: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Args<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub tree: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub text: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub base64: Option<&'a str>,
        pub as_base64: bool,
    }

    impl<'a> Args<'a> {
        pub fn tree(tree: &'a str) -> Self {
            Self { tree: Some(tree), name: None, text: None, base64: None, as_base64: false }
        }
        pub fn file(tree: &'a str, name: &'a str) -> Self {
            Self { name: Some(name), ..Self::tree(tree) }
        }
    }

    pub async fn call<R: Runtime, T: serde::de::DeserializeOwned>(
        app: &AppHandle<R>,
        command: &str,
        args: Args<'_>,
    ) -> Result<T, String> {
        let library = app.try_state::<Library<R>>().ok_or("folder access is not ready")?;
        library.0.run_mobile_plugin_async(command, args).await.map_err(|e| e.to_string())
    }
}

/// Registers the Kotlin side of the library on Android (nothing elsewhere).
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("library")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("app.cardstudio.offline", "LibraryPlugin")?;
                _app.manage(android::Library(handle));
            }
            Ok(())
        })
        .build()
}

async fn current_location<R: Runtime>(app: &AppHandle<R>) -> Result<Location, String> {
    let Some(token) = read_config(app).location else {
        return default_location(app, false);
    };
    match place(app, &token) {
        Ok(Place::Dir(path)) => Ok(Location { label: path.display().to_string(), token, custom: true, lost: false, backup: None, backup_error: None }),
        #[cfg(target_os = "android")]
        Ok(Place::Tree(tree)) => {
            let described: android::Described = android::call(app, "describe", android::Args::tree(&tree)).await?;
            if described.ok {
                Ok(Location { label: described.name.unwrap_or_else(|| "Chosen folder".into()), token, custom: true, lost: false, backup: None, backup_error: None })
            } else {
                default_location(app, true)
            }
        }
        Err(_) => default_location(app, true),
    }
}

async fn resolve_at<R: Runtime>(app: &AppHandle<R>, at: Option<String>) -> Result<(Place, String), String> {
    let token = match at {
        Some(token) => token,
        None => current_location(app).await?.token,
    };
    Ok((place(app, &token)?, token))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The location cards are saved to.
#[tauri::command]
pub async fn library_info<R: Runtime>(app: AppHandle<R>) -> Result<Location, String> {
    current_location(&app).await
}

/// Lets the user pick a folder. Does not switch to it: the app first copies
/// the cards over, then calls `library_use`.
#[tauri::command]
pub async fn library_pick<R: Runtime>(app: AppHandle<R>) -> Result<Option<Location>, String> {
    #[cfg(target_os = "android")]
    {
        let picked: android::Picked = android::call(&app, "pick", android::Args::tree("")).await?;
        Ok(picked.tree.map(|tree| Location {
            label: picked.name.unwrap_or_else(|| "Chosen folder".into()),
            token: tree,
            custom: true,
            lost: false,
            backup: None,
            backup_error: None,
        }))
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file().set_title("Folder for your saved cards");
        if let Ok(Place::Dir(dir)) = place(&app, &current_location(&app).await?.token) {
            if dir.exists() {
                dialog = dialog.set_directory(dir);
            }
        }
        let Some(chosen) = dialog.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = chosen.into_path().map_err(|e| e.to_string())?;
        fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        // fail now rather than on the first save
        dir_write(&path, "card-studio-write-test.tmp", b"ok")?;
        dir_delete(&path, "card-studio-write-test.tmp")?;
        Ok(Some(Location { label: path.display().to_string(), token: path.display().to_string(), custom: true, lost: false, backup: None, backup_error: None }))
    }
}

/// Makes `token` the location for saved cards ("default"/"private" for the
/// default one).
#[tauri::command]
pub async fn library_use<R: Runtime>(app: AppHandle<R>, token: String) -> Result<Location, String> {
    place(&app, &token)?;
    let location = if token == DEFAULT_TOKEN { None } else { Some(token) };
    #[cfg(target_os = "android")]
    {
        // keep the permission of the folder in use only
        let keep = location.clone().unwrap_or_default();
        let _: serde_json::Value = android::call(&app, "keepOnly", android::Args::tree(&keep)).await?;
    }
    write_config(&app, &Config { location })?;
    current_location(&app).await
}

#[tauri::command]
pub async fn library_list<R: Runtime>(app: AppHandle<R>, at: Option<String>) -> Result<Vec<FileEntry>, String> {
    match resolve_at(&app, at).await?.0 {
        Place::Dir(dir) => dir_list(&dir),
        #[cfg(target_os = "android")]
        Place::Tree(tree) => {
            let listed: android::Listed = android::call(&app, "list", android::Args::tree(&tree)).await?;
            Ok(listed.files)
        }
    }
}

/// Reads a file as text, or as base64 when `base64` is true.
#[tauri::command]
pub async fn library_read<R: Runtime>(
    app: AppHandle<R>,
    at: Option<String>,
    name: String,
    base64: Option<bool>,
) -> Result<String, String> {
    use base64::Engine;
    let as_base64 = base64.unwrap_or(false);
    check_name(&name)?;
    match resolve_at(&app, at).await?.0 {
        Place::Dir(dir) => {
            let bytes = dir_read(&dir, &name)?;
            if as_base64 {
                Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
            } else {
                String::from_utf8(bytes).map_err(|_| format!("{name} is not a text file"))
            }
        }
        #[cfg(target_os = "android")]
        Place::Tree(tree) => {
            let args = android::Args { as_base64, ..android::Args::file(&tree, &name) };
            let read: android::Read = android::call(&app, "read", args).await?;
            read.text.or(read.base64).ok_or_else(|| format!("{name}: empty answer"))
        }
    }
}

/// Writes a file from `text`, or from `base64` for binary files.
#[tauri::command]
pub async fn library_write<R: Runtime>(
    app: AppHandle<R>,
    at: Option<String>,
    name: String,
    text: Option<String>,
    base64: Option<String>,
) -> Result<(), String> {
    use base64::Engine;
    check_name(&name)?;
    let (target, token) = resolve_at(&app, at).await?;
    match target {
        Place::Dir(dir) => {
            let bytes = match (&text, &base64) {
                (Some(t), _) => t.as_bytes().to_vec(),
                (None, Some(b)) => base64::engine::general_purpose::STANDARD
                    .decode(b.as_bytes())
                    .map_err(|e| format!("invalid file data: {e}"))?,
                (None, None) => return Err("nothing to write".into()),
            };
            dir_write(&dir, &name, &bytes)?;
            if let Some(backup) = backup_dir_for(&token) {
                note_backup(dir_write(&backup, &name, &bytes));
            }
            Ok(())
        }
        #[cfg(target_os = "android")]
        Place::Tree(tree) => {
            let args = android::Args { text: text.as_deref(), base64: base64.as_deref(), ..android::Args::file(&tree, &name) };
            let _: serde_json::Value = android::call(&app, "write", args).await?;
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn library_delete<R: Runtime>(app: AppHandle<R>, at: Option<String>, name: String) -> Result<(), String> {
    check_name(&name)?;
    let (target, token) = resolve_at(&app, at).await?;
    match target {
        Place::Dir(dir) => {
            dir_delete(&dir, &name)?;
            if let Some(backup) = backup_dir_for(&token) {
                note_backup(dir_delete(&backup, &name));
            }
            Ok(())
        }
        #[cfg(target_os = "android")]
        Place::Tree(tree) => {
            let _: serde_json::Value = android::call(&app, "delete", android::Args::file(&tree, &name)).await?;
            Ok(())
        }
    }
}

/// Brings the backup copy up to date (cards saved before it existed, or
/// while it could not be written). Returns how many files were copied.
#[tauri::command]
pub async fn library_backup_sync<R: Runtime>(app: AppHandle<R>) -> Result<u32, String> {
    let token = current_location(&app).await?.token;
    let (Some(backup), Place::Dir(primary)) = (backup_dir_for(&token), place(&app, &token)?) else {
        return Ok(0);
    };
    let result = sync_backup(&primary, &backup);
    note_backup(result.as_ref().map(|_| ()).map_err(|e| e.clone()));
    result
}

/// Small app settings kept in the private data folder.
#[tauri::command]
pub async fn state_get<R: Runtime>(app: AppHandle<R>, key: String) -> Result<Option<String>, String> {
    let dir = state_dir(&app)?;
    let name = format!("{}.json", check_state_key(&key)?);
    match fs::read(dir.join(&name)) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{name}: {e}")),
    }
}

/// Saves a setting; `value` none deletes it.
#[tauri::command]
pub async fn state_set<R: Runtime>(app: AppHandle<R>, key: String, value: Option<String>) -> Result<(), String> {
    let dir = state_dir(&app)?;
    let name = format!("{}.json", check_state_key(&key)?);
    match value {
        Some(v) => dir_write(&dir, &name, v.as_bytes()),
        None => dir_delete(&dir, &name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("card-studio-library-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn names() {
        assert!(check_name("Ember Wyrm.cardconjurer").is_ok());
        assert!(check_name("Heisho, Shell of the World (2).jpg").is_ok());
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "c:x", "a\u{0}b"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_state_key("autosave").is_ok());
        assert!(check_state_key("library-index").is_ok());
        assert!(check_state_key("../x").is_err());
    }

    #[test]
    fn write_read_list_delete() {
        let dir = temp_dir("rw");
        assert_eq!(dir_list(&dir).unwrap(), vec![]); // missing folder = empty
        dir_write(&dir, "b.cardconjurer", b"{\"key\":\"b\"}").unwrap();
        dir_write(&dir, "a.jpg", &[0xff, 0xd8, 0xff]).unwrap();
        dir_write(&dir, "b.cardconjurer", b"{\"key\":\"b2\"}").unwrap(); // overwrite
        let names: Vec<String> = dir_list(&dir).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["a.jpg", "b.cardconjurer"]); // no temporary file left
        assert_eq!(dir_read(&dir, "b.cardconjurer").unwrap(), b"{\"key\":\"b2\"}");
        let listed = dir_list(&dir).unwrap();
        assert_eq!(listed[1].size, 12);
        assert!(listed[1].modified > 0);
        dir_delete(&dir, "a.jpg").unwrap();
        dir_delete(&dir, "a.jpg").unwrap(); // already gone: fine
        assert_eq!(dir_list(&dir).unwrap().len(), 1);
        assert!(dir_read(&dir, "../etc/passwd").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backup_copies_missing_and_changed_cards_only() {
        let primary = temp_dir("primary");
        let backup = temp_dir("backup");
        dir_write(&primary, "A.cardconjurer", b"{\"key\":\"A\"}").unwrap();
        dir_write(&primary, "A.jpg", b"jpg").unwrap();
        dir_write(&primary, "notes.txt", b"not a card").unwrap();
        assert_eq!(sync_backup(&primary, &backup).unwrap(), 2); // backup folder created
        assert_eq!(sync_backup(&primary, &backup).unwrap(), 0); // up to date
        dir_write(&primary, "A.cardconjurer", b"{\"key\":\"A\",\"v\":2}").unwrap();
        dir_write(&backup, "Old.cardconjurer", b"{}").unwrap(); // only in the backup: kept
        assert_eq!(sync_backup(&primary, &backup).unwrap(), 1);
        assert_eq!(dir_read(&backup, "A.cardconjurer").unwrap(), b"{\"key\":\"A\",\"v\":2}");
        let names: Vec<String> = dir_list(&backup).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["A.cardconjurer", "A.jpg", "Old.cardconjurer"]);
        fs::remove_dir_all(&primary).unwrap();
        fs::remove_dir_all(&backup).unwrap();
    }

    #[test]
    fn hidden_files_are_not_listed() {
        let dir = temp_dir("hidden");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".x.cardconjurer.tmp"), b"half").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        dir_write(&dir, "x.cardconjurer", b"{}").unwrap();
        let names: Vec<String> = dir_list(&dir).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["x.cardconjurer"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
