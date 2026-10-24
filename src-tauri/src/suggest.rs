//! Proponer categorías de base a partir de lo que dicen las notas, para no arrancar de cero.
//!
//! Todo pasa en esta PC: no hay red ni modelos, solo contar palabras. El método:
//!
//! 1. De cada hoja (el título y el comienzo del contenido) se sacan las palabras que dicen
//!    algo. Se comparan en minúsculas y sin tildes (se muestra la forma con tildes más
//!    usada) y se descartan las palabras vacías del español y del inglés, los números, los
//!    enlaces, las rutas, los hexadecimales y todo lo de menos de tres letras.
//! 2. Sirven las palabras que aparecen en al menos dos hojas y en no más del 40 % de ellas:
//!    las que están en todas partes no distinguen nada. De las que quedan se toman las 300
//!    que más pesan (hojas × ln(total / hojas)).
//! 3. Para cada una se arma el conjunto de hojas donde aparece. Dos palabras que aparecen en
//!    las mismas hojas hablan de lo mismo: se agrupan por fusión aglomerativa (asociación
//!    entre esos conjuntos, promediada entre grupos) hasta que lo que queda ya no se parece
//!    lo bastante. La asociación es la correlación phi y no la similitud de Jaccard: esta
//!    última toma por parientes a dos palabras comunes que no tienen nada que ver, solo
//!    porque coinciden en muchas hojas por casualidad.
//! 4. Cada grupo de al menos dos palabras es un tema. Sus palabras clave son las que más
//!    pesan; sus hojas, las que tienen al menos dos de sus palabras; y se llama como la
//!    palabra principal. Se descartan los temas que coinciden con una categoría que ya
//!    existe o que se parecen demasiado a otro, y quedan los ocho con más hojas.
//!
//! Es determinista: el mismo cuaderno da siempre las mismas sugerencias.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use crate::db::Db;
use crate::model::CategorySuggestion;

/// Cuánto de cada hoja se lee, en caracteres del contenido: alcanza para saber de qué trata.
pub const CONTENT_CHARS: usize = 4000;
const TITLE_CHARS: usize = 300;
/// Con menos hojas que estas (con texto) no hay de dónde sacar temas.
const MIN_SHEETS: usize = 6;
const MAX_SUGGESTIONS: usize = 8;
/// Una palabra que está en más de esta parte de las hojas no distingue a ningún grupo.
const MAX_SHARE: f64 = 0.4;
/// Cuántas palabras entran al agrupamiento.
const CANDIDATES: usize = 300;
/// Asociación promedio mínima (correlación phi) para fusionar dos grupos de palabras.
const MERGE_AT: f32 = 0.25;
/// Cuántas palabras de un tema se miran para decidir qué hojas son suyas.
const THEME_WORDS: usize = 12;
const KEYWORDS: usize = 6;
const SAMPLES: usize = 3;
/// Dos temas cuyas hojas coinciden en más de esta parte (o un tema cuyas hojas están, en sus
/// dos tercios o más, dentro de las de otro) son, para el usuario, el mismo.
const SAME_THEME: f32 = 0.5;
/// Un tema que abarca más que esto del cuaderno no separa nada.
const MAX_THEME_SHARE: f64 = 0.6;
/// Más largo que esto no es una palabra (es un código, una cadena en base64…).
const MAX_LETTERS: usize = 24;

/// Palabras vacías: artículos, preposiciones, pronombres, verbos comodín, días y meses,
/// saludos, palabras de registro/estructura y sus equivalentes en inglés. Se compara sin tildes ni mayúsculas.
const STOP_WORDS: &str = "
a al algo alguien alguna algunas alguno algunos algun alla alli ahi aca aqui ante antes
aquel aquella aquellas aquello aquellos asi aun aunque bajo bastante bien cabe cada casi
cierta cierto como con contra cual cuales cualquier cualquiera cuando cuanto cuanta cuantos
cuantas cuyo cuya de del demas demasiado desde despues donde durante e el ella ellas ello ellos
en entonces entre era eran eres es esa esas ese eso esos esta estaba estaban estado estamos
estan estar estas este esto estos estoy fue fueron fui gran grande ha habia habian haber
hacia han has hasta hay igual incluso la las le les lo los luego mas medio menos mientras
mismo misma mismos mismas mucho mucha muchos muchas muy nada nadie ni ningun ninguna ninguno
no nos nosotros nosotras nuestro nuestra nuestros nuestras nunca o os otra otras otro otros
para pero poco poca pocos pocas por porque pues que quien quienes quiza quizas se segun ser
si sido siempre sin sino so sobre sola solo son soy su sus tal tambien tampoco tan tanto
tanta tantos tantas te tras tu tus u un una unas uno unos usted ustedes va vamos van vas
varias varios vez veces vos voy y ya yo
hacer hace haces hacen hacemos hago hizo hice hecho haciendo
tener tengo tienes tiene tenemos tienen tenia tenian tuvo tenido
poder puedo puedes puede podemos pueden podria podrian pudo
ir iba ido vaya dar da doy dan dio dado decir dice dicen digo dijo dicho
querer quiero quieres quiere queremos quieren quiso saber sabe sabes sabemos saben
ver ve veo vemos ven visto poner pone pongo ponen puso puesto llevar lleva llevo llevan
venir viene vengo vienen vino pasar pasa pasan paso quedar queda quedan deber debe debo deben
seguir sigue siguen parecer parece necesito necesita necesitamos necesitar
cosa cosas parte partes forma manera tipo tipos caso casos lugar momento punto puntos lado
nuevo nueva nuevos nuevas buen buena bueno buenos buenas mal mejor peor primer primera
primero segundo segunda ultimo ultima ultimos ultimas propio propia ambos ambas
hoy ayer mañana ahora hora horas dia dias semana semanas mes meses año años tarde noche
temprano minuto minutos
lunes martes miercoles jueves viernes sabado domingo
enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre
uno dos tres cuatro cinco seis siete ocho nueve diez cien mil
nota notas texto archivo archivos txt md json csv xml ini cfg log logs http https www com html htm
hola chau buenas gracias porfa favor ok dale listo pendiente pendientes
inicio fin empezar comienza comenzar terminar terminado falta faltan
funciona funcionar usando usar uso usado
encontrado encontrados encontrada encontradas buscando buscado
cambia cambiar cambiado cambiaos libre libres
about above after again against all also and any are because been before being below between
both but can could did does doing down during each few for from further get got had has have
having her here hers him his how into its itself just let like make made may more most much
many much new nor not now off once only other our ours out over own same she should some such
than that the their theirs them then there these they this those through too under until
use used very was were what when where which while who whom why will with would you your
yours one two three way say see want take going done still thing things something anything
everything nothing well back even yes okay don isn doesn didn won wasn aren couldn wouldn
shouldn hasn haven weren hello hey thanks thank please good bad start end first last
monday tuesday wednesday thursday friday saturday sunday january february april june july
august september october november december
todo todos toda todas history found find
";

/// Palabras que pueden servir como palabra clave secundaria dentro de un tema, pero que por sí
/// solas son demasiado genéricas, verbales, técnicas de interfaz o de rutas para dar nombre a una
/// categoría (por ejemplo «Tiempo», «Acceso», «Configurar», «Datos», «Desktop», «Size», «Cálculo»).
const NON_NAME_WORDS: &str = "
tiempo tiempos acceso accesos configurar configuracion datos dato
final finales terminar terminado empezar comenzar
lista listas guia guias resumen paso pasos ejemplo ejemplos prueba pruebas
cambio cambios version versiones carpeta carpetas nombre nombres
sistema sistemas programa programas ventana ventanas
windows linux mac android ios desktop documents downloads appdata local roaming users user
usar usado crear creado copiar copiado borrar borrado abrir abierto cerrar cerrado
agregar agregado quitar quitado mostrar mostrado buscar buscado
revisar revisado armar armado mandar mandado enviar enviado
preparar preparado confirmar confirmado hablar hablado
dejar dejado tomar tomado sacar sacado pedir pedido
preguntar preguntado llamar llamado mirar mirado
calculo calculos calcular energia limpieza orden accion acciones actividad actividades
pregunta preguntas respuesta respuestas
size layout card style guide width height color font margin padding border display flex grid
button input modal view page sheet book item items row rows group groups
ayuda help copy create delete update check test log logs
";

/// Las palabras vacías ya sin tildes, para consultarlas de a una.
fn stop_words() -> &'static HashSet<String> {
    static STOP: OnceLock<HashSet<String>> = OnceLock::new();
    STOP.get_or_init(|| STOP_WORDS.split_whitespace().map(fold).collect())
}

fn non_name_words() -> &'static HashSet<String> {
    static NON_NAME: OnceLock<HashSet<String>> = OnceLock::new();
    NON_NAME.get_or_init(|| NON_NAME_WORDS.split_whitespace().map(fold).collect())
}

/// Catálogo de temas cotidianos y técnicos (al estilo del clasificador / proveedores de IA):
/// cuando las palabras clave de un grupo coinciden claramente con uno de estos ámbitos,
/// le da un sustantivo limpio y natural como nombre de categoría en vez de usar una palabra
/// suelta al azar («Electrónica» en vez de «Windows», «Música» en vez de «Bad»).
const TOPICS: &[(&str, &[&str])] = &[
    ("Electrónica", &[
        "raspberry", "arduino", "esp", "gpio", "sensor", "antena", "transmisor", "frecuencia",
        "mhz", "ghz", "radio", "voltaje", "amper", "soldar", "placa", "circuito", "rele",
        "microcontrolador", "firmware", "led", "bateria", "transformador",
    ]),
    ("Servidores y redes", &[
        "servidor", "server", "ssh", "puerto", "firewall", "proxy", "nginx", "docker",
        "dominio", "dns", "subred", "router", "vpn", "ip", "red", "redes", "host", "hosting",
        "certificado", "ssl", "deploy", "despliegue", "remoto", "terminal", "consola",
    ]),
    ("Programación", &[
        "codigo", "funcion", "variable", "compilar", "repositorio", "commit", "branch",
        "rama", "rust", "python", "javascript", "typescript", "react", "tauri", "sql",
        "sqlite", "api", "backend", "frontend", "bug", "debug", "algoritmo", "libreria",
        "framework", "componente", "interfaz", "endpoint", "json", "base",
    ]),
    ("Diseño e interfaz", &[
        "diseño", "interfaz", "tipografia", "paleta", "icono", "iconos", "figma", "maqueta",
        "layout", "style", "estilo", "estilos", "css", "boton", "botones", "tarjeta",
        "tarjetas", "pantalla", "pantallas", "animacion", "contraste", "color", "colores",
    ]),
    ("Mantenimiento y PC", &[
        "disco", "memoria", "ram", "procesador", "cpu", "gpu", "driver", "drivers",
        "formatear", "respaldo", "backup", "instalador", "instalar", "registro", "temp",
        "cache", "limpieza", "rendimiento", "proceso", "procesos", "servicio", "servicios",
    ]),
    ("Música", &[
        "cancion", "canciones", "album", "banda", "guitarra", "piano", "acordes", "letra",
        "playlist", "spotify", "musica", "tema", "temas", "ritmo", "melodia", "bajo",
        "bateria", "concierto", "recital", "audio", "sonido", "mezcla", "track", "feat",
        "bunny", "rock", "pop", "jazz", "trap",
    ]),
    ("Vivienda", &[
        "departamento", "depto", "alquiler", "expensas", "mudanza", "inmobiliaria", "contrato",
        "propietario", "inquilino", "garantia", "ambientes", "balcon", "edificio", "consorcio",
        "hipoteca", "llaves", "pintura", "arreglos", "plomero", "electricista", "gasista",
    ]),
    ("Juegos", &[
        "juego", "juegos", "partida", "nivel", "personaje", "servidor", "steam", "consola",
        "mision", "mapa", "arma", "inventario", "jugador", "jugadores", "clan", "mod",
        "mods", "fps", "rpg", "boss", "quest", "minecraft", "valorant", "counter",
    ]),
    ("Finanzas", &[
        "banco", "cuenta", "transferencia", "factura", "impuesto", "impuestos", "sueldo",
        "ahorro", "inversion", "dolar", "dolares", "pesos", "cuota", "cuotas", "tarjeta",
        "credito", "debito", "prestamo", "alquiler", "gasto", "gastos", "pago", "pagos",
    ]),
    ("Salud", &[
        "medico", "doctora", "doctor", "turno", "clinica", "hospital", "receta", "analisis",
        "sangre", "odontologo", "dentista", "obra", "farmacia", "pastilla", "tratamiento",
        "sintomas", "kinesiologia", "lentes", "oculista", "vacuna",
    ]),
    ("Viajes", &[
        "viaje", "vuelo", "avion", "hotel", "reserva", "pasaje", "pasajes", "valija",
        "equipaje", "aeropuerto", "excursion", "playa", "montaña", "ruta", "itinerario",
        "hospedaje", "hostel", "estadia", "pasaporte", "visa",
    ]),
    ("Películas y series", &[
        "pelicula", "peliculas", "serie", "series", "temporada", "capitulo", "episodio",
        "director", "actor", "cine", "netflix", "documental", "trama", "escena", "estreno",
    ]),
    ("Libros y lectura", &[
        "libro", "libros", "novela", "autor", "capitulo", "lectura", "editorial", "cuento",
        "ensayo", "poesia", "paginas", "biblioteca", "resumen",
    ]),
    ("Vehículos", &[
        "auto", "moto", "camioneta", "motor", "frenos", "embrague", "neumaticos", "ruedas",
        "aceite", "filtro", "bateria", "taller", "mecanico", "patente", "seguro", "vtv",
        "nafta", "combustible", "cadena", "casco", "escape",
    ]),
    ("Jardín", &[
        "plantas", "maceta", "macetas", "regar", "podar", "abono", "tierra", "semillas",
        "cesped", "jardin", "rosal", "flores", "huerta", "arbol", "hojas",
    ]),
    ("Deportes", &[
        "entrenamiento", "gimnasio", "rutina", "ejercicio", "correr", "futbol", "partido",
        "cancha", "pesas", "series", "repeticiones", "bicicleta", "natacion", "torneo",
    ]),
    ("Trámites", &[
        "tramite", "formulario", "documento", "dni", "turno", "certificado", "constancia",
        "afip", "anses", "registro", "municipalidad", "firma", "legalizar", "expediente",
    ]),
];

/// Sin tildes ni diéresis, en minúscula. La eñe se conserva: no es una tilde, es otra letra
/// («año» y «ano» no son la misma palabra).
fn fold_char(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

fn fold(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).map(fold_char).collect()
}

/// Una palabra tal como aparece en las notas, ya sin mayúsculas, y sin tildes también.
/// Devuelve `false` si no es una palabra que valga la pena contar.
fn normalise(run: &str, lower: &mut String, folded: &mut String) -> bool {
    let run = run.trim_matches(|c| c == '\'' || c == '’');
    lower.clear();
    folded.clear();
    let mut letters = 0;
    for c in run.chars() {
        // Un número, un código con dígitos (v2, abc123, 0x1f) o un apóstrofo en el medio
        // (don't, d'Artagnan): no es una palabra.
        if !c.is_alphabetic() {
            return false;
        }
        letters += 1;
        if letters > MAX_LETTERS {
            return false;
        }
        for lowered in c.to_lowercase() {
            lower.push(lowered);
            folded.push(fold_char(lowered));
        }
    }
    if letters < 3 {
        return false;
    }
    // «aaaa», «jjj»: letras repetidas.
    let first = folded.chars().next();
    if folded.chars().all(|c| Some(c) == first) {
        return false;
    }
    // Un hash sin dígitos (deadbeef) es todo de la «a» a la «f».
    if letters >= 8 && folded.chars().all(|c| matches!(c, 'a'..='f')) {
        return false;
    }
    true
}

/// ¿Es un enlace, un correo o una ruta? Sus pedazos no son palabras de la nota.
fn is_link_or_path(chunk: &str) -> bool {
    chunk.contains("://")
        || chunk.contains("www.")
        || chunk.contains('@')
        || chunk.contains('\\')
        || chunk.matches('/').count() >= 2
        || (chunk.len() > 1 && (chunk.starts_with('/') || chunk.starts_with("~/")))
}

/// Recorre las palabras de `text` (hasta `limit` caracteres), saltando enlaces y rutas.
fn each_word(text: &str, limit: usize, f: &mut impl FnMut(&str)) {
    let end = text.char_indices().nth(limit).map_or(text.len(), |(at, _)| at);
    for chunk in text[..end].split_whitespace() {
        if is_link_or_path(chunk) {
            continue;
        }
        let mut start = None;
        for (at, c) in chunk.char_indices() {
            let inside = c.is_alphanumeric() || c == '\'' || c == '’';
            match (inside, start) {
                (true, None) => start = Some(at),
                (false, Some(from)) => {
                    f(&chunk[from..at]);
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            f(&chunk[from..]);
        }
    }
}

/// Una palabra del cuaderno, con todo lo necesario para mostrarla y pesarla.
struct Term {
    /// Sin tildes ni mayúsculas: con esto se compara.
    folded: String,
    /// Veces que apareció sin tildes (o sin que le correspondan).
    plain: u32,
    /// Veces que apareció con tildes, por cada forma.
    accented: Vec<(String, u32)>,
    /// En cuántas hojas aparece.
    sheets: u32,
}

impl Term {
    fn new(folded: &str) -> Self {
        Self { folded: folded.to_string(), plain: 0, accented: Vec::new(), sheets: 0 }
    }

    fn seen(&mut self, lower: &str) {
        if lower == self.folded {
            self.plain += 1;
        } else if let Some(form) = self.accented.iter_mut().find(|(form, _)| form == lower) {
            form.1 += 1;
        } else {
            self.accented.push((lower.to_string(), 1));
        }
    }

    /// Cómo se muestra: la forma con tildes más usada (si alguna vez se la escribió bien,
    /// aunque casi siempre falten las tildes) y, si no, tal cual.
    fn shown(&self) -> &str {
        self.accented
            .iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
            .map_or(self.folded.as_str(), |(form, _)| form.as_str())
    }

    /// Cuánto pesa para distinguir un grupo: en muchas hojas, pero no en todas.
    fn weight(&self, total: usize) -> f64 {
        let sheets = f64::from(self.sheets);
        sheets * (total as f64 / sheets).ln()
    }
}

/// Una hoja ya leída: sus palabras (sin repetir) y de cuál de las notas viene.
struct Sheet {
    note: usize,
    terms: Vec<u32>,
}

struct Corpus {
    terms: Vec<Term>,
    sheets: Vec<Sheet>,
}

impl Corpus {
    fn read(notes: &[(String, String)]) -> Self {
        let stop = stop_words();
        let mut ids: HashMap<String, u32> = HashMap::new();
        let mut terms: Vec<Term> = Vec::new();
        let mut sheets = Vec::new();
        let (mut lower, mut folded) = (String::new(), String::new());
        for (note, (title, content)) in notes.iter().enumerate() {
            let mut found: Vec<u32> = Vec::new();
            {
                let mut take = |run: &str| {
                    if !normalise(run, &mut lower, &mut folded) || stop.contains(folded.as_str()) {
                        return;
                    }
                    let id = match ids.get(folded.as_str()) {
                        Some(&id) => id,
                        None => {
                            let id = terms.len() as u32;
                            ids.insert(folded.clone(), id);
                            terms.push(Term::new(&folded));
                            id
                        }
                    };
                    terms[id as usize].seen(&lower);
                    found.push(id);
                };
                each_word(title, TITLE_CHARS, &mut take);
                each_word(content, CONTENT_CHARS, &mut take);
            }
            found.sort_unstable();
            found.dedup();
            // Una hoja con dos palabras no puede ser de ningún tema.
            if found.len() >= 3 {
                sheets.push(Sheet { note, terms: found });
            }
        }
        for sheet in &sheets {
            for &id in &sheet.terms {
                terms[id as usize].sheets += 1;
            }
        }
        Self { terms, sheets }
    }
}

/// Las hojas donde aparece una palabra, como un conjunto de bits (una posición por hoja).
struct Word {
    term: usize,
    weight: f64,
    /// En cuántas hojas aparece.
    sheets: u32,
    bits: Vec<u64>,
}

/// Cuánto se parecen dos palabras por las hojas donde aparecen, descontando lo que se
/// cruzarían por casualidad: la correlación entre «aparece» y «no aparece» (coeficiente
/// phi) sobre el total de hojas. Vale 1 si siempre van juntas y 0 si no tienen relación; es
/// negativa si se evitan. Con la similitud de Jaccard, dos palabras comunes que no tienen
/// nada que ver parecen parientes solo porque están en muchas hojas.
fn association(a: &Word, b: &Word, total: usize) -> f32 {
    let both: u32 = a.bits.iter().zip(&b.bits).map(|(x, y)| (x & y).count_ones()).sum();
    let (in_a, in_b, all) = (f64::from(a.sheets), f64::from(b.sheets), total as f64);
    let spread = (in_a * in_b * (all - in_a) * (all - in_b)).sqrt();
    if spread == 0.0 {
        0.0
    } else {
        ((all * f64::from(both) - in_a * in_b) / spread) as f32
    }
}

/// Fusión aglomerativa de palabras con enlace promedio: de a dos, siempre las más parecidas,
/// hasta que ninguna pareja alcance `MERGE_AT`. Devuelve los grupos, como índices de `words`.
fn cluster(words: &[Word], total: usize) -> Vec<Vec<usize>> {
    let k = words.len();
    let mut similarity = vec![0f32; k * k];
    for i in 0..k {
        for j in (i + 1)..k {
            let s = association(&words[i], &words[j], total);
            similarity[i * k + j] = s;
            similarity[j * k + i] = s;
        }
    }
    let mut groups: Vec<Vec<usize>> = (0..k).map(|i| vec![i]).collect();
    let mut alive = vec![true; k];
    loop {
        let mut best: Option<(f32, usize, usize)> = None;
        for i in (0..k).filter(|&i| alive[i]) {
            for j in ((i + 1)..k).filter(|&j| alive[j]) {
                let s = similarity[i * k + j];
                if s >= MERGE_AT && best.map_or(true, |(top, _, _)| s > top) {
                    best = Some((s, i, j));
                }
            }
        }
        let Some((_, i, j)) = best else { break };
        let (size_i, size_j) = (groups[i].len() as f32, groups[j].len() as f32);
        for other in (0..k).filter(|&o| alive[o] && o != i && o != j) {
            let merged = (size_i * similarity[i * k + other] + size_j * similarity[j * k + other]) / (size_i + size_j);
            similarity[i * k + other] = merged;
            similarity[other * k + i] = merged;
        }
        let moved = std::mem::take(&mut groups[j]);
        groups[i].extend(moved);
        alive[j] = false;
    }
    groups.into_iter().filter(|group| !group.is_empty()).collect()
}

/// Formas con las que una palabra puede coincidir con otra: ella misma y sin su plural
/// («compras» y «compra», «papeles» y «papel»).
fn forms(word: &str) -> Vec<String> {
    let mut forms = vec![word.to_string()];
    for suffix in ["s", "es"] {
        if let Some(stem) = word.strip_suffix(suffix).filter(|stem| stem.chars().count() >= 3) {
            forms.push(stem.to_string());
        }
    }
    forms
}

/// ¿Son la misma palabra, salvo el plural o la terminación? Además de «compras» y «compra»,
/// «comprar» y «compras» o «reunión» y «reuniones»: comparten casi todo el comienzo.
fn same_word(a: &str, b: &str) -> bool {
    let other = forms(b);
    if forms(a).iter().any(|form| other.contains(form)) {
        return true;
    }
    let shared = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let shortest = a.chars().count().min(b.chars().count());
    shared >= 5 && shared * 5 >= shortest * 4
}

/// Las palabras que cuentan de los nombres de las categorías que ya existen: el nombre
/// entero y cada una de sus palabras («Casa y familia» → «casa y familia», «casa», «familia»).
fn taken_words(existing: &[String]) -> Vec<String> {
    let mut taken = Vec::new();
    for name in existing {
        let folded = fold(name.trim());
        taken.extend(folded.split_whitespace().filter(|word| word.chars().count() >= 3).map(str::to_string));
        taken.push(folded);
    }
    taken
}

fn capitalised(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

/// Si las palabras clave de un tema pertenecen claramente a un ámbito de `TOPICS` (al menos
/// dos palabras del grupo coinciden con su vocabulario), devuelve el nombre de ese ámbito.
fn topic_label(keywords: &[usize], words: &[Word], terms: &[Term]) -> Option<&'static str> {
    let mut best: Option<(&'static str, usize)> = None;
    for &(label, vocab) in TOPICS {
        let matched = keywords
            .iter()
            .filter(|&&k| {
                let folded = &terms[words[k].term].folded;
                vocab.iter().any(|&v| same_word(folded, v))
            })
            .count();
        if matched >= 2 && best.map_or(true, |(_, top)| matched > top) {
            best = Some((label, matched));
        }
    }
    best.map(|(label, _)| label)
}

/// Un grupo de palabras que van juntas, con las hojas que hablan de eso.
struct Theme {
    /// Hojas con al menos dos de las palabras, y cuántas tienen de ellas.
    sheets: Vec<(usize, u8)>,
    /// Índices de `words`, de la más representativa a la menos.
    keywords: Vec<usize>,
    /// Nombre paraguas del catálogo de temas, cuando la primera palabra clave era genérica.
    umbrella: Option<&'static str>,
    /// Coincide con una categoría que ya existe.
    taken: bool,
}

impl Theme {
    fn name<'a>(&self, words: &[Word], terms: &'a [Term]) -> &'a Term {
        &terms[words[self.keywords[0]].term]
    }

    fn display_name(&self, words: &[Word], terms: &[Term]) -> String {
        if let Some(label) = self.umbrella {
            label.to_string()
        } else {
            capitalised(self.name(words, terms).shown())
        }
    }
}

/// Propone categorías a partir de `notes` (título y contenido de cada hoja visible).
/// `existing` son los nombres de las categorías que ya hay: no se vuelven a proponer.
pub fn suggest(notes: &[(String, String)], existing: &[String]) -> Vec<CategorySuggestion> {
    let Corpus { terms, sheets } = Corpus::read(notes);
    let total = sheets.len();
    if total < MIN_SHEETS {
        return Vec::new();
    }
    let at_most = ((total as f64 * MAX_SHARE).floor() as u32).max(2);

    // Las palabras candidatas, de más a menos peso (y por orden alfabético si empatan).
    let mut ranked: Vec<usize> = (0..terms.len()).filter(|&t| (2..=at_most).contains(&terms[t].sheets)).collect();
    let weight = |t: usize| terms[t].weight(total);
    ranked.sort_by(|&a, &b| weight(b).total_cmp(&weight(a)).then_with(|| terms[a].folded.cmp(&terms[b].folded)));
    ranked.truncate(CANDIDATES);
    if ranked.len() < 2 {
        return Vec::new();
    }

    let place: HashMap<u32, usize> = ranked.iter().enumerate().map(|(at, &t)| (t as u32, at)).collect();
    let row = total.div_ceil(64);
    let mut words: Vec<Word> =
        ranked.iter().map(|&t| Word { term: t, weight: weight(t), sheets: terms[t].sheets, bits: vec![0; row] }).collect();
    for (at, sheet) in sheets.iter().enumerate() {
        for id in &sheet.terms {
            if let Some(&w) = place.get(id) {
                words[w].bits[at / 64] |= 1 << (at % 64);
            }
        }
    }

    let taken = taken_words(existing);
    let is_taken = |term: &Term| taken.iter().any(|name| same_word(&term.folded, name));
    let non_names = non_name_words();

    let mut themes: Vec<Theme> = Vec::new();
    for group in cluster(&words, total).into_iter().filter(|group| group.len() >= 2) {
        let mut ordered = group;
        ordered.sort_by(|&a, &b| {
            words[b].weight.total_cmp(&words[a].weight).then_with(|| terms[words[a].term].folded.cmp(&terms[words[b].term].folded))
        });
        ordered.truncate(THEME_WORDS);

        // Las palabras clave: las más pesadas, sin repetir una palabra en singular y plural.
        let mut keywords: Vec<usize> = Vec::new();
        for &w in &ordered {
            let folded = &terms[words[w].term].folded;
            if keywords.iter().all(|&k| !same_word(folded, &terms[words[k].term].folded)) {
                keywords.push(w);
            }
            if keywords.len() == KEYWORDS {
                break;
            }
        }
        if keywords.len() < 2 {
            continue;
        }

        // Si la primera palabra clave es una palabra genérica/verbal (`NON_NAME_WORDS`),
        // primero nos fijamos si el grupo coincide con un ámbito del catálogo `TOPICS`, y si no,
        // promovemos la primera palabra sustantiva del grupo para que la categoría nunca se llame «Windows», «Tiempo» o «Acceso».
        let mut umbrella = None;
        if non_names.contains(&terms[words[keywords[0]].term].folded) {
            if let Some(label) = topic_label(&keywords, &words, &terms) {
                umbrella = Some(label);
            } else if let Some(pos) = keywords.iter().position(|&k| !non_names.contains(&terms[words[k].term].folded)) {
                let good = keywords.remove(pos);
                keywords.insert(0, good);
            } else {
                continue;
            }
        }

        let mut hits = vec![0u8; total];
        for &w in &ordered {
            for (index, &bits) in words[w].bits.iter().enumerate() {
                let mut left = bits;
                while left != 0 {
                    hits[index * 64 + left.trailing_zeros() as usize] += 1;
                    left &= left - 1;
                }
            }
        }
        let members: Vec<(usize, u8)> = hits.iter().enumerate().filter(|(_, &n)| n >= 2).map(|(at, &n)| (at, n)).collect();
        if members.len() < 2 || members.len() as f64 > total as f64 * MAX_THEME_SHARE {
            continue;
        }

        // Si ya hay una categoría que se llama así (o su palabra principal es esa), no se propone.
        let umbrella_taken = umbrella.is_some_and(|u| {
            let u_folded = fold(u);
            taken.iter().any(|name| same_word(&u_folded, name))
        });
        let taken = umbrella_taken || keywords.iter().take(2).any(|&k| is_taken(&terms[words[k].term]));
        themes.push(Theme { sheets: members, keywords, umbrella, taken });
    }

    // Los temas con más hojas primero; de entre los casi iguales, queda el más grande.
    themes.sort_by(|a, b| {
        b.sheets.len().cmp(&a.sheets.len()).then_with(|| {
            let (a, b) = (a.name(&words, &terms), b.name(&words, &terms));
            a.folded.cmp(&b.folded)
        })
    });
    // Los temas que ya existen como categoría no se proponen, pero siguen ocupando sus hojas:
    // lo que se les parece tampoco se propone.
    let mut kept: Vec<Theme> = Vec::new();
    let mut proposed = 0;
    for theme in themes {
        let mine: HashSet<usize> = theme.sheets.iter().map(|(at, _)| *at).collect();
        let repeated = kept.iter().any(|other| {
            let both = other.sheets.iter().filter(|(at, _)| mine.contains(at)).count();
            let either = mine.len() + other.sheets.len() - both;
            let smaller = mine.len().min(other.sheets.len());
            both as f32 / either as f32 > SAME_THEME || both * 3 >= smaller * 2
        });
        if repeated {
            continue;
        }
        proposed += usize::from(!theme.taken);
        kept.push(theme);
        if proposed == MAX_SUGGESTIONS {
            break;
        }
    }

    kept.into_iter()
        .filter(|theme| !theme.taken)
        .map(|theme| {
            let mut best = theme.sheets.clone();
            best.sort_by(|a, b| {
                b.1.cmp(&a.1).then_with(|| notes[sheets[a.0].note].0.cmp(&notes[sheets[b.0].note].0))
            });
            let mut samples: Vec<String> = Vec::new();
            for (at, _) in best {
                let title = notes[sheets[at].note].0.trim();
                if !title.is_empty() && samples.iter().all(|seen| !seen.eq_ignore_ascii_case(title)) {
                    samples.push(title.chars().take(80).collect());
                }
                if samples.len() == SAMPLES {
                    break;
                }
            }
            CategorySuggestion {
                name: theme.display_name(&words, &terms),
                keywords: theme.keywords.iter().map(|&k| terms[words[k].term].shown().to_string()).collect(),
                count: theme.sheets.len(),
                samples,
            }
        })
        .collect()
}

/// Las sugerencias para el cuaderno de esta base: solo las hojas visibles (ni el secret-book
/// ni la papelera) y sin repetir las categorías que ya existen.
pub fn from_db(db: &Db) -> Result<Vec<CategorySuggestion>, String> {
    let notes = db.suggestion_corpus(CONTENT_CHARS).map_err(|err| err.to_string())?;
    let existing: Vec<String> =
        db.categories().map_err(|err| err.to_string())?.into_iter().map(|category| category.name).collect();
    Ok(suggest(&notes, &existing))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Instant;

    use crate::db::{Incoming, VersionCfg};

    use super::*;

    fn note(title: &str, content: &str) -> (String, String) {
        (title.to_string(), content.to_string())
    }

    /// Un cuaderno de juguete: compras, trabajo, recetas y facultad mezcladas, más unas
    /// notas sueltas que no son de ningún tema.
    fn notebook() -> Vec<(String, String)> {
        vec![
            note("Lista del super", "Comprar leche, pan, huevos y yogur para la semana. Pasar por la verdulería: tomates, lechuga y cebolla. El detergente está en oferta en el super."),
            note("Reunión con el cliente", "Reunión del lunes con el cliente para repasar el presupuesto y los plazos de entrega. Pendiente enviar el informe antes del viernes."),
            note("Tarta de manzana", "Receta: mezclar harina, manteca y azúcar. Cortar las manzanas y cocinar a horno medio durante 40 minutos. Ingredientes: huevos, canela."),
            note("Apuntes de álgebra", "Apuntes de la clase de álgebra: matrices, determinantes y sistemas de ecuaciones. El profesor tomará el parcial el mes que viene."),
            note("Compras sábado", "Lista para el sábado: arroz, fideos, aceite y yerba. Ver el precio del café en el supermercado de la esquina. Comprar leche."),
            note("Pendientes de la semana", "Terminar el informe para el cliente. Preparar la presentación del proyecto y confirmar la reunión con el equipo. Enviar el presupuesto."),
            note("Salsa de tomate", "Ingredientes: tomates, cebolla, ajo y albahaca. Cocinar a fuego lento durante una hora. La receta rinde para cuatro porciones."),
            note("Final de física", "Estudiar para el final de física: cinemática, dinámica y energía. Repasar los ejercicios de la guía y los parciales anteriores con el profesor."),
            note("Ferretería", "Comprar tornillos, clavos y un martillo en la ferretería. Preguntar el precio de la pintura blanca y de los pinceles."),
            note("Retro del equipo", "Reunión de retrospectiva con el equipo: revisar los plazos, la entrega del proyecto y los problemas con el cliente."),
            note("Pan casero", "Receta del pan: harina, levadura, sal y agua. Amasar diez minutos y dejar levar. Cocinar en el horno bien caliente."),
            note("TP de programación", "Entregar el trabajo práctico de programación antes del parcial. Hablar con el profesor sobre la nota de la cursada."),
            note("Super miércoles", "Lista de compras del super: pan, queso, jamón, leche y manzanas. Revisar el precio de las ofertas."),
            note("Presupuesto obra", "Armar el presupuesto para el cliente nuevo. Incluir plazos de entrega y costos del proyecto. Mandar el informe final."),
            note("Bizcochuelo", "Ingredientes: harina, azúcar, huevos y esencia de vainilla. Batir las claras, mezclar y llevar al horno. Receta de la abuela."),
            note("Cursada segundo cuatrimestre", "Materias del cuatrimestre: álgebra, física y programación. Anotarme en la cursada y revisar el calendario de parciales y finales."),
            note("Farmacia", "Comprar ibuprofeno y alcohol en gel en la farmacia. Pedir el precio del termómetro."),
            note("Agenda reunión", "Temas para la reunión: avance del proyecto, entrega al cliente y presupuesto del trimestre. Llevar el informe."),
            note("Milanesas al horno", "Receta: pasar la carne por huevo y pan rallado. Cocinar al horno con un poco de aceite. Acompañar con ensalada."),
            note("Bibliografía", "Bibliografía de la materia: libros de álgebra lineal y de física. Sacar fotocopias de los apuntes de la profesora."),
            note("Entrevistas equipo", "Entrevistas para el equipo nuevo. Coordinar la reunión con recursos humanos y definir el presupuesto del puesto."),
            note("Guiso de lentejas", "Ingredientes: lentejas, zanahoria, papa y cebolla. Cocinar a fuego lento una hora y media. Una receta para el invierno."),
            note("Parcial de álgebra", "Resumen para el parcial de álgebra: matrices, autovalores y transformaciones lineales. Consultar al profesor por el ejercicio tres."),
            note("Teléfonos", "Plomero 11 5555 1234. Electricista: llamar el martes. Dirección: Av. Corrientes 1234, piso 3."),
            note("Cumpleaños de mamá", "El cumpleaños de mamá es el 14 de marzo. Organizar el almuerzo con toda la familia."),
            note("Sueño raro", "Hoy tuve un sueño muy raro con un tren que volaba sobre el mar."),
            note("Wifi", "casa2024 http://192.168.0.1/admin C:\\Users\\ana\\Documentos\\clave.txt 0x1f3a deadbeef"),
        ]
    }

    /// La sugerencia que tiene esa palabra entre sus palabras clave.
    fn with_word<'a>(found: &'a [CategorySuggestion], word: &str) -> Option<&'a CategorySuggestion> {
        found.iter().find(|suggestion| suggestion.keywords.iter().any(|keyword| keyword == word))
    }

    fn has_all(suggestion: &CategorySuggestion, words: &[&str]) -> bool {
        words.iter().all(|word| suggestion.keywords.iter().any(|keyword| keyword == word))
    }

    fn names(found: &[CategorySuggestion]) -> Vec<&str> {
        found.iter().map(|suggestion| suggestion.name.as_str()).collect()
    }

    #[test]
    fn un_cuaderno_de_juguete_da_los_temas_de_cada_tipo_de_nota() {
        let found = suggest(&notebook(), &[]);
        // Ejemplo de la salida real con este cuaderno:
        //   Cliente (6)  cliente, presupuesto, reunión, entrega, informe, proyecto
        //   Comprar (6)  comprar, pan, precio, leche, lista, aceite
        //   Receta  (6)  receta, cocinar, horno, ingredientes, harina, huevos
        //   Álgebra (4)  álgebra, profesor, parcial, apuntes, matrices
        //   Física  (3)  física, cursada, parciales, programación
        assert!((3..=8).contains(&found.len()), "{found:#?}");

        // Se muestran con tildes aunque se comparen sin ellas.
        let work = with_word(&found, "cliente").expect("el tema del trabajo");
        assert!(has_all(work, &["presupuesto", "reunión", "entrega"]), "{work:?}");
        let recipes = with_word(&found, "receta").expect("el tema de las recetas");
        assert!(has_all(recipes, &["horno", "harina", "ingredientes"]), "{recipes:?}");
        let shopping = with_word(&found, "comprar").expect("el tema de las compras");
        assert!(has_all(shopping, &["leche", "precio"]), "{shopping:?}");
        let college = with_word(&found, "álgebra").expect("el tema de la facultad");
        assert!(has_all(college, &["profesor", "parcial"]), "{college:?}");
        assert_eq!(names(&found)[..4], ["Cliente", "Comprar", "Receta", "Álgebra"]);

        // Cada nota de un tema es de ese tema: ninguna palabra de otro se les mezcla.
        for (theme, strangers) in [(work, ["horno", "leche", "profesor"]), (recipes, ["cliente", "precio", "parcial"])] {
            for stranger in strangers {
                assert!(!theme.keywords.iter().any(|keyword| keyword == stranger), "{theme:?}");
            }
        }

        let titles: HashSet<String> = notebook().into_iter().map(|(title, _)| title).collect();
        assert!(found.windows(2).all(|pair| pair[0].count >= pair[1].count), "ordenadas por hojas");
        for suggestion in &found {
            assert!((2..=6).contains(&suggestion.keywords.len()), "{suggestion:?}");
            let distinct: HashSet<_> = suggestion.keywords.iter().collect();
            assert_eq!(distinct.len(), suggestion.keywords.len(), "palabras repetidas: {suggestion:?}");
            assert!(suggestion.count >= 2, "{suggestion:?}");
            assert!((1..=3).contains(&suggestion.samples.len()), "{suggestion:?}");
            assert!(suggestion.samples.iter().all(|sample| titles.contains(sample)), "{suggestion:?}");
            assert_eq!(suggestion.name.to_lowercase(), suggestion.keywords[0].to_lowercase());
            assert!(suggestion.name.chars().next().is_some_and(char::is_uppercase));
        }
        assert!((4..=7).contains(&work.count) && (4..=7).contains(&recipes.count), "{found:#?}");
    }

    #[test]
    fn el_mismo_cuaderno_da_siempre_las_mismas_sugerencias() {
        let found = suggest(&notebook(), &[]);
        assert_eq!(found, suggest(&notebook(), &[]));
        // Ni siquiera importa en qué orden estén las hojas.
        let mut backwards = notebook();
        backwards.reverse();
        assert_eq!(found, suggest(&backwards, &[]));
    }

    #[test]
    fn las_palabras_vacias_no_son_palabras_clave() {
        let stop = stop_words();
        for word in ["the", "and", "for", "with", "para", "con", "los", "pero", "hacer", "tener", "poder", "también", "más", "qué"] {
            assert!(stop.contains(&fold(word)), "{word}");
        }
        for suggestion in suggest(&notebook(), &[]) {
            for keyword in &suggestion.keywords {
                assert!(!stop.contains(&fold(keyword)), "«{keyword}» es una palabra vacía: {suggestion:?}");
                assert!(keyword.chars().count() >= 3, "{keyword}");
            }
        }
        // Un cuaderno donde solo se repiten palabras vacías, números y días no tiene temas.
        let filler: Vec<_> = (0..12)
            .map(|n| note(&format!("nota {n}"), "the and for with para con los las pero como when that have hacer tener poder lunes enero 2024 12345"))
            .collect();
        assert!(suggest(&filler, &[]).is_empty());
    }

    #[test]
    fn solo_cuentan_las_palabras_de_verdad() {
        let text = "Reunión reunion REUNIÓN caña cana ñandú \
                    https://ejemplo.com/pagina?x=1 C:\\Users\\ana\\notas.txt /usr/local/bin correo@ejemplo.com \
                    12345 3.14 0x1f3a deadbeef abc123 v2 don't aaaa un el la de y en to be it";
        let corpus = Corpus::read(&[note("", text)]);
        let mut found: Vec<&str> = corpus.terms.iter().map(|term| term.folded.as_str()).collect();
        found.sort_unstable();
        // «caña» y «cana» son palabras distintas (la eñe no es una tilde); con o sin tilde,
        // «reunión» es una sola.
        assert_eq!(found, ["cana", "caña", "reunion", "ñandu"]);
        let shown = |folded: &str| corpus.terms.iter().find(|term| term.folded == folded).unwrap().shown().to_string();
        assert_eq!((shown("reunion").as_str(), shown("caña").as_str(), shown("ñandu").as_str()), ("reunión", "caña", "ñandú"));
    }

    #[test]
    fn la_forma_con_tildes_mas_usada_es_la_que_se_muestra() {
        let mut term = Term::new("accion");
        for _ in 0..5 {
            term.seen("accion");
        }
        assert_eq!(term.shown(), "accion", "nunca se la escribió con tilde");
        term.seen("acción");
        term.seen("acción");
        term.seen("áccion");
        assert_eq!(term.shown(), "acción", "gana la que se escribió bien, aunque sea menos usada");
    }

    #[test]
    fn el_plural_y_la_terminacion_no_hacen_otra_palabra() {
        for (a, b) in [("compras", "compra"), ("comprar", "compras"), ("reunion", "reuniones"), ("papel", "papeles"), ("receta", "recetas")] {
            assert!(same_word(a, b) && same_word(b, a), "{a} / {b}");
        }
        for (a, b) in [("casa", "cama"), ("receta", "cebolla"), ("proyecto", "proyecciones"), ("pan", "panel")] {
            assert!(!same_word(a, b), "{a} / {b}");
        }
    }

    fn word_in(sheets: &[usize], total: usize) -> Word {
        let mut bits = vec![0u64; total.div_ceil(64)];
        for &sheet in sheets {
            bits[sheet / 64] |= 1 << (sheet % 64);
        }
        Word { term: 0, weight: 0.0, sheets: sheets.len() as u32, bits }
    }

    #[test]
    fn la_asociacion_descuenta_lo_que_coincide_por_casualidad() {
        let (together, apart) = ([0, 1, 2, 3], [4, 5, 6, 7]);
        // Siempre en las mismas hojas: 1. Sin relación: 0. Una excluye a la otra: -1.
        assert!((association(&word_in(&together, 8), &word_in(&together, 8), 8) - 1.0).abs() < 1e-6);
        assert!(association(&word_in(&together, 8), &word_in(&[0, 1, 4, 5], 8), 8).abs() < 1e-6);
        assert!((association(&word_in(&together, 8), &word_in(&apart, 8), 8) + 1.0).abs() < 1e-6);
        // Dos palabras que están en casi todas las hojas coinciden mucho (Jaccard 0,6), pero
        // no se asocian: eso es lo esperable por el solo hecho de ser comunes.
        let common_a: Vec<usize> = (0..10).filter(|n| n % 5 != 0).collect();
        let common_b: Vec<usize> = (0..10).filter(|n| n % 5 != 1).collect();
        assert!(association(&word_in(&common_a, 10), &word_in(&common_b, 10), 10) < 0.0);
    }

    #[test]
    fn no_propone_categorias_que_ya_existen() {
        let free = suggest(&notebook(), &[]);
        assert_eq!(names(&free)[..3], ["Cliente", "Comprar", "Receta"]);

        // Sin importar mayúsculas ni tildes.
        let found = suggest(&notebook(), &["RECETA".to_string(), "algebra".to_string(), "Cliente".to_string()]);
        for gone in ["Receta", "Álgebra", "Cliente"] {
            assert!(!names(&found).contains(&gone), "{gone} ya existe: {found:#?}");
        }
        assert!(names(&found).contains(&"Comprar"));

        // En plural o en infinitivo es la misma categoría; también por una de las palabras de su nombre.
        let found = suggest(&notebook(), &["Compras".to_string(), "Facultad y Recetas".to_string()]);
        for gone in ["Comprar", "Receta"] {
            assert!(!names(&found).contains(&gone), "{gone} ya existe: {found:#?}");
        }
        assert!(names(&found).contains(&"Cliente"));

        // Ni el mismo tema con otro nombre: ninguna sugerencia que quede arranca con esas palabras.
        for suggestion in &found {
            assert!(!suggestion.keywords.iter().take(2).any(|word| word == "comprar" || word == "receta"), "{suggestion:?}");
        }
    }

    #[test]
    fn con_muy_pocas_notas_devuelve_una_lista_vacia_sin_fallar() {
        assert!(suggest(&[], &[]).is_empty());
        assert!(suggest(&[], &["Trabajo".to_string()]).is_empty());
        assert!(suggest(&notebook()[..1], &[]).is_empty());
        assert!(suggest(&notebook()[..MIN_SHEETS - 1], &[]).is_empty());
        // Notas vacías o sin nada que contar.
        assert!(suggest(&vec![note("", ""); 20], &[]).is_empty());
        assert!(suggest(&vec![note("hola", "ok"); 20], &[]).is_empty());
        // Todas iguales: ninguna palabra distingue un grupo de otro.
        assert!(suggest(&vec![note("lista", "alfa bravo charlie delta echo"); 10], &[]).is_empty());
        // Con apenas las hojas justas, no se rompe.
        let _ = suggest(&notebook()[..MIN_SHEETS], &[]);
    }

    #[test]
    fn el_texto_raro_no_rompe_nada() {
        let mut notes = notebook();
        notes.push(note("🙂🙂🙂", &"ñandú ".repeat(5000)));
        // Más largo que el recorte, con letras de varios bytes justo en el borde.
        notes.push(note("á".repeat(500).as_str(), &format!("{}á{}", "é".repeat(CONTENT_CHARS - 1), "ü".repeat(100))));
        notes.push(note("終わり", "日本語のメモ 日本語のメモ 日本語のメモ \u{0}\u{7}\r\n\t"));
        notes.push(note("larga", &"a".repeat(100_000)));
        notes.push(note("cadena", &format!("{} qwertyuiopasdfghjklzxcvbnm", "x".repeat(10))));
        let found = suggest(&notes, &[]);
        assert!((3..=8).contains(&found.len()), "{found:#?}");
    }

    /// Una base en memoria con el cuaderno de juguete: cada nota es un archivo.
    fn database(notes: &[(String, String)]) -> Db {
        let db = Db::open(Path::new(":memory:")).expect("base en memoria");
        for (title, content) in notes {
            add(&db, title, content);
        }
        db
    }

    fn add(db: &Db, title: &str, content: &str) -> i64 {
        let key = format!("C:\\Notas\\{title}.txt");
        let incoming = Incoming {
            source: "file",
            source_key: key.clone(),
            title: title.into(),
            path: Some(key.clone()),
            content: content.into(),
            size: content.len() as i64,
            source_mtime: 1,
            created_at: 1,
            modified_at: 1,
        };
        db.upsert_sheet(&incoming, &VersionCfg { keep: 2, session_gap_ms: 300_000 }).expect("hoja");
        db.sheet_id("file", &key).expect("id de la hoja")
    }

    #[test]
    fn las_secretas_y_las_de_la_papelera_no_influyen_ni_aparecen() {
        let baseline = from_db(&database(&notebook())).unwrap();
        assert!(names(&baseline).contains(&"Cliente"));

        // Otros dos temas, de seis hojas cada uno: de motos y de jardín.
        let motos: Vec<(String, String)> = [
            "Cambiar la cadena y el casco de la moto, revisar los frenos y el escape.",
            "Comprar casco nuevo, ajustar la cadena y limpiar el escape de la moto.",
            "Los frenos de la moto hacen ruido: revisar las pastillas y la cadena.",
            "Service de la moto: cambiar el casco viejo, la cadena y los frenos.",
            "El escape de la moto pierde humo, mirar el motor y la cadena.",
            "Casco, guantes y cadena nueva para el viaje en moto con los frenos al día.",
        ]
        .iter()
        .enumerate()
        .map(|(n, text)| (format!("Moto {}", n + 1), text.to_string()))
        .collect();
        let jardin: Vec<(String, String)> = [
            "Regar las macetas del balcón, podar el rosal y echar abono.",
            "Podar el césped, regar las plantas y comprar tijera de podar nueva.",
            "Las macetas necesitan abono; regar el jazmín y podar las ramas secas.",
            "Cortar el césped, regar el patio y echar abono en las macetas.",
            "Tijera de podar afilada para el rosal; regar temprano las macetas.",
            "Abono para el césped, regar los canteros y podar el limonero.",
        ]
        .iter()
        .enumerate()
        .map(|(n, text)| (format!("Jardín {}", n + 1), text.to_string()))
        .collect();

        let db = database(&notebook());
        let ids: Vec<(i64, bool)> = motos
            .iter()
            .map(|(title, content)| (add(&db, title, content), true))
            .chain(jardin.iter().map(|(title, content)| (add(&db, title, content), false)))
            .collect();

        // Mientras están a la vista, los dos temas aparecen: la prueba de que cuentan.
        let visible = from_db(&db).unwrap();
        assert!(with_word(&visible, "cadena").is_some() || with_word(&visible, "casco").is_some(), "{visible:#?}");
        assert!(with_word(&visible, "regar").is_some() || with_word(&visible, "macetas").is_some(), "{visible:#?}");

        // Las de motos van al secret-book y las de jardín a la papelera.
        for (id, secret) in ids {
            if secret {
                db.set_sheet_secret(id, true).unwrap();
            } else {
                db.set_sheet_hidden(id, true).unwrap();
            }
        }
        let after = from_db(&db).unwrap();
        // Es como si no existieran: ni cambian los temas ni las palabras ni las hojas contadas.
        assert_eq!(after, baseline);
        for suggestion in &after {
            assert!(suggestion.samples.iter().all(|sample| !sample.starts_with("Moto") && !sample.starts_with("Jardín")), "{suggestion:?}");
        }
    }

    #[test]
    fn las_categorias_de_la_base_tampoco_se_vuelven_a_proponer() {
        let db = database(&notebook());
        db.create_category("Compras", "Listas de compras", "#34C759").unwrap();
        assert!(db.categories().unwrap().iter().any(|category| category.name == "Compras"));
        assert!(!names(&from_db(&db).unwrap()).contains(&"Comprar"));
        db.create_category("Recetas", "Cocina", "#FF9500").unwrap();
        let found = from_db(&db).unwrap();
        assert!(!names(&found).contains(&"Receta"), "{found:#?}");
        assert!(names(&found).contains(&"Cliente"));
    }

    #[test]
    fn de_cada_hoja_se_lee_solo_el_comienzo() {
        let db = database(&[]);
        add(&db, "larga", &format!("{}{}", "ab ".repeat(2000), "zzz ".repeat(2000)));
        let corpus = db.suggestion_corpus(CONTENT_CHARS).unwrap();
        assert_eq!(corpus.len(), 1);
        assert_eq!(corpus[0].0, "larga");
        assert_eq!(corpus[0].1.chars().count(), CONTENT_CHARS);
        assert!(!corpus[0].1.contains("zzz"), "lo del final de una hoja larga no entra");
    }

    // ---- muchas hojas ---------------------------------------------------------------------

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }

        fn unit(&mut self) -> f64 {
            (self.next() % 1_000_000) as f64 / 1_000_000.0
        }

        /// Un índice entre 0 y `n`, con los primeros mucho más probables (como las palabras de un idioma).
        fn skewed(&mut self, n: usize) -> usize {
            (((n as f64 + 1.0).powf(self.unit()) - 1.0) as usize).min(n - 1)
        }
    }

    /// Una palabra inventada, pronunciable (consonante y vocal, de dos a cuatro sílabas).
    fn made_up(rng: &mut Rng, seen: &mut HashSet<String>) -> String {
        loop {
            let word: String = (0..2 + rng.below(3))
                .flat_map(|_| [b"bcdfghjklmnprstvz"[rng.below(17)] as char, b"aeiou"[rng.below(5)] as char])
                .collect();
            if !stop_words().contains(&word) && seen.insert(word.clone()) {
                return word;
            }
        }
    }

    /// Un cuaderno inventado de `docs` hojas: doce temas de tamaños desiguales (algunas hojas
    /// mezclan dos), un fondo de palabras comunes a todos, palabras raras que casi no se
    /// repiten y un 15 % de hojas que no son de ningún tema. Devuelve también el vocabulario de cada tema.
    fn synthetic(docs: usize) -> (Vec<(String, String)>, Vec<Vec<String>>) {
        let (mut rng, mut seen) = (Rng(0x9E37_79B9_7F4A_7C15), HashSet::new());
        let topics: Vec<Vec<String>> = (0..12).map(|_| (0..30).map(|_| made_up(&mut rng, &mut seen)).collect()).collect();
        let background: Vec<String> = (0..250).map(|_| made_up(&mut rng, &mut seen)).collect();
        let rare: Vec<String> = (0..6000).map(|_| made_up(&mut rng, &mut seen)).collect();
        let notes = (0..docs)
            .map(|n| {
                let mut body: Vec<&str> = Vec::new();
                let main = rng.skewed(12);
                let other = rng.below(12);
                let mixed = rng.unit() < 0.2;
                if rng.unit() >= 0.15 {
                    for _ in 0..25 + rng.below(30) {
                        let topic = if mixed && rng.unit() < 0.35 { other } else { main };
                        body.push(&topics[topic][rng.skewed(30)]);
                    }
                }
                for _ in 0..40 + rng.below(40) {
                    body.push(&background[rng.skewed(250)]);
                }
                for _ in 0..15 + rng.below(15) {
                    body.push(&rare[rng.below(rare.len())]);
                }
                for at in (1..body.len()).rev() {
                    body.swap(at, rng.below(at + 1));
                }
                (format!("nota {n}"), body.join(" "))
            })
            .collect();
        (notes, topics)
    }

    #[test]
    fn con_miles_de_hojas_responde_rapido_y_encuentra_los_temas() {
        let (notes, topics) = synthetic(3000);
        let started = Instant::now();
        let found = suggest(&notes, &[]);
        let took = started.elapsed();
        eprintln!("{} hojas: {took:?}, {} sugerencias", notes.len(), found.len());
        // En una compilación sin optimizar son unos segundos como mucho; optimizada, una fracción.
        assert!(took.as_secs() < 20, "{took:?}");

        assert!((3..=8).contains(&found.len()), "{found:#?}");
        let mut covered = HashSet::new();
        for suggestion in &found {
            // Cada tema encontrado habla de un solo tema del cuaderno.
            let owners: HashSet<usize> = suggestion
                .keywords
                .iter()
                .map(|keyword| topics.iter().position(|vocabulary| vocabulary.contains(keyword)).expect("palabra de algún tema"))
                .collect();
            assert_eq!(owners.len(), 1, "mezcla temas: {suggestion:?}");
            covered.extend(owners);
        }
        assert!(covered.len() >= 6, "{} de 12 temas: {found:#?}", covered.len());
        assert!(found.windows(2).all(|pair| pair[0].count >= pair[1].count));
        assert_eq!(found, suggest(&notes, &[]), "determinista");
    }

    #[test]
    fn no_propone_hola_por_repeticion_ni_palabras_genericas_como_windows_tiempo_acceso_bad_o_fin() {
        let mut notes = notebook();
        // Una hoja con «hola» repetido 150 veces jamás debe generar una categoría «Hola».
        notes.push(note("Saludo largo", &"hola ".repeat(150)));
        // Hojas técnicas con «windows», «tiempo», «acceso», «fin», «terminar», «final», «bad»
        notes.push(note(
            "Transmisor FM",
            "Transmisor FM con dipolo, antena, balun, frecuencia y watts en Windows durante mucho tiempo.",
        ));
        notes.push(note(
            "Antena dipolo",
            "Ajustar la antena dipolo del transmisor FM con el balun y medir los watts y la frecuencia en Windows.",
        ));
        notes.push(note(
            "Letra canción",
            "bad good love baby yeah feel song lyrics fin terminar final acceso tiempo windows",
        ));

        let found = suggest(&notes, &[]);
        let banned_names = ["Hola", "Windows", "Tiempo", "Acceso", "Bad", "Fin", "Terminar", "Final"];
        for bad in banned_names {
            assert!(
                !names(&found).iter().any(|name| name.eq_ignore_ascii_case(bad)),
                "no debe proponer «{bad}» como nombre de categoría: {found:#?}"
            );
        }
        // El tema de electrónica/radio no se llama «Windows», sino «Transmisor», «Antena», «Frecuencia» o «Electrónica».
        if let Some(radio) = found.iter().find(|s| s.keywords.iter().any(|k| k == "transmisor" || k == "antena" || k == "dipolo")) {
            assert_ne!(radio.name.to_lowercase(), "windows");
            assert_ne!(radio.name.to_lowercase(), "tiempo");
        }
    }
}

