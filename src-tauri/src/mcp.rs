//! Servidor MCP (Model Context Protocol, JSON-RPC 2.0 por stdio) y puente IPC local con la
//! ventana de Folio en ejecución.
//!
//! Permite que cualquier agente de IA (Antigravity, Claude Code, Claude Desktop, VS Code,
//! Cursor, Codex, Gemini CLI) controle Folio de punta a punta:
//! - Crear hojas (`.md` o `.txt`), con categoría opcional, dejarlas flotando o abrirlas.
//! - Leer, listar, buscar (FTS5) y editar hojas existentes.
//! - Analizar y categorizar hojas (listar/crear/editar/borrar categorías, asignar categoría,
//!   mover a Recortes / Clippings, sugerir categorías localmente).
//! - Fijar/desfijar hojas, mover al secret-book o a la papelera, y restaurarlas.
//! - Controlar la interfaz en vivo cuando Folio está abierto: arrancar hojas en ventanas
//!   flotantes (`folio_tear_off_sheet`), dejarlas flotando o colapsadas en el dock
//!   (`folio_set_floating_sheet_mode`), devolverlas al cuaderno (`folio_return_torn_off_sheet`),
//!   abrir el mapa del cuaderno (`folio_open_map`), abrir la hoja suelta (`folio_open_capture`),
//!   traer una hoja al frente (`folio_open_notebook`), o volver a escanear (`folio_rescan`).
//!
//! Cuando Folio está abierto, las acciones pasan por un puente TCP local (`127.0.0.1`) cuya
//! dirección se guarda en `mcp_ipc_addr` dentro de `folio.db`, de modo que la interfaz y las
//! ventanas flotantes responden al instante. Si Folio está cerrado, las operaciones de datos y
//! estado persistido se aplican directamente sobre `folio.db` y la carpeta de notas, y las
//! hojas arrancadas quedan listas para abrirse solas la próxima vez que arranque Folio.

use std::io::{BufRead, BufReader, Write};
#[allow(unused_imports)]
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
#[allow(unused_imports)]
use std::sync::atomic::Ordering;
use std::sync::Arc;
#[allow(unused_imports)]
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[allow(unused_imports)]
use tauri::{AppHandle, Emitter, Manager};

use crate::commands;
use crate::db::Db;
use crate::model::{ListFilter, TornOffSheetState};
#[allow(unused_imports)]
use crate::scan::{self, EVENT_CHANGED};
use crate::{suggest, text, Shared};

const IPC_SETTING_KEY: &str = "mcp_ipc_addr";

/// Petición interna enviada desde el proceso `folio mcp` hacia la app GUI en ejecución.
#[derive(Debug, Serialize, Deserialize)]
pub struct IpcRequest {
    pub tool: String,
    pub args: Value,
}

/// Respuesta del puente IPC local.
#[derive(Debug, Serialize, Deserialize)]
pub struct IpcResponse {
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// Inicia en segundo plano el puente IPC local dentro del proceso principal de Folio.
#[cfg(not(test))]
pub fn spawn_ipc_bridge(app: &AppHandle, shared: &Arc<Shared>) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        return;
    };
    if let Ok(addr) = listener.local_addr() {
        let _ = shared.db.set_setting(IPC_SETTING_KEY, &addr.to_string());
    }
    let app = app.clone();
    let shared = Arc::clone(shared);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                let _ = handle_ipc_client(stream, &app, &shared);
            });
        }
    });
}

#[cfg(not(test))]
fn handle_ipc_client(mut stream: TcpStream, app: &AppHandle, shared: &Arc<Shared>) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut line = String::new();
    {
        let mut reader = BufReader::new(&stream);
        reader.read_line(&mut line)?;
    }
    if line.trim().is_empty() {
        return Ok(());
    }
    let response = match serde_json::from_str::<IpcRequest>(&line) {
        Ok(req) => {
            let notes_dir = crate::notes_dir();
            match execute_tool_with_app(Some(app), Some(shared), &shared.db, notes_dir.as_deref(), &req.tool, &req.args) {
                Ok(val) => IpcResponse { ok: true, result: Some(val), error: None },
                Err(err) => IpcResponse { ok: false, result: None, error: Some(err) },
            }
        }
        Err(err) => IpcResponse { ok: false, result: None, error: Some(err.to_string()) },
    };
    let mut payload = serde_json::to_string(&response).unwrap_or_else(|_| r#"{"ok":false,"error":"serialization error"}"#.into());
    payload.push('\n');
    stream.write_all(payload.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
pub fn spawn_ipc_bridge(_app: &AppHandle, _shared: &Arc<Shared>) {}

/// Intenta delegar la llamada a la instancia de Folio abierta para que las ventanas y eventos
/// se actualicen en vivo. Devuelve `None` si Folio no está corriendo.
fn try_call_running_app(db: &Db, tool: &str, args: &Value) -> Option<Result<Value, String>> {
    let addr = db.get_setting(IPC_SETTING_KEY)?;
    let sock_addr: std::net::SocketAddr = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&sock_addr, Duration::from_millis(250)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let req = IpcRequest { tool: tool.to_string(), args: args.clone() };
    let mut payload = serde_json::to_string(&req).ok()?;
    payload.push('\n');
    stream.write_all(payload.as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut reply = String::new();
    BufReader::new(&stream).read_line(&mut reply).ok()?;
    let parsed: IpcResponse = serde_json::from_str(&reply).ok()?;
    if parsed.ok {
        Some(Ok(parsed.result.unwrap_or(Value::Null)))
    } else {
        Some(Err(parsed.error.unwrap_or_else(|| "Error ejecutando herramienta en Folio".into())))
    }
}

/// Resuelve dónde vive `folio.db` en este sistema (o usa `FOLIO_DB_PATH` si está definida).
pub fn default_db_path() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("FOLIO_DB_PATH") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    let base = dirs::data_dir()
        .or_else(dirs::config_dir)
        .ok_or_else(|| "No se encontró el directorio de datos del usuario".to_string())?;
    let dir = base.join("com.j-playground.folio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join("folio.db");
    if !db_path.exists() {
        let legacy = base.join("com.joaquinh.book").join("book.db");
        if legacy.exists() {
            let _ = std::fs::copy(&legacy, &db_path);
        }
    }
    Ok(db_path)
}

/// Resuelve la carpeta de notas de Folio (o usa `FOLIO_NOTES_DIR` si está definida).
pub fn resolve_notes_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("FOLIO_NOTES_DIR") {
        if !custom.trim().is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    crate::notes_dir()
}

/// Definición de todas las herramientas MCP expuestas por Folio.
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "folio_get_overview",
            "description": "Obtiene el resumen general del cuaderno Folio: conteos de hojas (todas, hoy, sin categoría, secretas, papelera), lista de categorías con sus IDs y colores, carpeta de notas y hojas flotantes abiertas.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "folio_list_sheets",
            "description": "Lista o busca hojas en el cuaderno Folio filtrando por vista ('all', 'today', 'uncategorized', 'category', 'secret', 'hidden'), categoría, texto de búsqueda (FTS5) y límite.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "view": {
                        "type": "string",
                        "description": "Vista a consultar: 'all' (por defecto), 'today', 'uncategorized', 'category', 'secret' o 'hidden' (papelera).",
                        "enum": ["all", "today", "uncategorized", "category", "secret", "hidden"]
                    },
                    "categoryId": {
                        "type": "integer",
                        "description": "ID de la categoría cuando view = 'category', o para filtrar por esa categoría."
                    },
                    "query": {
                        "type": "string",
                        "description": "Texto a buscar en título y contenido."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Cantidad máxima de hojas a devolver (por defecto 50)."
                    }
                }
            }
        },
        {
            "name": "folio_get_sheet",
            "description": "Lee el detalle completo de una hoja por su ID (título, contenido completo, categoría, ruta del archivo, estado fijado/secreto/papelera, hash y versiones anteriores).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "folio_create_sheet",
            "description": "Crea una hoja nueva en Folio como archivo en la carpeta de notas y la indexa inmediatamente. Permite asignarle categoría por ID o por nombre (creándola si se pide), y opcionalmente dejarla abierta como ventana flotante ('tearOff': true) o colapsada en el dock.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Título de la hoja (p. ej. 'Plan de migración' o '2026-10-24-plan.md')." },
                    "content": { "type": "string", "description": "Contenido completo de la nota (texto plano o Markdown)." },
                    "categoryId": { "type": "integer", "description": "ID de la categoría a asignar." },
                    "categoryName": { "type": "string", "description": "Nombre de la categoría a asignar (si no existe y createCategoryIfMissing es true, la crea)." },
                    "createCategoryIfMissing": { "type": "boolean", "description": "Si es true y categoryName no existe, crea la categoría automáticamente." },
                    "pinned": { "type": "boolean", "description": "Si es true, fija la hoja arriba del cuaderno." },
                    "tearOff": { "type": "boolean", "description": "Si es true, arranca la hoja y la deja abierta en su propia ventana flotante." },
                    "collapsed": { "type": "boolean", "description": "Cuando tearOff es true, si debe abrirse colapsada como ícono en el dock (false por defecto)." }
                },
                "required": ["title", "content"]
            }
        },
        {
            "name": "folio_update_sheet",
            "description": "Edita el contenido y/o el título de una hoja existente en Folio, o le agrega texto al final ('append': true).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja a editar." },
                    "content": { "type": "string", "description": "Nuevo contenido completo (o texto a agregar al final si append = true)." },
                    "title": { "type": "string", "description": "Nuevo título opcional (renombra el archivo si vive en la carpeta de Folio)." },
                    "append": { "type": "boolean", "description": "Si es true, agrega 'content' al final del contenido existente separado por un salto en blanco." }
                },
                "required": ["id", "content"]
            }
        },
        {
            "name": "folio_list_categories",
            "description": "Lista todas las categorías del cuaderno con su ID, nombre, descripción, color y cantidad de hojas.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "folio_create_category",
            "description": "Crea una nueva categoría en el cuaderno Folio.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Nombre de la categoría." },
                    "description": { "type": "string", "description": "Descripción de qué tipo de notas van en esta categoría." },
                    "color": { "type": "string", "description": "Color hexadecimal opcional (p. ej. '#007AFF', '#34C759', '#FF9500', '#AF52DE')." }
                },
                "required": ["name"]
            }
        },
        {
            "name": "folio_update_category",
            "description": "Actualiza el nombre, la descripción o el color de una categoría existente.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la categoría." },
                    "name": { "type": "string", "description": "Nuevo nombre." },
                    "description": { "type": "string", "description": "Nueva descripción." },
                    "color": { "type": "string", "description": "Nuevo color hexadecimal." }
                },
                "required": ["id", "name"]
            }
        },
        {
            "name": "folio_delete_category",
            "description": "Elimina una categoría del cuaderno (las hojas que tenía quedan sin categoría, nunca se borran).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la categoría a eliminar." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "folio_set_sheet_category",
            "description": "Asigna o quita la categoría de una hoja (por categoryId o por categoryName; ambos nulos quitan la categoría).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja." },
                    "categoryId": { "type": ["integer", "null"], "description": "ID de la categoría, o null para dejarla sin categoría." },
                    "categoryName": { "type": "string", "description": "Nombre de la categoría (alternativa a categoryId; si no existe, la crea si createIfMissing = true)." },
                    "createIfMissing": { "type": "boolean", "description": "Si es true y categoryName no existe, crea la categoría." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "folio_suggest_categories",
            "description": "Analiza localmente el contenido de las hojas del cuaderno y sugiere categorías nuevas con palabras clave y ejemplos.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "folio_set_sheet_pinned",
            "description": "Fija o desfija una hoja en la parte superior del cuaderno.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja." },
                    "pinned": { "type": "boolean", "description": "true para fijar, false para desfijar." }
                },
                "required": ["id", "pinned"]
            }
        },
        {
            "name": "folio_move_sheet",
            "description": "Mueve una hoja a un destino del cuaderno o la restaura: 'clippings' (categoría Recortes), 'secret' (cuaderno secreto cifrado), 'trash' (papelera) o 'notebook' (restaurar de papelera/secreto al cuaderno principal).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja." },
                    "destination": {
                        "type": "string",
                        "enum": ["clippings", "secret", "trash", "notebook"],
                        "description": "Destino: 'clippings' (Recortes), 'secret' (secret-book), 'trash' (papelera) o 'notebook' (sacar de papelera y secret-book)."
                    }
                },
                "required": ["id", "destination"]
            }
        },
        {
            "name": "folio_tear_off_sheet",
            "description": "Arranca una hoja del cuaderno y la abre en su propia ventana flotante siempre visible (o colapsada como ícono en el dock). Si ya estaba abierta, la trae al frente sin duplicarla.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja a arrancar." },
                    "collapsed": { "type": "boolean", "description": "Si es true, la abre colapsada como ícono en el dock; si es false (por defecto), la abre expandida." },
                    "pinned": { "type": "boolean", "description": "Si es true, fija la ventana flotante expandida para que no se colapse al cambiar de ventana." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "folio_set_floating_sheet_mode",
            "description": "Cambia el estado de una hoja flotante arrancada (expandir o colapsar al dock, fijar/desfijar).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja flotante." },
                    "collapsed": { "type": "boolean", "description": "true para colapsar al ícono del dock, false para expandir." },
                    "pinned": { "type": "boolean", "description": "true para mantener fija expandida, false para auto-colapsar al perder foco." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "folio_return_torn_off_sheet",
            "description": "Devuelve una hoja arrancada al cuaderno (cierra su ventana flotante y la quita de la lista de hojas flotantes abiertas).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "ID de la hoja a devolver al cuaderno." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "folio_list_torn_off_sheets",
            "description": "Lista las hojas que están actualmente arrancadas en ventanas flotantes.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "folio_open_map",
            "description": "Abre la ventana principal de Folio y muestra el Mapa del cuaderno (vista en cuadrícula de todas las hojas).",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "folio_open_notebook",
            "description": "Abre y trae al frente la ventana principal del cuaderno Folio, opcionalmente posicionándose en una hoja concreta por su ID.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sheetId": { "type": "integer", "description": "ID opcional de la hoja que se quiere mostrar abierta en el cuaderno." }
                }
            }
        },
        {
            "name": "folio_open_capture",
            "description": "Abre la ventana flotante de captura rápida («Nueva hoja suelta») encima de las demás ventanas.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "folio_rescan",
            "description": "Inicia un re-escaneo de las carpetas vigiladas por Folio para indexar archivos nuevos o modificados.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }
    ])
}

fn resolve_category_by_name(db: &Db, name: &str, create_if_missing: bool) -> Result<Option<i64>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let cats = db.categories().map_err(|e| e.to_string())?;
    if let Some(found) = cats.iter().find(|c| c.name.eq_ignore_ascii_case(trimmed)) {
        return Ok(Some(found.id));
    }
    if create_if_missing {
        let id = db.create_category(trimmed, "", "#007AFF").map_err(|e| e.to_string())?;
        return Ok(Some(id));
    }
    Err(format!("No existe la categoría «{trimmed}». Usá createCategoryIfMissing=true o creala antes con folio_create_category."))
}

/// Ejecuta una herramienta MCP. Si `app` es `Some`, corre dentro de la instancia viva de Folio
/// y actualiza las ventanas en tiempo real; si `app` es `None`, primero intenta hablar por IPC
/// con la instancia abierta y, si no está abierta, opera directamente sobre `db` y `notes_dir`.
pub fn execute_tool(db: &Db, notes_dir: Option<&Path>, tool: &str, args: &Value) -> Result<Value, String> {
    if let Some(res) = try_call_running_app(db, tool, args) {
        return res;
    }
    execute_tool_with_app(None, None, db, notes_dir, tool, args)
}

pub fn execute_tool_with_app(
    #[allow(unused_variables)] app: Option<&AppHandle>,
    #[allow(unused_variables)] shared: Option<&Arc<Shared>>,
    db: &Db,
    notes_dir: Option<&Path>,
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    let emit_changed = || {
        #[cfg(not(test))]
        if let Some(app) = app {
            let _ = app.emit(EVENT_CHANGED, ());
        }
        if let Some(shared) = shared {
            shared.ping_classifier();
        }
    };

    match tool {
        "folio_get_overview" => {
            let counts = db.counts().map_err(|e| e.to_string())?;
            let categories = db.categories().map_err(|e| e.to_string())?;
            let torn_off = commands::load_torn_off_sheets(db);
            let clippings_category_id = db.clippings_category_id();
            Ok(json!({
                "counts": counts,
                "categories": categories,
                "notesDir": notes_dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                "clippingsCategoryId": clippings_category_id,
                "tornOffSheets": torn_off,
                "runningGui": app.is_some(),
            }))
        }
        "folio_list_sheets" => {
            let mut view = args
                .get("view")
                .and_then(|v| v.as_str())
                .unwrap_or("all")
                .to_string();
            let category_id = args.get("categoryId").and_then(|v| v.as_i64());
            if category_id.is_some() && view == "all" {
                view = "category".to_string();
            }
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            let limit = args.get("limit").and_then(|v| v.as_i64()).or(Some(50));
            let filter = ListFilter {
                view,
                category_id,
                query,
                before_ts: None,
                before_id: None,
                before_pinned: None,
                until: None,
                limit,
            };
            let sheets = db.list_sheets(&filter).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(sheets).map_err(|e| e.to_string())?)
        }
        "folio_get_sheet" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let sheet = db
                .get_sheet(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("No existe ninguna hoja con id {id}"))?;
            Ok(serde_json::to_value(sheet).map_err(|e| e.to_string())?)
        }
        "folio_create_sheet" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let raw_content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Falta el parámetro 'content'".to_string())?;
            let content = text::normalize_newlines(raw_content.trim_end());
            if content.trim().is_empty() {
                return Err("El contenido de la hoja no puede estar vacío".into());
            }
            let dir = notes_dir.ok_or_else(|| "No se encontró la carpeta de notas de Folio".to_string())?;
            #[allow(unused_variables)]
            let first_note = !dir.is_dir();

            let create_cat = args
                .get("createCategoryIfMissing")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let mut category_id = args.get("categoryId").and_then(|v| v.as_i64());
            if category_id.is_none() {
                if let Some(cat_name) = args.get("categoryName").and_then(|v| v.as_str()) {
                    category_id = resolve_category_by_name(db, cat_name, create_cat)?;
                }
            }

            let (id, _path) = commands::new_note(db, dir, title, &content)?;
            if let Some(cat_id) = category_id {
                db.set_sheet_category(id, Some(cat_id)).map_err(|e| e.to_string())?;
            }
            if args.get("pinned").and_then(|v| v.as_bool()) == Some(true) {
                db.set_sheet_pinned(id, true).map_err(|e| e.to_string())?;
            }

            #[cfg(not(test))]
            if let (Some(app), Some(shared)) = (app, shared) {
                commands::wrote_note(app, shared, first_note);
            }

            let tear_off = args.get("tearOff").and_then(|v| v.as_bool()).unwrap_or(false);
            let collapsed = args.get("collapsed").and_then(|v| v.as_bool()).unwrap_or(false);
            if tear_off {
                #[cfg(not(test))]
                if let (Some(app), Some(shared)) = (app, shared) {
                    let _ = crate::open_tear_off_window(app, shared, id, Some(collapsed));
                } else {
                    commands::upsert_torn_off(
                        db,
                        TornOffSheetState {
                            id,
                            collapsed,
                            pinned: false,
                            expanded_x: None,
                            expanded_y: None,
                            collapsed_x: None,
                            collapsed_y: None,
                        },
                    );
                }
                #[cfg(test)]
                commands::upsert_torn_off(
                    db,
                    TornOffSheetState {
                        id,
                        collapsed,
                        pinned: false,
                        expanded_x: None,
                        expanded_y: None,
                        collapsed_x: None,
                        collapsed_y: None,
                    },
                );
            }

            let detail = db
                .get_sheet(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "No se pudo leer la hoja recién creada".to_string())?;
            Ok(serde_json::to_value(detail).map_err(|e| e.to_string())?)
        }
        "folio_update_sheet" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let incoming_content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Falta el parámetro 'content'".to_string())?;
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            let append = args.get("append").and_then(|v| v.as_bool()).unwrap_or(false);

            let final_content = if append {
                let current = db
                    .get_sheet(id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("No existe ninguna hoja con id {id}"))?;
                let base = current.content.trim_end();
                if base.is_empty() {
                    incoming_content.to_string()
                } else {
                    format!("{base}\n\n{}", incoming_content.trim_start_matches('\n'))
                }
            } else {
                incoming_content.to_string()
            };

            commands::save(db, notes_dir, id, &final_content, title, None, true)?;
            emit_changed();
            let updated = db
                .get_sheet(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "La hoja ya no existe".to_string())?;
            Ok(serde_json::to_value(updated).map_err(|e| e.to_string())?)
        }
        "folio_list_categories" => {
            let categories = db.categories().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(categories).map_err(|e| e.to_string())?)
        }
        "folio_create_category" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                return Err("La categoría necesita un nombre".into());
            }
            let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("").trim();
            let color = args.get("color").and_then(|v| v.as_str()).unwrap_or("#007AFF").trim();
            let id = db.create_category(name, description, color).map_err(|e| e.to_string())?;
            emit_changed();
            let categories = db.categories().map_err(|e| e.to_string())?;
            let created = categories.into_iter().find(|c| c.id == id);
            Ok(json!({ "id": id, "category": created }))
        }
        "folio_update_category" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let existing = db
                .categories()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| format!("No existe la categoría con id {id}"))?;
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&existing.name)
                .trim();
            let description = args
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or(&existing.description)
                .trim();
            let color = args
                .get("color")
                .and_then(|v| v.as_str())
                .unwrap_or(&existing.color)
                .trim();
            db.update_category(id, name, description, color).map_err(|e| e.to_string())?;
            emit_changed();
            Ok(json!({ "ok": true, "id": id }))
        }
        "folio_delete_category" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            db.delete_category(id).map_err(|e| e.to_string())?;
            emit_changed();
            Ok(json!({ "ok": true, "deletedId": id }))
        }
        "folio_set_sheet_category" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let create_if_missing = args
                .get("createIfMissing")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let category_id = if let Some(cid) = args.get("categoryId").and_then(|v| v.as_i64()) {
                Some(cid)
            } else if let Some(cname) = args.get("categoryName").and_then(|v| v.as_str()) {
                resolve_category_by_name(db, cname, create_if_missing)?
            } else {
                None
            };
            db.set_sheet_category(id, category_id).map_err(|e| e.to_string())?;
            emit_changed();
            Ok(json!({ "ok": true, "id": id, "categoryId": category_id }))
        }
        "folio_suggest_categories" => {
            let suggestions = suggest::from_db(db)?;
            Ok(serde_json::to_value(suggestions).map_err(|e| e.to_string())?)
        }
        "folio_set_sheet_pinned" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let pinned = args
                .get("pinned")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "Falta el parámetro 'pinned'".to_string())?;
            db.set_sheet_pinned(id, pinned).map_err(|e| e.to_string())?;
            emit_changed();
            Ok(json!({ "ok": true, "id": id, "pinned": pinned }))
        }
        "folio_move_sheet" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let dest = args
                .get("destination")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Falta el parámetro 'destination'".to_string())?;
            match dest {
                "clippings" => {
                    let clip_id = db.ensure_clippings_category().map_err(|e| e.to_string())?;
                    db.set_sheet_hidden(id, false).map_err(|e| e.to_string())?;
                    db.set_sheet_secret(id, false).map_err(|e| e.to_string())?;
                    db.set_sheet_category(id, Some(clip_id)).map_err(|e| e.to_string())?;
                }
                "secret" => {
                    db.set_sheet_hidden(id, false).map_err(|e| e.to_string())?;
                    db.set_sheet_secret(id, true).map_err(|e| e.to_string())?;
                }
                "trash" => {
                    db.set_sheet_hidden(id, true).map_err(|e| e.to_string())?;
                }
                "notebook" => {
                    db.set_sheet_hidden(id, false).map_err(|e| e.to_string())?;
                    db.set_sheet_secret(id, false).map_err(|e| e.to_string())?;
                }
                other => return Err(format!("Destino desconocido: «{other}»")),
            }
            emit_changed();
            Ok(json!({ "ok": true, "id": id, "destination": dest }))
        }
        "folio_tear_off_sheet" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let collapsed = args.get("collapsed").and_then(|v| v.as_bool()).unwrap_or(false);
            let pinned = args.get("pinned").and_then(|v| v.as_bool());
            #[cfg(not(test))]
            if let (Some(app), Some(shared)) = (app, shared) {
                let mut st = crate::open_tear_off_window(app, shared, id, Some(collapsed))?;
                if let Some(p) = pinned {
                    commands::update_saved_torn_off(db, id, None, Some(p), None, None);
                    st.pinned = p;
                }
                return Ok(serde_json::to_value(st).map_err(|e| e.to_string())?);
            }
            let _ = db
                .get_sheet(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("No existe ninguna hoja con id {id}"))?;
            let existing = commands::load_torn_off_sheets(db).into_iter().find(|e| e.id == id);
            let st = TornOffSheetState {
                id,
                collapsed,
                pinned: pinned.unwrap_or_else(|| existing.as_ref().is_some_and(|e| e.pinned)),
                expanded_x: existing.as_ref().and_then(|e| e.expanded_x),
                expanded_y: existing.as_ref().and_then(|e| e.expanded_y),
                collapsed_x: existing.as_ref().and_then(|e| e.collapsed_x),
                collapsed_y: existing.as_ref().and_then(|e| e.collapsed_y),
            };
            commands::upsert_torn_off(db, st.clone());
            Ok(serde_json::to_value(st).map_err(|e| e.to_string())?)
        }
        "folio_set_floating_sheet_mode" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            let collapsed = args.get("collapsed").and_then(|v| v.as_bool());
            let pinned = args.get("pinned").and_then(|v| v.as_bool());
            commands::update_saved_torn_off(db, id, collapsed, pinned, None, None);
            #[cfg(not(test))]
            if let Some(app) = app {
                let label = format!("tearoff-{id}");
                if let Some(win) = app.get_webview_window(&label) {
                    if let Some(c) = collapsed {
                        let _ = commands::apply_floating_mode(app, &win, c, None, None);
                        let _ = win.emit("book:tearoff-mode", c);
                    }
                }
            }
            let updated = commands::load_torn_off_sheets(db)
                .into_iter()
                .find(|item| item.id == id);
            Ok(json!({ "ok": true, "id": id, "state": updated }))
        }
        "folio_return_torn_off_sheet" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Falta el parámetro 'id'".to_string())?;
            commands::remove_torn_off(db, id);
            #[cfg(not(test))]
            if let Some(app) = app {
                let label = format!("tearoff-{id}");
                if let Some(win) = app.get_webview_window(&label) {
                    let _ = win.destroy();
                }
                let _ = app.emit(EVENT_CHANGED, ());
            }
            Ok(json!({ "ok": true, "returnedId": id }))
        }
        "folio_list_torn_off_sheets" => {
            let list = commands::load_torn_off_sheets(db);
            Ok(serde_json::to_value(list).map_err(|e| e.to_string())?)
        }
        "folio_open_map" => {
            #[cfg(not(test))]
            if let Some(app) = app {
                crate::open_main_window(app);
                let _ = app.emit("book:open-map", ());
                return Ok(json!({ "ok": true, "opened": true }));
            }
            Ok(json!({ "ok": true, "opened": false, "note": "Folio no está abierto en este momento." }))
        }
        "folio_open_notebook" => {
            let sheet_id = args.get("sheetId").and_then(|v| v.as_i64());
            #[cfg(not(test))]
            if let Some(app) = app {
                crate::open_main_window(app);
                if let Some(id) = sheet_id {
                    let _ = app.emit("book:focus-sheet", id);
                }
                return Ok(json!({ "ok": true, "opened": true, "sheetId": sheet_id }));
            }
            Ok(json!({ "ok": true, "opened": false, "sheetId": sheet_id, "note": "Folio no está abierto en este momento." }))
        }
        "folio_open_capture" => {
            #[cfg(not(test))]
            if let Some(app) = app {
                crate::open_capture_window(app);
                return Ok(json!({ "ok": true, "opened": true }));
            }
            Ok(json!({ "ok": true, "opened": false, "note": "Folio no está abierto en este momento." }))
        }
        "folio_rescan" => {
            #[cfg(not(test))]
            if let (Some(app), Some(shared)) = (app, shared) {
                scan::spawn_scan(app, shared);
                return Ok(json!({ "ok": true, "running": shared.scanning.load(Ordering::SeqCst) }));
            }
            Ok(json!({ "ok": true, "running": false, "note": "Folio reescaneará las carpetas al abrirse." }))
        }
        other => Err(format!("Herramienta MCP desconocida: «{other}»")),
    }
}

/// Procesa un mensaje JSON-RPC 2.0 del protocolo MCP y devuelve la respuesta JSON-RPC (o `None`
/// si es una notificación como `notifications/initialized`).
pub fn handle_jsonrpc_message(db: &Db, notes_dir: Option<&Path>, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = msg.get("id").cloned();

    // Las notificaciones JSON-RPC no llevan `id` y no esperan respuesta.
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    match method {
        "initialize" => {
            let client_version = msg
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05");
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": client_version,
                    "capabilities": {
                        "tools": { "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "folio-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }))
        }
        "ping" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": tool_definitions()
            }
        })),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match execute_tool(db, notes_dir, tool_name, &args) {
                Ok(output) => {
                    let pretty = serde_json::to_string_pretty(&output).unwrap_or_else(|_| output.to_string());
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": pretty
                                }
                            ],
                            "structuredContent": output,
                            "isError": false
                        }
                    }))
                }
                Err(err) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": err
                            }
                        ],
                        "isError": true
                    }
                })),
            }
        }
        "resources/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "resources": [] }
        })),
        "prompts/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "prompts": [] }
        })),
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Method not found: {method}")
            }
        })),
    }
}

/// Ejecuta el servidor MCP por `stdin` / `stdout` (invocado con `folio mcp` o `folio --mcp`).
pub fn run_stdio_server() -> Result<(), String> {
    let db_path = default_db_path()?;
    let db = Db::open(&db_path).map_err(|e| e.to_string())?;
    let notes_dir = resolve_notes_dir();

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let read_bytes = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read_bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            let err_resp = json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": "Parse error" }
            });
            let _ = writeln!(writer, "{err_resp}");
            let _ = writer.flush();
            continue;
        };
        if let Some(reply) = handle_jsonrpc_message(&db, notes_dir.as_deref(), &msg) {
            let serialized = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
            writeln!(writer, "{serialized}").map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestEnv {
        dir: PathBuf,
        db: Db,
    }

    impl TestEnv {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("folio-mcp-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let db = Db::open(Path::new(":memory:")).expect("db en memoria");
            Self { dir, db }
        }

        fn call(&self, tool: &str, args: Value) -> Result<Value, String> {
            execute_tool_with_app(None, None, &self.db, Some(&self.dir), tool, &args)
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn mcp_jsonrpc_initialize_y_tools_list_funcionan() {
        let env = TestEnv::new("init");
        let init_resp = handle_jsonrpc_message(
            &env.db,
            Some(&env.dir),
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2024-11-05" }
            }),
        )
        .expect("respuesta initialize");
        assert_eq!(init_resp["result"]["serverInfo"]["name"], "folio-mcp");

        // Una notificación no devuelve respuesta.
        assert!(handle_jsonrpc_message(
            &env.db,
            Some(&env.dir),
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
        )
        .is_none());

        let list_resp = handle_jsonrpc_message(
            &env.db,
            Some(&env.dir),
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .expect("respuesta tools/list");
        let tools = list_resp["result"]["tools"].as_array().expect("lista de tools");
        assert!(tools.len() >= 15);
        assert!(tools.iter().any(|t| t["name"] == "folio_create_sheet"));
        assert!(tools.iter().any(|t| t["name"] == "folio_tear_off_sheet"));
    }

    #[test]
    fn mcp_flujo_completo_crear_categorizar_fijar_mover_y_dejar_flotando() {
        let env = TestEnv::new("flujo");

        // 1. Crear categoría y crear hoja asignada a esa categoría + fijada + arrancada como hoja flotante
        let cat = env
            .call(
                "folio_create_category",
                json!({
                    "name": "Arquitectura",
                    "description": "Decisiones técnicas y diseño",
                    "color": "#5856D6"
                }),
            )
            .unwrap();
        let cat_id = cat["id"].as_i64().unwrap();

        let created = env
            .call(
                "folio_create_sheet",
                json!({
                    "title": "2026-10-24-decision-mcp.md",
                    "content": "# Control por agentes\n\n- [x] Implementar servidor MCP stdio\n- [ ] Documentar skill",
                    "categoryId": cat_id,
                    "pinned": true,
                    "tearOff": true,
                    "collapsed": false
                }),
            )
            .unwrap();
        let sheet_id = created["id"].as_i64().unwrap();
        assert_eq!(created["categoryId"].as_i64(), Some(cat_id));
        assert_eq!(created["pinned"].as_bool(), Some(true));

        // 2. Verificar que quedó en la lista de hojas flotantes arrancadas
        let torn = env.call("folio_list_torn_off_sheets", json!({})).unwrap();
        let torn_arr = torn.as_array().unwrap();
        assert_eq!(torn_arr.len(), 1);
        assert_eq!(torn_arr[0]["id"].as_i64(), Some(sheet_id));
        assert_eq!(torn_arr[0]["collapsed"].as_bool(), Some(false));

        // 3. Colapsar la hoja flotante al dock y fijarla
        env.call(
            "folio_set_floating_sheet_mode",
            json!({ "id": sheet_id, "collapsed": true, "pinned": true }),
        )
        .unwrap();
        let torn_after = env.call("folio_list_torn_off_sheets", json!({})).unwrap();
        assert_eq!(torn_after[0]["collapsed"].as_bool(), Some(true));
        assert_eq!(torn_after[0]["pinned"].as_bool(), Some(true));

        // 4. Editar agregando texto al final (append)
        let updated = env
            .call(
                "folio_update_sheet",
                json!({
                    "id": sheet_id,
                    "content": "- [x] Probar herramientas MCP",
                    "append": true
                }),
            )
            .unwrap();
        assert!(updated["content"].as_str().unwrap().contains("Probar herramientas MCP"));

        // 5. Buscar la hoja con FTS5
        let found = env
            .call("folio_list_sheets", json!({ "query": "servidor MCP" }))
            .unwrap();
        assert_eq!(found.as_array().unwrap().len(), 1);

        // 6. Mover a Recortes (clippings), luego a secret-book, luego a papelera y restaurar al cuaderno
        env.call("folio_move_sheet", json!({ "id": sheet_id, "destination": "clippings" }))
            .unwrap();
        let in_clippings = env.call("folio_get_sheet", json!({ "id": sheet_id })).unwrap();
        assert!(in_clippings["categoryId"].as_i64().is_some());

        env.call("folio_move_sheet", json!({ "id": sheet_id, "destination": "secret" }))
            .unwrap();
        let in_secret = env.call("folio_get_sheet", json!({ "id": sheet_id })).unwrap();
        assert_eq!(in_secret["secret"].as_bool(), Some(true));

        env.call("folio_move_sheet", json!({ "id": sheet_id, "destination": "trash" }))
            .unwrap();
        let in_trash = env.call("folio_get_sheet", json!({ "id": sheet_id })).unwrap();
        assert_eq!(in_trash["hidden"].as_bool(), Some(true));

        env.call("folio_move_sheet", json!({ "id": sheet_id, "destination": "notebook" }))
            .unwrap();
        let restored = env.call("folio_get_sheet", json!({ "id": sheet_id })).unwrap();
        assert_eq!(restored["hidden"].as_bool(), Some(false));
        assert_eq!(restored["secret"].as_bool(), Some(false));

        // 7. Devolver la hoja flotante al cuaderno
        env.call("folio_return_torn_off_sheet", json!({ "id": sheet_id })).unwrap();
        let torn_empty = env.call("folio_list_torn_off_sheets", json!({})).unwrap();
        assert!(torn_empty.as_array().unwrap().is_empty());
    }
}
