//! Clasificación automática: decide qué hojas se consultan y cuándo. Cada consulta se paga,
//! así que una hoja se consulta una sola vez y recién cuando dejó de cambiar. Lo demás
//! (guardados seguidos, el color de una categoría, la confianza mínima) se resuelve sin
//! llamar a la API. A qué IA se consulta (Jev, Claude, OpenAI, Gemini u Ollama) lo decide
//! `provider.rs`: acá es la misma política para todas.

use std::collections::HashMap;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::db::{hash, now_ms, CategoryDef, Db, JevPolicy, PendingSheet};
use crate::provider::{self, AiError, Verdict};
use crate::scan::EVENT_CHANGED;
use crate::{jev, Shared};

/// Sin nada esperando, el hilo duerme hasta que lo despierten: esto es solo el tope.
const IDLE: Duration = Duration::from_secs(3600);
/// Hojas por tanda. Entre tandas se avisa a la interfaz y se releen los ajustes, así que
/// apagar la clasificación corta enseguida.
const BATCH: usize = 5;
/// Espera ante servicio ocupado o sin red: un minuto, y el doble con cada falla seguida.
const BACKOFF_MS: i64 = 60_000;
const BACKOFF_MAX_MS: i64 = 60 * 60_000;
/// Espera antes de reintentar una hoja que la IA rechazó: 15 minutos, y el cuádruple cada vez.
const ASIDE_MS: i64 = 15 * 60_000;
const ASIDE_MAX_MS: i64 = 24 * 60 * 60_000;
/// Con tantos rechazos seguidos, el problema no es de una hoja: se frena todo un rato.
const MAX_STRIKES: u32 = 3;
/// Rechazos de una misma hoja (mientras las demás pasan) antes de dejar de insistir.
const GIVE_UP: u32 = 3;

/// Por qué se despierta al hilo de clasificación. Despertarlo nunca cuesta una consulta:
/// el hilo mira si hay hojas listas y, si no, sigue durmiendo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Wake {
    /// Algo cambió en el Book (un guardado, un escaneo, una categoría).
    Changed,
    /// El usuario tocó algo del clasificador (la IA, la clave, el interruptor, "volver a
    /// clasificar"): además se olvidan los errores y las esperas que hubiera.
    Retry,
    /// "Clasificar ahora": como `Retry`, y sin esperar a que las hojas estén quietas.
    Now,
}

/// Una hoja que la IA rechazó: se la aparta un tiempo para que no trabe a las demás.
struct Aside {
    hash: String,
    retry_at: i64,
    tries: u32,
    /// Cuántas consultas habían salido bien cuando la rechazó por primera vez.
    since: u64,
}

/// Lo que el clasificador recuerda entre tandas. No va a la base: al reiniciar Book se
/// empieza de cero.
#[derive(Default)]
pub struct Memory {
    /// La clave fue rechazada: no se consulta más hasta que el usuario haga algo.
    halted: bool,
    /// Servicio ocupado o sin red: no se consulta antes de este instante.
    retry_at: i64,
    /// Fallas seguidas del servicio; de esto depende cuánto se espera.
    failures: u32,
    /// Hojas rechazadas una tras otra.
    strikes: u32,
    /// Consultas que la IA respondió bien.
    answered: u64,
    aside: HashMap<i64, Aside>,
    /// Qué IA y qué modelo se están consultando (`Engine::tag`). Entra en la firma del caché:
    /// un veredicto de una IA no se reutiliza con otra. Vacío en Jev.
    engine: String,
}

impl Memory {
    fn skips(&self, id: i64, hash: &str, now: i64) -> bool {
        self.aside.get(&id).is_some_and(|aside| aside.hash == hash && now < aside.retry_at)
    }

    /// Posterga todas las consultas y devuelve cuánto (ms). `asked` es lo que pidió
    /// esperar la IA, si lo dijo.
    fn back_off(&mut self, now: i64, asked: Option<i64>) -> i64 {
        let wait = (BACKOFF_MS << self.failures.min(6)).max(asked.unwrap_or(0)).min(BACKOFF_MAX_MS);
        self.failures += 1;
        self.retry_at = now + wait;
        wait
    }

    /// Aparta una hoja que la IA rechazó. Devuelve `true` cuando ya no vale la pena
    /// insistir: la rechazó `GIVE_UP` veces y entre medio otras hojas sí se clasificaron,
    /// así que el problema es de esta hoja y no del servicio.
    fn set_aside(&mut self, id: i64, hash: &str, now: i64) -> bool {
        let (tries, since) = match self.aside.get(&id).filter(|aside| aside.hash == hash) {
            Some(aside) => (aside.tries + 1, aside.since),
            None => (1, self.answered),
        };
        if tries >= GIVE_UP && self.answered > since {
            self.aside.remove(&id);
            return true;
        }
        let wait = (ASIDE_MS << (2 * (tries - 1)).min(8)).min(ASIDE_MAX_MS);
        self.aside.insert(id, Aside { hash: hash.to_string(), retry_at: now + wait, tries, since });
        false
    }
}

/// Firma de la lista de categorías tal como la lee Jev (ids, nombres y descripciones; el
/// color y el orden no cuentan). Un veredicto guardado vale mientras la firma sea la misma.
/// Es la firma de Jev; las demás IAs usan `signature_with`.
#[cfg(test)]
pub fn signature(categories: &[CategoryDef]) -> String {
    signature_with(categories, "")
}

/// La firma para la IA y el modelo `engine` (ver `Engine::tag`): cambiar de IA o de modelo
/// cambia la firma, y los veredictos de la anterior no se reutilizan. Con `engine` vacío (Jev)
/// es la firma de siempre.
pub fn signature_with(categories: &[CategoryDef], engine: &str) -> String {
    let mut sorted: Vec<&CategoryDef> = categories.iter().collect();
    sorted.sort_by_key(|(id, _, _)| *id);
    let mut text = String::from(jev::REQUEST_VERSION);
    for (id, name, description) in sorted {
        text.push_str(&format!("\u{1e}{id}\u{1f}{name}\u{1f}{description}"));
    }
    if !engine.is_empty() {
        text.push_str(&format!("\u{1d}{engine}"));
    }
    hash(&text)
}

/// La decisión: qué hojas toca consultar en `now` (hasta `limit`, las más recientes
/// primero). Vacío si no hay ninguna lista o si hay que esperar por un error.
pub fn pick(db: &Db, now: i64, policy: &JevPolicy, memory: &mut Memory, limit: usize) -> Vec<i64> {
    if memory.halted || now < memory.retry_at {
        return Vec::new();
    }
    let due = db.jev_due(now, policy).unwrap_or_default();
    // Lo apartado que ya no está en la lista (se editó, salió del Book) se olvida.
    memory.aside.retain(|id, _| due.iter().any(|(due_id, _)| due_id == id));
    due.into_iter()
        .filter(|(id, hash)| !memory.skips(*id, hash, now))
        .map(|(id, _)| id)
        .take(limit)
        .collect()
}

/// Cuándo hay que volver a mirar si en `now` no quedó nada para consultar: al terminar
/// la espera por un error, o cuando la primera hoja que está esperando quede lista.
/// `None` si no hay nada esperando.
pub fn next_look(db: &Db, now: i64, policy: &JevPolicy, memory: &Memory) -> Option<i64> {
    if memory.halted {
        return None;
    }
    if now < memory.retry_at {
        return Some(memory.retry_at);
    }
    let aside = memory.aside.values().map(|aside| aside.retry_at).filter(|at| *at > now).min();
    [db.jev_next(now, policy), aside].into_iter().flatten().min()
}

/// Cómo salió una tanda.
#[derive(Default)]
pub struct Round {
    /// Consultas hechas a la IA.
    pub asked: usize,
    /// Hojas resueltas con un veredicto guardado, sin consultar.
    pub reused: usize,
    /// Qué falló, si algo falló.
    pub error: Option<String>,
}

impl Round {
    fn pause(&mut self, memory: &mut Memory, now: i64, asked: Option<i64>, message: String) {
        let wait = (memory.back_off(now, asked) + 59_999) / 60_000;
        let minutes = if wait == 1 { "1 minuto".to_string() } else { format!("{wait} minutos") };
        self.error = Some(format!("{message} Book vuelve a intentar en {minutes}."));
    }
}

/// Clasifica las hojas que eligió `pick`. `ask` es la consulta a la IA: va aparte para
/// poder probar todo lo demás sin red.
pub fn round(
    db: &Db,
    now: i64,
    policy: &JevPolicy,
    categories: &[CategoryDef],
    memory: &mut Memory,
    batch: &[i64],
    ask: &mut dyn FnMut(&PendingSheet) -> Result<Verdict, AiError>,
) -> Round {
    let mut round = Round::default();
    let signature = signature_with(categories, &memory.engine);
    for &id in batch {
        // Se vuelve a mirar justo antes de enviarla: mientras se atendía a las anteriores
        // pudo pasar al secret-book, a la papelera o a una categoría puesta a mano.
        let sheet = match db.jev_sheet(id, now, policy) {
            Ok(Some(sheet)) => sheet,
            Ok(None) => continue,
            Err(err) => {
                round.pause(memory, now, None, format!("No se pudo leer una hoja para clasificarla: {err}."));
                break;
            }
        };
        let (verdict, fresh) = match db.cached_verdict(&sheet.hash, &signature) {
            Some(verdict) => (verdict, false),
            None => {
                let answer = ask(&sheet);
                if !matches!(answer, Err(AiError::Offline(_))) {
                    round.asked += 1;
                    let _ = db.count_jev_call(now);
                }
                match answer {
                    Ok(verdict) => (verdict, true),
                    Err(AiError::Auth(message)) => {
                        memory.halted = true;
                        round.error = Some(format!(
                            "{message} Book no vuelve a consultar hasta que cambies la clave o el modelo, o toques «Clasificar ahora»."
                        ));
                        break;
                    }
                    Err(AiError::Busy(message, wait)) => {
                        round.pause(memory, now, wait, message);
                        break;
                    }
                    Err(AiError::Offline(message)) => {
                        round.pause(memory, now, None, message);
                        break;
                    }
                    Err(AiError::Other(message)) => {
                        // No se anota nada en la hoja: conserva la categoría que tuviera y
                        // sigue pendiente, pero apartada para dejar pasar a las demás.
                        // Sin el título de la hoja: el aviso queda a la vista en Ajustes, y la hoja
                        // pudo pasar después al secret-book.
                        let message = format!("No se pudo clasificar una hoja. {message}");
                        if memory.set_aside(id, &sheet.hash, now) {
                            // Queda como vista, tal como estaba, para no insistir con ella.
                            if let Err(err) = db.mark_jev_seen(sheet.id, &sheet.hash, now) {
                                round.pause(memory, now, None, format!("No se pudo anotar la hoja: {err}."));
                                break;
                            }
                            round.error = Some(format!("{message} Book no vuelve a consultar por esa hoja."));
                            continue;
                        }
                        memory.strikes += 1;
                        if memory.strikes >= MAX_STRIKES {
                            round.pause(memory, now, None, message);
                            break;
                        }
                        round.error = Some(message);
                        continue;
                    }
                }
            }
        };
        let remember = fresh.then_some(signature.as_str());
        if let Err(err) = db.apply_verdict(sheet.id, &sheet.hash, &verdict, policy.threshold, now, remember) {
            // Sin poder anotar la respuesta, seguir sería consultar lo mismo una y otra vez.
            round.pause(memory, now, None, format!("No se pudo guardar la respuesta: {err}."));
            break;
        }
        if fresh {
            memory.failures = 0;
            memory.strikes = 0;
            memory.answered += 1;
        } else {
            round.reused += 1;
        }
    }
    round
}

/// Hilo de clasificación. Duerme hasta que lo despiertan o hasta que alguna hoja que
/// estaba esperando (la calma, el plazo de revisión, el fin de un error) queda lista.
pub fn spawn(app: &AppHandle, shared: &Arc<Shared>) {
    let (tx, rx) = mpsc::channel::<Wake>();
    *shared.classify_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    let app = app.clone();
    let shared = Arc::clone(shared);
    thread::spawn(move || {
        let mut memory = Memory::default();
        let mut sleep = IDLE;
        loop {
            let wake = match rx.recv_timeout(sleep) {
                // Varios avisos juntos cuentan como uno: el más exigente.
                Ok(first) => Some(rx.try_iter().fold(first, Ord::max)),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            sleep = work(&app, &shared, &mut memory, wake);
        }
    });
}

/// Atiende todo lo que esté listo y devuelve cuánto dormir hasta la próxima mirada.
fn work(app: &AppHandle, shared: &Shared, memory: &mut Memory, wake: Option<Wake>) -> Duration {
    let db = &shared.db;
    if matches!(wake, Some(Wake::Retry | Wake::Now)) {
        *memory = Memory::default();
    }
    loop {
        if !db.get_bool("jev_enabled", false) {
            return IDLE;
        }
        let categories = db.category_defs().unwrap_or_default();
        if categories.is_empty() {
            return IDLE;
        }
        let now = now_ms();
        let calm = db.jev_policy();
        let policy = if wake == Some(Wake::Now) { JevPolicy { calm_ms: 0, ..calm } } else { calm };
        let batch = pick(db, now, &policy, memory, BATCH);
        if batch.is_empty() {
            return match next_look(db, now, &calm, memory) {
                Some(at) => Duration::from_millis((at - now + 500).clamp(1000, IDLE.as_millis() as i64) as u64),
                None => IDLE,
            };
        }
        // La IA elegida y su clave se buscan recién acá: despertar al hilo sin nada para
        // consultar no toca el llavero del sistema. Sin clave (o, en Ollama, sin modelo)
        // se espera a que el usuario la ponga.
        let engine = provider::Engine::from_db(db);
        let Some(key) = provider::credential(&engine) else {
            return IDLE;
        };
        memory.engine = engine.tag();
        let done = round(db, now, &policy, &categories, memory, &batch, &mut |sheet| {
            provider::classify(&engine, &key, &sheet.title, &sheet.content, &categories)
        });
        let progressed = done.asked + done.reused > 0 || done.error.is_some();
        {
            let mut error = shared.jev_error.lock().unwrap_or_else(|e| e.into_inner());
            if done.error.is_some() {
                *error = done.error;
            } else if done.asked > 0 && memory.aside.is_empty() {
                // Mientras quede alguna hoja rechazada, su aviso sigue a la vista.
                *error = None;
            }
        }
        if progressed {
            let _ = app.emit(EVENT_CHANGED, ());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::db::{Incoming, VersionCfg};

    const MINUTE: i64 = 60_000;
    const DAY: i64 = 24 * 60 * MINUTE;
    const TRABAJO: i64 = 1;
    const CASA: i64 = 3;

    fn db() -> Db {
        Db::open(Path::new(":memory:")).expect("base en memoria")
    }

    /// Calma de cinco minutos, sin revisión periódica, confianza mínima de 0,6.
    fn policy() -> JevPolicy {
        JevPolicy { calm_ms: 5 * MINUTE, recheck_ms: 0, threshold: 0.6 }
    }

    /// Crea la hoja o le cambia el contenido, con `modified` como fecha del original.
    fn write(db: &Db, key: &str, content: &str, modified: i64) -> i64 {
        let incoming = Incoming {
            source: "file",
            source_key: key.into(),
            title: key.into(),
            path: Some(key.into()),
            content: content.into(),
            size: content.len() as i64,
            source_mtime: modified,
            created_at: modified,
            modified_at: modified,
        };
        db.upsert_sheet(&incoming, &VersionCfg { keep: 2, session_gap_ms: 5 * MINUTE }).unwrap();
        db.sheet_id("file", key).unwrap()
    }

    fn says(category: Option<i64>, confidence: f64) -> Result<Verdict, AiError> {
        Ok(Verdict { category_id: category, confidence, note_score: Some(0.9) })
    }

    /// Lo que haría el hilo en `now`: tandas hasta que no quede nada para consultar.
    /// `jev` hace de Jev; devuelve cuántas consultas se hicieron.
    fn run(
        db: &Db,
        now: i64,
        policy: &JevPolicy,
        memory: &mut Memory,
        jev: &mut dyn FnMut(&PendingSheet) -> Result<Verdict, AiError>,
    ) -> usize {
        let categories = db.category_defs().unwrap();
        let mut asked = 0;
        loop {
            let batch = pick(db, now, policy, memory, 2);
            if batch.is_empty() {
                return asked;
            }
            asked += round(db, now, policy, &categories, memory, &batch, jev).asked;
        }
    }

    /// Pasada sin errores en la que Jev siempre elige `category` con esa confianza.
    fn classify(db: &Db, now: i64, policy: &JevPolicy, category: Option<i64>, confidence: f64) -> usize {
        run(db, now, policy, &mut Memory::default(), &mut |_| says(category, confidence))
    }

    fn category_of(db: &Db, id: i64) -> (Option<i64>, Option<String>) {
        let sheet = db.get_sheet(id).unwrap().unwrap().summary;
        (sheet.category_id, sheet.category_source)
    }

    #[test]
    fn una_hoja_recien_editada_espera_y_recien_quieta_se_consulta() {
        let db = db();
        let now = now_ms();
        let id = write(&db, "a.txt", "reunión con el equipo de guardias el lunes", now);

        // Mientras se la escribe (guardados cada segundo) no sale ninguna consulta...
        assert_eq!(classify(&db, now, &policy(), Some(TRABAJO), 0.9), 0);
        assert_eq!(classify(&db, now + 4 * MINUTE, &policy(), Some(TRABAJO), 0.9), 0);
        // ...pero cuenta como pendiente, y se sabe cuándo va a estar lista.
        assert_eq!(db.pending_count(now, &policy()), 1);
        let ready = next_look(&db, now, &policy(), &Memory::default()).unwrap();
        assert!((now + 5 * MINUTE..now + 5 * MINUTE + 5000).contains(&ready));

        // Pasada la calma, una sola consulta.
        assert_eq!(classify(&db, now + 6 * MINUTE, &policy(), Some(TRABAJO), 0.9), 1);
        assert_eq!(category_of(&db, id), (Some(TRABAJO), Some("jev".into())));
        assert_eq!(db.pending_count(now + 6 * MINUTE, &policy()), 0);
        assert_eq!(next_look(&db, now + 6 * MINUTE, &policy(), &Memory::default()), None);
        assert_eq!(classify(&db, now + 7 * MINUTE, &policy(), Some(TRABAJO), 0.9), 0);
    }

    #[test]
    fn un_archivo_viejo_recien_encontrado_no_espera() {
        let db = db();
        let now = now_ms();
        // Lo trajo el escaneo recién, pero nadie lo toca desde hace un mes.
        write(&db, "viejo.txt", "apuntes del curso de primeros auxilios", now - 30 * DAY);
        assert_eq!(classify(&db, now, &policy(), Some(TRABAJO), 0.9), 1);
    }

    #[test]
    fn una_hoja_con_muy_poco_texto_no_gasta_una_consulta() {
        let db = db();
        let now = now_ms();
        write(&db, "corta.txt", "pan y   leche\n\n", now - DAY);
        assert_eq!(classify(&db, now, &policy(), Some(CASA), 0.9), 0);
        assert_eq!(db.pending_count(now, &policy()), 0);

        // Cuando junta texto suficiente (y se queda quieta), sí.
        write(&db, "corta.txt", "pan, leche, yerba, café y tomates para la semana", now - DAY);
        assert_eq!(db.pending_count(now, &policy()), 1);
        assert_eq!(classify(&db, now, &policy(), Some(CASA), 0.9), 1);
    }

    #[test]
    fn una_hoja_ya_evaluada_no_se_vuelve_a_consultar_aunque_cambie() {
        let db = db();
        let now = now_ms();
        let id = write(&db, "a.txt", "lista de arreglos pendientes de la casa", now - DAY);
        assert_eq!(classify(&db, now, &policy(), Some(CASA), 0.9), 1);

        write(&db, "a.txt", "lista de arreglos pendientes de la casa\n- la canilla", now - DAY);
        assert_eq!(db.pending_count(now + 30 * DAY, &policy()), 0);
        assert_eq!(classify(&db, now + 30 * DAY, &policy(), Some(TRABAJO), 0.9), 0);
        assert_eq!(category_of(&db, id).0, Some(CASA));
    }

    #[test]
    fn con_revision_periodica_se_consulta_solo_pasado_el_plazo() {
        let db = db();
        let now = now_ms();
        let weekly = JevPolicy { recheck_ms: 7 * DAY, ..policy() };
        let id = write(&db, "a.txt", "lista de arreglos pendientes de la casa", now - DAY);
        let same = write(&db, "b.txt", "esta otra hoja no cambia nunca más", now - DAY);
        assert_eq!(classify(&db, now, &weekly, Some(CASA), 0.9), 2);

        write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        // Antes del plazo no, aunque el texto sea otro.
        assert_eq!(classify(&db, now + 6 * DAY, &weekly, Some(TRABAJO), 0.9), 0);
        assert_eq!(db.pending_count(now + 6 * DAY, &weekly), 0);
        assert_eq!(next_look(&db, now + 6 * DAY, &weekly, &Memory::default()), Some(now + 7 * DAY));
        // Pasado el plazo, solo la que cambió.
        assert_eq!(db.pending_count(now + 8 * DAY, &weekly), 1);
        assert_eq!(classify(&db, now + 8 * DAY, &weekly, Some(TRABAJO), 0.9), 1);
        assert_eq!(category_of(&db, id).0, Some(TRABAJO));
        assert_eq!(category_of(&db, same).0, Some(CASA));
        // Y el plazo vuelve a contar desde esa consulta.
        write(&db, "a.txt", "minuta de la reunión del martes con sistemas", now - DAY);
        assert_eq!(classify(&db, now + 9 * DAY, &weekly, Some(TRABAJO), 0.9), 0);
    }

    #[test]
    fn la_revision_periodica_tambien_espera_a_que_la_hoja_este_quieta() {
        let db = db();
        let now = now_ms();
        let weekly = JevPolicy { recheck_ms: 7 * DAY, ..policy() };
        write(&db, "a.txt", "lista de arreglos pendientes de la casa", now - 20 * DAY);
        assert_eq!(classify(&db, now - 10 * DAY, &weekly, Some(CASA), 0.9), 1);

        // Venció el plazo, pero la están escribiendo ahora mismo.
        write(&db, "a.txt", "lista de arreglos pendientes de la casa y del auto", now);
        assert_eq!(classify(&db, now + MINUTE, &weekly, Some(CASA), 0.9), 0);
        assert_eq!(db.pending_count(now + MINUTE, &weekly), 1);
        assert_eq!(classify(&db, now + 6 * MINUTE, &weekly, Some(CASA), 0.9), 1);
    }

    #[test]
    fn el_color_de_una_categoria_no_reabre_nada() {
        let db = db();
        let now = now_ms();
        write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        write(&db, "b.txt", "frase suelta que no entra en ninguna categoría", now - DAY);
        let mut jev = |sheet: &PendingSheet| says((sheet.title == "a.txt").then_some(TRABAJO), 0.9);
        assert_eq!(run(&db, now, &policy(), &mut Memory::default(), &mut jev), 2);

        let (_, name, description) = db.category_defs().unwrap().into_iter().find(|c| c.0 == TRABAJO).unwrap();
        assert!(!db.update_category(TRABAJO, &name, &description, "#123456").unwrap());
        assert_eq!(db.pending_count(now, &policy()), 0);
        assert_eq!(classify(&db, now, &policy(), Some(TRABAJO), 0.9), 0);
    }

    #[test]
    fn una_categoria_nueva_o_redefinida_solo_reabre_las_hojas_sin_categoria() {
        let db = db();
        let now = now_ms();
        let placed = write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        let other = write(&db, "b.txt", "receta de la abuela para el budín de pan", now - DAY);
        let unsure = write(&db, "c.txt", "pasajes y alojamiento para enero en el sur", now - DAY);
        let mut jev = |sheet: &PendingSheet| match sheet.title.as_str() {
            "a.txt" => says(Some(TRABAJO), 0.9),
            "b.txt" => says(None, 0.8),
            _ => says(Some(CASA), 0.3),
        };
        assert_eq!(run(&db, now, &policy(), &mut Memory::default(), &mut jev), 3);
        assert_eq!(category_of(&db, placed).0, Some(TRABAJO));
        assert_eq!(category_of(&db, other), (None, None));
        assert_eq!(category_of(&db, unsure), (None, None));

        // Categoría nueva: vuelven la de "otro" y la que no llegó a la confianza mínima.
        let cooking = db.create_category("Cocina", "Recetas y comidas", "#FF9500").unwrap();
        assert_eq!(db.pending_count(now, &policy()), 2);
        let mut asked = Vec::new();
        let mut jev = |sheet: &PendingSheet| {
            asked.push(sheet.title.clone());
            says((sheet.title == "b.txt").then_some(cooking), 0.9)
        };
        assert_eq!(run(&db, now, &policy(), &mut Memory::default(), &mut jev), 2);
        asked.sort();
        assert_eq!(asked, ["b.txt", "c.txt"]);
        assert_eq!(category_of(&db, other).0, Some(cooking));
        assert_eq!(category_of(&db, placed).0, Some(TRABAJO));

        // Cambiar la descripción de una categoría: otra vez solo la que sigue sin categoría.
        assert!(db.update_category(CASA, "Casa", "Hogar, viajes y familia", "#34C759").unwrap());
        assert_eq!(db.pending_count(now, &policy()), 1);
        assert_eq!(classify(&db, now, &policy(), Some(CASA), 0.9), 1);
        assert_eq!(category_of(&db, unsure).0, Some(CASA));
    }

    #[test]
    fn borrar_una_categoria_deja_sus_hojas_sin_categoria_y_pendientes() {
        let db = db();
        let now = now_ms();
        let in_house = write(&db, "a.txt", "lista de arreglos pendientes de la casa", now - DAY);
        let at_work = write(&db, "b.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        let mut jev = |sheet: &PendingSheet| says(Some(if sheet.title == "a.txt" { CASA } else { TRABAJO }), 0.9);
        assert_eq!(run(&db, now, &policy(), &mut Memory::default(), &mut jev), 2);

        db.delete_category(CASA).unwrap();
        assert_eq!(category_of(&db, in_house), (None, None));
        assert_eq!(category_of(&db, at_work).0, Some(TRABAJO));
        assert_eq!(db.pending_count(now, &policy()), 1);
        assert_eq!(classify(&db, now, &policy(), None, 0.7), 1);
    }

    #[test]
    fn cambiar_la_confianza_minima_se_aplica_sin_consultar() {
        let db = db();
        let now = now_ms();
        let sure = write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        let doubtful = write(&db, "b.txt", "llamar al plomero por la canilla del baño", now - DAY);
        let by_hand = write(&db, "c.txt", "turno con el dentista el jueves a las nueve", now - DAY);
        db.set_sheet_category(by_hand, Some(TRABAJO)).unwrap();
        let mut jev = |sheet: &PendingSheet| match sheet.title.as_str() {
            "a.txt" => says(Some(TRABAJO), 0.9),
            _ => says(Some(CASA), 0.5),
        };
        assert_eq!(run(&db, now, &policy(), &mut Memory::default(), &mut jev), 2);
        // La elección de Jev quedó guardada aunque no llegó a 0,6.
        assert_eq!(category_of(&db, doubtful), (None, None));

        // Bajar el umbral la pone; subirlo saca a las dos. La manual no se toca.
        db.apply_threshold(0.4).unwrap();
        assert_eq!(category_of(&db, doubtful), (Some(CASA), Some("jev".into())));
        assert_eq!(category_of(&db, sure).0, Some(TRABAJO));
        db.apply_threshold(0.95).unwrap();
        assert_eq!(category_of(&db, doubtful), (None, None));
        assert_eq!(category_of(&db, sure), (None, None));
        assert_eq!(category_of(&db, by_hand), (Some(TRABAJO), Some("manual".into())));
        db.apply_threshold(0.6).unwrap();
        assert_eq!(category_of(&db, sure).0, Some(TRABAJO));

        // Nada de eso generó consultas ni dejó hojas pendientes.
        assert_eq!(db.pending_count(now, &policy()), 0);
        assert_eq!(db.jev_calls(now), (2, 2));
        assert_eq!(classify(&db, now, &policy(), Some(TRABAJO), 0.9), 0);
    }

    #[test]
    fn el_mismo_contenido_no_se_consulta_dos_veces() {
        let db = db();
        let now = now_ms();
        let text = "minuta de la reunión del lunes con sistemas";
        let first = write(&db, "a.txt", text, now - DAY);
        assert_eq!(classify(&db, now, &policy(), Some(TRABAJO), 0.9), 1);

        // Una copia del mismo texto usa el veredicto guardado.
        let copy = write(&db, "copia.txt", text, now - DAY);
        let categories = db.category_defs().unwrap();
        let mut memory = Memory::default();
        let batch = pick(&db, now, &policy(), &mut memory, 10);
        assert_eq!(batch, [copy]);
        let done = round(&db, now, &policy(), &categories, &mut memory, &batch, &mut |_| {
            panic!("no tenía que consultar")
        });
        assert_eq!((done.asked, done.reused), (0, 1));
        assert_eq!(category_of(&db, copy), (Some(TRABAJO), Some("jev".into())));

        // Si las categorías dicen otra cosa, el veredicto guardado ya no vale...
        assert_ne!(signature(&categories), signature(&db.category_defs().unwrap()[1..]));
        let mut renamed = categories.clone();
        renamed[0].2.push_str(" y guardias");
        assert_ne!(signature(&categories), signature(&renamed));
        // ...pero el orden en que se listan no cambia nada.
        let mut reversed = categories.clone();
        reversed.reverse();
        assert_eq!(signature(&categories), signature(&reversed));

        // "Volver a clasificar todo" sí consulta de nuevo, una vez por contenido distinto.
        db.reclassify_all().unwrap();
        assert_eq!(db.pending_count(now, &policy()), 2);
        assert_eq!(category_of(&db, first).0, Some(TRABAJO));
        assert_eq!(classify(&db, now, &policy(), Some(CASA), 0.9), 1);
        assert_eq!(category_of(&db, first).0, Some(CASA));
        assert_eq!(category_of(&db, copy).0, Some(CASA));
        assert_eq!(db.jev_calls(now), (2, 2));
    }

    #[test]
    fn secretas_papelera_y_manuales_nunca_se_envian() {
        let db = db();
        let now = now_ms();
        let secret = write(&db, "a.txt", "accesos al servidor de pruebas del hospital", now - DAY);
        let cred = format!("usuario demo del gestor\n{}: {}", "clave", "MiClave123!");
        let auto_secret = write(&db, "b.txt", &cred, now - DAY);
        let trashed = write(&db, "c.txt", "borrador viejo que ya no sirve para nada", now - DAY);
        let by_hand = write(&db, "d.txt", "turno con el dentista el jueves a las nueve", now - DAY);
        let cleared = write(&db, "e.txt", "sin categoría porque así lo quiso el usuario", now - DAY);
        db.set_sheet_secret(secret, true).unwrap();
        db.set_sheet_hidden(trashed, true).unwrap();
        db.set_sheet_category(by_hand, Some(CASA)).unwrap();
        db.set_sheet_category(cleared, None).unwrap();
        assert!(db.get_sheet(auto_secret).unwrap().unwrap().summary.secret);

        let weekly = JevPolicy { recheck_ms: 7 * DAY, ..policy() };
        let never = |db: &Db, at: i64| {
            assert_eq!(db.pending_count(at, &weekly), 0);
            assert_eq!(run(db, at, &weekly, &mut Memory::default(), &mut |sheet| panic!("se envió {}", sheet.title)), 0);
        };
        never(&db, now);
        // Ni con "volver a clasificar todo", ni al cambiar las categorías, ni al editarlas.
        db.reclassify_all().unwrap();
        db.create_category("Cocina", "Recetas y comidas", "#FF9500").unwrap();
        db.apply_threshold(0.1).unwrap();
        for key in ["a.txt", "c.txt", "d.txt", "e.txt"] {
            write(&db, key, "el texto cambió por completo desde la última vez", now - DAY);
        }
        never(&db, now + 30 * DAY);
        assert_eq!(category_of(&db, by_hand), (Some(CASA), Some("manual".into())));
        assert_eq!(category_of(&db, cleared), (None, Some("manual".into())));

        // Una categoría puesta a mano después de la consulta tampoco se pisa.
        let late = write(&db, "f.txt", "comprar el regalo de cumpleaños de Juli", now - DAY);
        let categories = db.category_defs().unwrap();
        let batch = pick(&db, now, &weekly, &mut Memory::default(), 10);
        assert_eq!(batch, [late]);
        round(&db, now, &weekly, &categories, &mut Memory::default(), &batch, &mut |sheet| {
            db.set_sheet_category(sheet.id, Some(CASA)).unwrap();
            says(Some(TRABAJO), 0.99)
        });
        assert_eq!(category_of(&db, late), (Some(CASA), Some("manual".into())));

        // Y una hoja que sale del secret-book o de la papelera recién ahí pasa por Jev
        // (acá las dos dicen lo mismo: con una consulta alcanza).
        db.set_sheet_secret(secret, false).unwrap();
        db.set_sheet_hidden(trashed, false).unwrap();
        assert_eq!(db.pending_count(now + 30 * DAY, &weekly), 2);
        assert_eq!(classify(&db, now + 30 * DAY, &weekly, Some(TRABAJO), 0.9), 1);
        assert_eq!(category_of(&db, secret).0, Some(TRABAJO));
        assert_eq!(category_of(&db, trashed).0, Some(TRABAJO));
    }

    #[test]
    fn lo_que_cambia_en_medio_de_una_tanda_no_se_envia() {
        let db = db();
        let now = now_ms();
        let first = write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        let secret = write(&db, "b.txt", "datos de la cuenta que mejor nadie vea", now - 2 * DAY);
        let trashed = write(&db, "c.txt", "borrador viejo que ya no sirve para nada", now - 3 * DAY);
        let by_hand = write(&db, "d.txt", "turno con el dentista el jueves a las nueve", now - 4 * DAY);
        let edited = write(&db, "e.txt", "lista de arreglos pendientes de la casa", now - 5 * DAY);
        let last = write(&db, "f.txt", "pasajes y alojamiento para enero en el sur", now - 6 * DAY);
        let categories = db.category_defs().unwrap();
        let mut memory = Memory::default();
        let batch = pick(&db, now, &policy(), &mut memory, 10);
        assert_eq!(batch, [first, secret, trashed, by_hand, edited, last]);

        let mut sent = Vec::new();
        round(&db, now, &policy(), &categories, &mut memory, &batch, &mut |sheet| {
            sent.push(sheet.id);
            if sheet.id == first {
                // Mientras Jev responde por la primera (puede tardar medio minuto), el
                // usuario esconde una hoja, tira otra, clasifica una a mano y edita otra.
                db.set_sheet_secret(secret, true).unwrap();
                db.set_sheet_hidden(trashed, true).unwrap();
                db.set_sheet_category(by_hand, Some(CASA)).unwrap();
                write(&db, "e.txt", "lista de arreglos de la casa, con una línea más", now);
            }
            says(Some(TRABAJO), 0.9)
        });
        assert_eq!(sent, [first, last]);
        assert_eq!(category_of(&db, by_hand), (Some(CASA), Some("manual".into())));

        // La que se estaba editando sigue pendiente y sale después, con el texto nuevo.
        assert_eq!(db.pending_count(now, &policy()), 1);
        let mut texts = Vec::new();
        let mut jev = |sheet: &PendingSheet| {
            texts.push((sheet.id, sheet.content.clone()));
            says(Some(CASA), 0.9)
        };
        assert_eq!(run(&db, now + 6 * MINUTE, &policy(), &mut memory, &mut jev), 1);
        assert_eq!(texts, [(edited, "lista de arreglos de la casa, con una línea más".to_string())]);
    }

    #[test]
    fn un_error_de_jev_no_borra_la_categoria_que_la_hoja_ya_tenia() {
        let db = db();
        let now = now_ms();
        let weekly = JevPolicy { recheck_ms: 7 * DAY, ..policy() };
        let kept = write(&db, "a.txt", "lista de arreglos pendientes de la casa", now - 30 * DAY);
        assert_eq!(classify(&db, now - 20 * DAY, &weekly, Some(CASA), 0.9), 1);

        // Cambió el texto y venció el plazo de revisión, pero el servicio está caído.
        write(&db, "a.txt", "lista de arreglos pendientes de la casa y del auto", now - DAY);
        let other = write(&db, "b.txt", "minuta de la reunión del lunes con sistemas", now - 2 * DAY);
        let mut down = |_: &PendingSheet| Err(AiError::Busy("Jev respondió HTTP 503.".into(), None));
        assert_eq!(run(&db, now, &weekly, &mut Memory::default(), &mut down), 1);
        assert_eq!(category_of(&db, kept), (Some(CASA), Some("jev".into())));
        assert_eq!(db.pending_count(now, &weekly), 2);

        // Vuelve el servicio, pero a esa hoja en particular la rechaza: conserva su
        // categoría y sigue pendiente, sin frenar a la otra.
        let mut memory = Memory::default();
        let mut jev = |sheet: &PendingSheet| {
            if sheet.id == kept {
                return Err(AiError::Other("Jev respondió HTTP 422.".into()));
            }
            says(Some(TRABAJO), 0.9)
        };
        assert_eq!(run(&db, now, &weekly, &mut memory, &mut jev), 2);
        assert_eq!(category_of(&db, other).0, Some(TRABAJO));
        assert_eq!(category_of(&db, kept), (Some(CASA), Some("jev".into())));
        assert_eq!(db.pending_count(now, &weekly), 1);

        // Al tercer rechazo, con las demás pasando bien, se deja de insistir: queda como
        // vista y con la categoría que tenía.
        assert_eq!(run(&db, now + 16 * MINUTE, &weekly, &mut memory, &mut jev), 1);
        assert_eq!(db.pending_count(now + 16 * MINUTE, &weekly), 1);
        let third = now + 80 * MINUTE;
        assert_eq!(run(&db, third, &weekly, &mut memory, &mut jev), 1);
        assert_eq!(category_of(&db, kept), (Some(CASA), Some("jev".into())));
        assert_eq!(db.pending_count(third, &weekly), 0);
        assert_eq!(run(&db, third + DAY, &weekly, &mut memory, &mut jev), 0);
    }

    #[test]
    fn el_aviso_de_una_hoja_rechazada_no_lleva_su_titulo() {
        // El aviso queda a la vista en Ajustes, y la hoja pudo pasar después al secret-book.
        let db = db();
        let now = now_ms();
        write(&db, "contraseña del banco.txt", "mi nota con bastante texto como para consultarla", now - DAY);
        let categories = db.category_defs().unwrap();
        let mut memory = Memory::default();
        let batch = pick(&db, now, &policy(), &mut memory, 2);
        let mut refused = |_: &PendingSheet| Err(AiError::Other("Jev respondió HTTP 422.".into()));
        let error = round(&db, now, &policy(), &categories, &mut memory, &batch, &mut refused).error.expect("un aviso");
        assert!(error.starts_with("No se pudo clasificar una hoja. Jev respondió HTTP 422."), "{error}");
        assert!(!error.contains("contraseña") && !error.contains(".txt"), "{error}");
    }

    #[test]
    fn con_jev_ocupado_o_sin_red_se_espera_cada_vez_mas() {
        let db = db();
        let now = now_ms();
        write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        write(&db, "b.txt", "lista de arreglos pendientes de la casa", now - DAY);
        let categories = db.category_defs().unwrap();
        let mut memory = Memory::default();
        let mut busy = |_: &PendingSheet| Err(AiError::Busy("Jev respondió HTTP 429.".into(), None));

        // Falla la primera: no se sigue con la segunda, y se espera un minuto.
        let batch = pick(&db, now, &policy(), &mut memory, 10);
        let done = round(&db, now, &policy(), &categories, &mut memory, &batch, &mut busy);
        assert_eq!(done.asked, 1);
        assert_eq!(done.error.as_deref(), Some("Jev respondió HTTP 429. Book vuelve a intentar en 1 minuto."));
        // Los avisos que lleguen mientras tanto (guardados, escaneos) no consultan.
        assert!(pick(&db, now + 30_000, &policy(), &mut memory, 10).is_empty());
        assert_eq!(next_look(&db, now + 30_000, &policy(), &memory), Some(now + MINUTE));
        assert_eq!(db.pending_count(now, &policy()), 2);

        // Segunda falla seguida: dos minutos. Sin red no cuenta como consulta hecha.
        let later = now + MINUTE;
        let batch = pick(&db, later, &policy(), &mut memory, 10);
        assert_eq!(batch.len(), 2);
        let done = round(&db, later, &policy(), &categories, &mut memory, &batch, &mut |_| {
            Err(AiError::Offline("No se pudo conectar con Jev.".into()))
        });
        assert_eq!(done.asked, 0);
        assert!(pick(&db, later + MINUTE, &policy(), &mut memory, 10).is_empty());
        assert_eq!(next_look(&db, later, &policy(), &memory), Some(later + 2 * MINUTE));

        // Si Jev dice cuánto esperar y es más, se le hace caso.
        let later = later + 2 * MINUTE;
        let batch = pick(&db, later, &policy(), &mut memory, 10);
        round(&db, later, &policy(), &categories, &mut memory, &batch, &mut |_| {
            Err(AiError::Busy("Jev respondió HTTP 429.".into(), Some(10 * MINUTE)))
        });
        assert_eq!(next_look(&db, later, &policy(), &memory), Some(later + 10 * MINUTE));

        // Cuando vuelve, se clasifica todo y la espera empieza otra vez de cero.
        let later = later + 10 * MINUTE;
        assert_eq!(run(&db, later, &policy(), &mut memory, &mut |_| says(Some(TRABAJO), 0.9)), 2);
        assert_eq!(db.pending_count(later, &policy()), 0);
        assert_eq!((memory.failures, memory.retry_at <= later), (0, true));
        assert_eq!(db.jev_calls(now).1, 4);
    }

    #[test]
    fn con_la_clave_rechazada_no_se_insiste() {
        let db = db();
        let now = now_ms();
        write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        write(&db, "b.txt", "lista de arreglos pendientes de la casa", now - DAY);
        let mut memory = Memory::default();
        let mut denied = |_: &PendingSheet| Err(AiError::Auth("Jev respondió HTTP 401.".into()));
        assert_eq!(run(&db, now, &policy(), &mut memory, &mut denied), 1);
        // Ni más tarde ni con más avisos: hasta que el usuario toque algo de Jev.
        assert_eq!(run(&db, now + DAY, &policy(), &mut memory, &mut denied), 0);
        assert_eq!(next_look(&db, now + DAY, &policy(), &memory), None);
        assert_eq!(db.pending_count(now, &policy()), 2);
    }

    #[test]
    fn una_hoja_que_jev_rechaza_no_traba_a_las_demas() {
        let db = db();
        let now = now_ms();
        let bad = write(&db, "rara.txt", "una hoja que por algún motivo Jev no acepta", now - DAY);
        let good = write(&db, "b.txt", "lista de arreglos pendientes de la casa", now - 2 * DAY);
        let mut memory = Memory::default();
        let mut tries = 0;
        let mut jev = |sheet: &PendingSheet| {
            if sheet.id == bad {
                tries += 1;
                return Err(AiError::Other("Jev respondió HTTP 422.".into()));
            }
            says(Some(CASA), 0.9)
        };
        assert_eq!(run(&db, now, &policy(), &mut memory, &mut jev), 2);
        assert_eq!(category_of(&db, good).0, Some(CASA));
        // La rechazada sigue pendiente (no queda marcada como vista) y se reintenta
        // más tarde, no con cada aviso.
        assert_eq!(db.pending_count(now, &policy()), 1);
        assert_eq!(run(&db, now + MINUTE, &policy(), &mut memory, &mut jev), 0);
        assert_eq!(next_look(&db, now + MINUTE, &policy(), &memory), Some(now + 15 * MINUTE));
        assert_eq!(run(&db, now + 16 * MINUTE, &policy(), &mut memory, &mut jev), 1);
        // Cada rechazo la aleja más: ahora una hora.
        assert_eq!(run(&db, now + 60 * MINUTE, &policy(), &mut memory, &mut jev), 0);
        // Si le cambian el texto, se la vuelve a probar sin esperar.
        write(&db, "rara.txt", "la misma hoja, ahora con un texto distinto", now - DAY);
        assert_eq!(run(&db, now + 17 * MINUTE, &policy(), &mut memory, &mut jev), 1);
        assert_eq!(tries, 3);
    }

    #[test]
    fn varios_rechazos_seguidos_frenan_las_consultas() {
        let db = db();
        let now = now_ms();
        for n in 0..6 {
            write(&db, &format!("{n}.txt"), &format!("hoja número {n} con texto de sobra para clasificar"), now - DAY);
        }
        let mut memory = Memory::default();
        let mut broken = |_: &PendingSheet| Err(AiError::Other("Jev respondió HTTP 400.".into()));
        // Tres rechazos al hilo: el problema no es de las hojas. Las otras tres ni se envían.
        assert_eq!(run(&db, now, &policy(), &mut memory, &mut broken), 3);
        assert_eq!(next_look(&db, now, &policy(), &memory), Some(now + MINUTE));
        assert_eq!(db.pending_count(now, &policy()), 6);
        // Después de la espera se prueba de a una por vez.
        assert_eq!(run(&db, now + MINUTE, &policy(), &mut memory, &mut broken), 1);
    }

    // ---- qué IA consulta: la política es la misma, el caché no se comparte ----

    use crate::provider::{Engine, Provider};

    fn tag(provider: Provider, model: &str) -> String {
        Engine { provider, model: model.into(), url: String::new() }.tag()
    }

    #[test]
    fn la_firma_de_jev_es_la_de_siempre_y_la_de_las_demas_cambia_con_la_ia_y_el_modelo() {
        let categories = db().category_defs().unwrap();
        // La de antes de que hubiera más IAs: versión y, por cada categoría, su id, nombre y descripción.
        let mut old = String::from("1");
        for (id, name, description) in &categories {
            old.push_str(&format!("\u{1e}{id}\u{1f}{name}\u{1f}{description}"));
        }
        assert_eq!(signature(&categories), hash(&old));
        assert_eq!(signature_with(&categories, &tag(Provider::Jev, "")), hash(&old));

        let claude = signature_with(&categories, &tag(Provider::Claude, "claude-haiku-5-5"));
        assert_ne!(claude, signature(&categories));
        assert_ne!(claude, signature_with(&categories, &tag(Provider::Claude, "claude-sonnet-5-5")));
        assert_ne!(claude, signature_with(&categories, &tag(Provider::OpenAi, "claude-haiku-5-5")));
        assert_ne!(
            signature_with(&categories, &tag(Provider::Ollama, "llama3.2")),
            signature_with(&categories, &tag(Provider::Ollama, "qwen3"))
        );
        // Y sigue sin importar el orden de las categorías.
        let mut reversed = categories.clone();
        reversed.reverse();
        assert_eq!(claude, signature_with(&reversed, &tag(Provider::Claude, "claude-haiku-5-5")));
    }

    #[test]
    fn un_veredicto_no_se_reutiliza_con_otra_ia_ni_con_otro_modelo() {
        let db = db();
        let now = now_ms();
        let text = "minuta de la reunión del lunes con sistemas";
        write(&db, "a.txt", text, now - DAY);
        let categories = db.category_defs().unwrap();
        let ask = |memory: &mut Memory, asked: &mut Vec<String>| {
            let batch = pick(&db, now, &policy(), memory, 10);
            round(&db, now, &policy(), &categories, memory, &batch, &mut |sheet| {
                asked.push(sheet.title.clone());
                says(Some(TRABAJO), 0.9)
            })
        };

        // Consulta a Claude con su modelo de fábrica.
        let mut memory = Memory { engine: tag(Provider::Claude, "claude-haiku-5-5"), ..Memory::default() };
        let mut asked = Vec::new();
        assert_eq!(ask(&mut memory, &mut asked).asked, 1);

        // Una copia del mismo texto, con la misma IA y el mismo modelo, usa el veredicto guardado...
        write(&db, "copia.txt", text, now - DAY);
        assert_eq!(ask(&mut memory, &mut asked).reused, 1);
        assert_eq!(asked, ["a.txt"]);

        // ...pero con otro modelo, o con otra IA, se vuelve a preguntar.
        write(&db, "copia2.txt", text, now - DAY);
        let mut other_model = Memory { engine: tag(Provider::Claude, "claude-sonnet-5-5"), ..Memory::default() };
        let done = ask(&mut other_model, &mut asked);
        assert_eq!((done.asked, done.reused), (1, 0));
        write(&db, "copia3.txt", text, now - DAY);
        let mut other_ai = Memory { engine: tag(Provider::OpenAi, "gpt-6-luna"), ..Memory::default() };
        assert_eq!(ask(&mut other_ai, &mut asked).asked, 1);
        assert_eq!(asked, ["a.txt", "copia2.txt", "copia3.txt"]);
    }

    #[test]
    fn cambiar_de_ia_no_vuelve_a_clasificar_lo_ya_clasificado() {
        let db = db();
        let now = now_ms();
        let id = write(&db, "a.txt", "lista de arreglos pendientes de la casa", now - DAY);
        let other = write(&db, "b.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        let mut claude = Memory { engine: tag(Provider::Claude, "claude-haiku-5-5"), ..Memory::default() };
        assert_eq!(run(&db, now, &policy(), &mut claude, &mut |_| says(Some(CASA), 0.9)), 2);
        assert_eq!(db.pending_count(now, &policy()), 0);

        // Pasar a otra IA (aunque haya ediciones y pase el tiempo) no deja nada pendiente:
        // para volver a consultar por lo ya clasificado está «Volver a clasificar todo».
        crate::provider::set_active(&db, Provider::Gemini).unwrap();
        write(&db, "a.txt", "lista de arreglos pendientes de la casa y del auto", now - DAY);
        assert_eq!(db.pending_count(now + 30 * DAY, &policy()), 0);
        let mut gemini = Memory { engine: tag(Provider::Gemini, "gemini-3.5-flash-lite"), ..Memory::default() };
        assert_eq!(run(&db, now + 30 * DAY, &policy(), &mut gemini, &mut |_| panic!("no tenía que consultar")), 0);
        assert_eq!(category_of(&db, id).0, Some(CASA));
        assert_eq!(category_of(&db, other).0, Some(CASA));

        // «Volver a clasificar todo» sí, y con la IA de ahora.
        db.reclassify_all().unwrap();
        assert_eq!(db.pending_count(now, &policy()), 2);
        assert_eq!(run(&db, now, &policy(), &mut gemini, &mut |_| says(Some(TRABAJO), 0.9)), 2);
        assert_eq!(category_of(&db, id).0, Some(TRABAJO));
    }

    #[test]
    fn una_configuracion_rechazada_frena_a_cualquier_ia_y_dice_que_cambiar() {
        let db = db();
        let now = now_ms();
        write(&db, "a.txt", "minuta de la reunión del lunes con sistemas", now - DAY);
        let categories = db.category_defs().unwrap();
        let mut memory = Memory { engine: tag(Provider::Ollama, "llama9"), ..Memory::default() };
        let batch = pick(&db, now, &policy(), &mut memory, 10);
        let mut missing = |_: &PendingSheet| Err(AiError::Auth("Ollama respondió HTTP 404. model not found.".into()));
        let error = round(&db, now, &policy(), &categories, &mut memory, &batch, &mut missing).error.expect("un aviso");
        assert!(error.starts_with("Ollama respondió HTTP 404."), "{error}");
        assert!(error.ends_with("hasta que cambies la clave o el modelo, o toques «Clasificar ahora»."), "{error}");
        assert!(pick(&db, now + DAY, &policy(), &mut memory, 10).is_empty());
    }
}
