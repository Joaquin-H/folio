# Cambios

Las versiones siguen [SemVer](https://semver.org/lang/es/). Mientras Folio esté en 0.x, cada
versión menor puede cambiar cómo se ve o se usa.

## 1.1.0 — 2026-10-31

- **Hojas diarias (Hoy), recortes en vivo y pestañas renovadas**: organización automática por día, categoría de recortes en tiempo real (`Ctrl+Alt+X`), hojas fijadas y solapas compactas.
- **Hojas arrancables y dock de captura**: posibilidad de arrancar hojas como ventanas flotantes y dock colapsable en escritorio.
- **Servidor MCP integrado y mejoras de interfaz**: control para agentes vía stdio, mapa de hojas completo, buscador en ajustes, modo sin marco y correcciones de apilamiento visual (espiral, encabezado transparente, texto y zonas de paso de página).

## 1.0.0 — 2026-10-18

- **Primer lanzamiento mayor (Folio 1.0.0)**: primera versión estable de producción de Folio.
- **Ícono oficial definitivo**: Libreta clásica de cuero caramelo cálido con banda elástica vertical en terracota vivo y canto de hojas marfil (`folio-icon.svg`), incrustado en todas las resoluciones de Windows (`.ico`), macOS (`.icns`), accesos directos, barra de tareas y bandeja del sistema.
- **Rediseño editorial de documentación**: cabecera limpia, visual y libre de badges ruidosos en `README.md` y `README.es.md`.
- **Ecosistema J-Playground**: suite completa lista para distribución con instalador y ejecutable autónomo.

## 0.9.0 — 2026-10-17

- **Evolución a Folio (J-Playground)**: la aplicación pasa a llamarse oficialmente **Folio**,
  integrándose al ecosistema de software liviano y personal de **J-Playground** bajo el
  identificador `com.j-playground.folio`. Si tenías una versión anterior de Book, Folio detecta y
  migra de manera totalmente transparente tus notas, base de datos (`book.db` ➔ `folio.db`),
  configuración y claves de cifrado en el Administrador de credenciales.
- **Nuevo isotipo e ícono artesanal**: nuevo ícono representativo de un cuaderno/folio doblado
  con solapa y textura cálida en tonos cuero y papel, reemplazando el isotipo genérico anterior en
  todos los tamaños de Windows (accesos directos, barra de tareas, bandeja del sistema) y macOS.
- **Control de privacidad en recortes (`sendOrigin`)**: nuevo interruptor en Ajustes → Atajos
  («Incluir la aplicación de origen al guardar el recorte») que permite elegir si querés registrar
  la ventana o navegador desde donde capturaste el texto o guardar únicamente el texto puro.
- **Optimizaciones de rendimiento y robustez en `Ctrl + Alt + X`**: secuencia de teclas `Ctrl + C`
  con liberación atómica de modificadores (`AltGr` / `Alt` / `Win`) y pausas calibradas de 15 ms para
  garantizar captura confiable en navegadores modernos (Chrome, Edge) y editores de código (VS Code).
- **Refinamientos estéticos y de interfaz**:
  - Modal de bienvenida con tarjeta responsiva sin desbordes horizontales en modo bolsillo ni
    botones cortados.
  - Cartel final de recorrido («¡Todo listo!») con aireación y proporciones pulidas.
  - Contratapa actualizada con la firma oficial `Folio · Hecho por J.` / `Folio · Made by J.`.
  - Integraciones de IA actualizadas a la skill `folio-notes` para Claude Code, Codex y Gemini CLI.
  - Auditoría de código Ponytail: eliminación de código huérfano (`notepad_watch.rs`), simplificación
    de audio y tests unitarios 100% verdes.

## 0.8.0 — 2026-10-17

- **Bienvenida, categorías iniciales y recorrido interactivo**: la primera vez que se abre
  Book, una tarjeta de bienvenida ofrece armar tus categorías iniciales a partir de tus
  notas —ya sea con el análisis estadístico local en tu PC (sin enviar nada a Internet) o
  conectando una IA propia (Ollama local, Claude, OpenAI o Gemini)— antes de empezar el
  recorrido guiado de 7 pasos. Al finalizar el recorrido, un resumen presenta los recortes
  rápidos (`Ctrl + Alt + X`), la clasificación automática, las integraciones con asistentes y
  la personalización. Se puede volver a ver desde Ajustes → Personalización o Ajustes →
  Acerca de.
- **Hojas `.md` con formato**: los archivos Markdown se ven sobre el rayado con títulos,
  listas, casillas de tarea interactivas, tablas, citas, código y enlaces, más una barra de
  formato al escribir. Si tienen encabezado YAML (`titulo`, `categoria`, `etiquetas`,
  `fuente`, `fecha`), Book lo interpreta y lo conserva al editar.
- **Enviar lo seleccionado al Book (`Ctrl + Alt + X`)**: seleccioná un texto en cualquier
  programa, apretá el atajo y Book lo guarda junto con el nombre de la aplicación o página
  de origen, ya sea en la hoja de recortes del día (`recortes-AAAA-MM-DD.txt`) o abriendo
  una hoja suelta para revisarlo antes.
- **Cifrado del secret-book**: las hojas secretas y su historial de versiones se guardan
  cifrados en la base de datos con `XChaCha20-Poly1305`. La clave se almacena en el
  Administrador de credenciales de Windows y se puede copiar o restaurar una clave de
  respaldo desde Ajustes → Datos.
- **Varias IAs para clasificar**: además de Jev, se puede elegir **Claude**, **OpenAI**,
  **Gemini** u **Ollama** (modelos locales en la propia PC, sin enviar nada a Internet),
  con botón «Probar» para ver qué categoría elige cada una sobre una hoja de ejemplo.
- **Integraciones con asistentes de IA**: desde Ajustes → Integraciones se instalan en un
  clic las instrucciones para que **Claude Code**, **Codex** y **Gemini CLI** tomen notas
  en la carpeta de Book con formato `.md` listo para leer en el cuaderno (o se copian al
  portapapeles para cualquier otro asistente).
- **Idiomas (español e inglés)**: toda la interfaz, el recorrido inicial, los formatos de
  fecha, el menú de la bandeja del sistema y los avisos están en español e inglés (con
  detección automática del idioma del sistema o elección manual en Ajustes).
- **Dictado por voz**: botón de micrófono en el cartel «Escribiendo» y en la hoja suelta
  que abre el dictado por voz de Windows (`Win + H`) manteniendo el foco en la nota.
- **Seis estilos de tapa rediseñados**: texturas y acabados más realistas (clásica, tela,
  papel madera, pizarra, botánica y cuadriculada) y sonidos enfocados únicamente en pasar
  de hoja, escribir y borrar.
- **Ajustes con columna lateral**: navegación vertical a la izquierda en ventanas amplias y
  flechas de desplazamiento en vistas angostas para llegar siempre a todas las secciones.
- **Licencia**: MIT con condición Commons Clause (código abierto de uso y modificación
  libres, prohibida su venta comercial).

## 0.7.0 — 2026-10-12

- **Pasar página ya no se dispara por accidente**: solo pasan página las franjas de los
  bordes de afuera de la hoja; un clic en el resto no hace nada. **Doble clic** en
  cualquier parte de la hoja entra a escribir, con el cursor donde se tocó. **Deslizar**
  la hoja hacia un lado la pasa para ese lado.
- Arreglado: al entrar a escribir, a veces se salía solo del modo escritura y aparecía
  otra hoja. Pasaba con un doble clic algo lento y, sobre todo, al escribir en una hoja
  que no era la primera, cuando se guardaba sola. Escribiendo, tampoco la rueda ni
  Av Pág / Re Pág salen ya de la nota.
- El **color del cuaderno** es ahora el de toda la interfaz: los carteles «Escribiendo»
  y «Hoja nueva», los interruptores, los botones y el campo del nombre en la tapa.
- **Mover a la papelera pide confirmación.** Desde la Papelera y el Secret-book se
  vuelve con un botón «Volver al cuaderno» o con Esc.
- Guardar y terminar de escribir está a la vista: «Listo · Ctrl + Enter». En la hoja
  suelta, Ctrl + Enter y Ctrl + S guardan y cierran, y descartar pide un segundo clic.
- **Contratapa**: después de la última hoja; el cuaderno se da vuelta desde el menú o
  con la tecla V. **Estilos de tapa** además del color (lisa, manchas, con tira, con
  lomo, cuero) e **imágenes pegadas** en la tapa y la contratapa, que se acomodan, se
  agrandan y se giran.
- **Sonidos** de papel al pasar de hoja, abrir y cerrar el cuaderno; se apagan en
  Ajustes → Personalización.
- **Tamaño de la letra**: chica, mediana, grande o muy grande; el rayado acompaña.
- **Atajos a medida**: pestaña nueva en Ajustes para cambiar todos los atajos, también
  los dos que valen desde cualquier programa.
- **Inicio junto con la PC** (opcional), directo en la bandeja. Opción experimental:
  abrir una hoja suelta cuando se abre el Bloc de notas.
- **Jev consulta mucho menos**: una vez por hoja, cuando deja de cambiar. Una hoja ya
  clasificada no se vuelve a consultar aunque se edite (se puede pedir una revisión cada
  7 o 30 días); cambiar el color de una categoría o la confianza mínima no consulta
  nada. Ajustes muestra cuántas consultas se hicieron.
- **Categorías sugeridas**: Book analiza las notas en la propia PC y propone categorías
  de base. El color de cada categoría se cambia con el mismo selector que el de la tapa.
- Más cuidado con los datos: el escaneo ya no saca del cuaderno hojas cuyo archivo sigue
  existiendo (vacío, muy grande o solo en la nube); mover o renombrar una carpeta ya no
  duplica sus hojas ni les quita la marca de secreto o de papelera; cambiar un título no
  pisa otra hoja; salir desde la bandeja espera a que se guarde lo que se estaba
  escribiendo; excluir o quitar una carpeta pide confirmación.
- Privacidad: las hojas del secret-book y de la papelera ya no aparecen en «Originales
  que desaparecieron», y una hoja que se marca como secreta deja de enviarse a Jev aunque
  ya estuviera en cola.
- Ajustes → **Acerca de**: versión, créditos y licencia (MIT).
- Pruebas automáticas de la interfaz en `tests/e2e/`.

## 0.6.0 — 2026-10-10

- **Escribir en el cuaderno**: el botón de nueva hoja ya no abre un cuadro aparte; abre
  una hoja en blanco en el cuaderno, con el cursor listo. Con doble clic sobre el texto
  (o Enter, o F2, o desde el menú) se escribe en cualquier hoja que sea un archivo. Lo
  escrito se guarda solo; Esc o «Listo» terminan.
- Se ve en qué se está: la hoja que se escribe lleva una franja de color y un cartel,
  «Escribiendo» (azul) o «Hoja nueva» (verde). Sin cartel, se está leyendo.
- Las hojas escritas en Book son archivos de texto en `Documentos\Book`. Nacen con el
  título `notas-<fecha>`, que se puede cambiar ahí mismo (cambia el nombre del archivo).
- Al editar un archivo se respetan su codificación y sus saltos de línea. Si cambió por
  fuera mientras se lo escribía, Book avisa y deja elegir; lo de afuera no se pierde.
- Mientras se escribe, las páginas se recalculan y la vista sigue al cursor. Ningún clic
  en el papel pasa página: todos llevan el cursor al lugar del texto más cercano. La
  página se pasa con la rueda del mouse, con Re Pág y Av Pág o con las flechas del pie.
- La **rueda del mouse** pasa páginas.
- Ctrl + Alt + N abre una **hoja suelta** con el aspecto de una hoja del cuaderno.
- La cruz **cierra la ventana a la bandeja**; ya no hay botón de minimizar. Para cerrar
  Book del todo: menú → Cerrar Book.
- El **tamaño** se elige directo en el menú, sin pasar por los demás.
- **Modo tamaño**: manteniendo Mayús aparecen agarraderas en los bordes y las esquinas.
  Al arrastrar una, un fantasma muestra cómo quedaría el cuaderno; el tamaño se aplica al
  soltar Mayús, de una sola vez. Esc cancela.
- **Atajos**: Ctrl + 1, 2 y 3 para los tamaños, Ctrl + + y Ctrl + − para agrandar y
  achicar, Ctrl + D para una o dos hojas, Ctrl + W para cerrar la ventana. Están todos
  en Ajustes → Personalización.

## 0.5.0 — 2026-10-10

- Tercer tamaño, **pantalla completa**: el cuaderno ocupa todo el alto disponible. El
  tamaño estándar es más grande que antes, para que se distinga del de bolsillo.
- La ventana queda siempre entera dentro de la pantalla: si al abrirse o agrandarse se
  pasaría de un borde o quedaría bajo la barra de tareas, se corre. Recuerda dónde estaba.
- Los cambios de tamaño ya no saltan: el cuaderno se desvanece, la ventana cambia y vuelve.
- Botones sobre la hoja para **minimizar a la bandeja** y para **salir de Book**.
- **Ir a la última hoja** y a la primera, desde el menú o con Fin e Inicio.
- Atajo global **Ctrl + Alt + B** para abrir el cuaderno desde cualquier programa.
- La tapa también sirve para mover la ventana, con cursor de arrastre.
- Los ajustes se abren dentro del cuaderno cuando entran; si no, en su propia ventana.
- Versionado: número de versión en Ajustes → Datos, este registro y `pnpm release`.

## 0.4.0 — 2026-10-10

- Ventana sin barra de título y a la medida del cuaderno, en tamaños estándar.
- Tapa con el nombre del cuaderno editable, cantidad de hojas y marca.
- Atajo global Ctrl + Alt + N para anotar desde cualquier programa, con la opción de
  seguir en el Bloc de notas.
- Una hoja nueva se guarda al cerrar o al hacer clic afuera.
- Papelera y secret-book con papel, franja y cartel propios.
- Transiciones de salida en menús, paneles, tapa y páginas.
- Selector de color propio y exclusión de carpetas desde el explorador.
- Prueba de estrés de la interfaz (`tests/stress.mjs`).

## 0.3.0 — 2026-10-10

- Pasar página con un clic en la mitad izquierda o derecha de la hoja; tapa cerrada
  antes de la primera hoja.
- Solapas de categorías que filtran el cuaderno; la categoría de cada hoja se cambia en
  su encabezado.
- Versiones anteriores en un modal; papelera; personalización de tema y color de tapa.
- Al seleccionar arrastrando hasta el borde se pasa de página y de nota.
- Los originales que desaparecen se registran con fecha; mover o renombrar un archivo
  conserva la hoja.

## 0.2.0 — 2026-10-10

- Interfaz mínima: la ventana es solo el cuaderno; todo lo demás va en el menú de la hoja.
- En doble hoja, una nota larga continúa en la hoja de al lado y en las páginas siguientes.
- Ajustes con la ubicación de los datos; eliminar una categoría pide confirmación.

## 0.1.0 — 2026-10-10

- Primera versión: escaneo del disco con exclusiones, vigilancia de cambios, índice con
  búsqueda, versiones, lectura de las pestañas sin guardar del Bloc de notas y de Sticky
  Notes, secret-book, categorías y clasificador Jev opcional.
