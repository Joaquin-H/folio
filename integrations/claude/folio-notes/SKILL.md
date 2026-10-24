---
name: folio-notes
description: 'Control completo del cuaderno visual Folio mediante su servidor MCP integrado (`folio mcp`) o archivos en {{CARPETA_DE_NOTAS}}. Usala cuando el usuario pida crear o editar notas, buscar o leer hojas del cuaderno, analizar y categorizar notas, fijar hojas, mover a Recortes/Secret-book/Papelera, arrancar hojas en ventanas flotantes, dejar una nota flotando o colapsada en pantalla, o abrir el mapa del cuaderno.'
---

# Control completo de Folio para agentes de IA

## 1. Qué es Folio y modelo de datos

**Folio** es el cuaderno visual donde el usuario reúne y organiza todas sus notas en la PC:
- **Hojas (`sheets`)**: Cada nota es una hoja del cuaderno. Sus orígenes (`source`) pueden ser:
  - `'file'`: Archivos `.md` o `.txt` en la carpeta de Folio (`{{CARPETA_DE_NOTAS}}`) o en carpetas vigiladas del disco.
  - `'capture'`: Capturas rápidas escritas desde la hoja suelta.
  - `'notepad'`: Pestañas abiertas sin guardar del Bloc de notas de Windows.
  - `'sticky'`: Notas de Windows Sticky Notes.
- **Categorías (`categories`)**: Solapas de colores con `id`, `name`, `description` y `color` (`#RRGGBB`). También existe la categoría especial **Recortes** (`clippings`).
- **Estados de una hoja**:
  - `pinned`: Fijada arriba de todo en el cuaderno.
  - `secret`: Guardada en el **Secret-book** (cifrada con XChaCha20-Poly1305).
  - `hidden`: En la **papelera** (fuera de la vista principal, recuperable en cualquier momento).
- **Hojas flotantes («Arrancar hoja» / Hoja suelta)**: Cualquier hoja del cuaderno se puede «arrancar» a su propia ventana flotante siempre visible (`always-on-top`), que puede estar **expandida** (`440×572`), **fijada** (`pinned`, no se colapsa al cambiar de ventana) o **colapsada** como un ícono compacto (`52×52`) apilado en el dock de la pantalla.

---

## 2. Cómo configurar el servidor MCP integrado (`folio mcp`)

El propio ejecutable de Folio incluye un servidor **MCP (Model Context Protocol, JSON-RPC 2.0 por stdio)** que se activa pasando el subcomando `mcp` (o `--mcp`).
- Si la aplicación Folio está abierta, el servidor MCP se comunica en vivo con ella por IPC local para abrir/colapsar ventanas flotantes, abrir el mapa y refrescar el cuaderno al instante.
- Si Folio está cerrado, el servidor MCP opera directamente sobre `folio.db` y `{{CARPETA_DE_NOTAS}}`, y deja preparadas las hojas flotantes para que se abran al iniciar Folio.

### Configuración en clientes MCP (Antigravity, Claude Desktop, Claude Code, Cursor, VS Code, Codex, Gemini CLI)

Agregá el servidor `folio` en el archivo de configuración MCP de tu cliente (`mcp_config.json`, `claude_desktop_config.json`, `.cursor/mcp.json`, `.vscode/mcp.json` o `~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "folio": {
      "command": "folio",
      "args": ["mcp"]
    }
  }
}
```

*(En Windows, si `folio.exe` no está en el `PATH`, usá la ruta completa al ejecutable instalado, p. ej. `"C:\\Users\\<usuario>\\AppData\\Local\\Programs\\Folio\\Folio.exe"` con `"args": ["mcp"]`).*

En **Claude Code** por línea de comandos:
```sh
claude mcp add folio -- folio mcp
```

---

## 3. Catálogo completo de herramientas MCP (`folio_*`)

Cuando el servidor MCP está disponible, preferí siempre usar estas herramientas tipadas:

### Lectura, búsqueda y estado general
- **`folio_get_overview`** `{}`
  Devuelve conteos (`all`, `today`, `uncategorized`, `secret`, `hidden`), todas las categorías, `notesDir` y la lista `tornOffSheets` de hojas flotantes abiertas.
- **`folio_list_sheets`** `{ view?: "all" | "today" | "uncategorized" | "category" | "secret" | "hidden", categoryId?: number, query?: string, limit?: number }`
  Lista o busca hojas por texto completo (FTS5) o por vista/categoría.
- **`folio_get_sheet`** `{ id: number }`
  Lee el contenido completo, metadatos, `hash` y versiones anteriores de una hoja.

### Creación y edición de hojas
- **`folio_create_sheet`** `{ title: string, content: string, categoryId?: number, categoryName?: string, createCategoryIfMissing?: boolean, pinned?: boolean, tearOff?: boolean, collapsed?: boolean }`
  Crea una nota en `{{CARPETA_DE_NOTAS}}`, le asigna categoría (creándola si no existe), opcionalmente la fija (`pinned: true`) y/o la deja abierta como ventana flotante (`tearOff: true`, expandida o `collapsed: true` en el dock).
- **`folio_update_sheet`** `{ id: number, content: string, title?: string, append?: boolean }`
  Reemplaza el contenido de una hoja (o agrega al final con `append: true`) y opcionalmente la renombra.

### Análisis y categorización
- **`folio_list_categories`** `{}`
  Lista todas las categorías con `id`, `name`, `description`, `color` y `count`.
- **`folio_create_category`** `{ name: string, description?: string, color?: string }`
  Crea una categoría nueva (colores sugeridos: `#007AFF`, `#5856D6`, `#30B0C7`, `#34C759`, `#FF9500`, `#FFCC00`, `#FF2D55`, `#AF52DE`).
- **`folio_update_category`** `{ id: number, name: string, description?: string, color?: string }`
- **`folio_delete_category`** `{ id: number }`
- **`folio_set_sheet_category`** `{ id: number, categoryId?: number | null, categoryName?: string, createIfMissing?: boolean }`
  Asigna o quita la categoría de una hoja por ID o nombre.
- **`folio_suggest_categories`** `{}`
  Analiza todas las hojas del cuaderno localmente y sugiere grupos temáticos con palabras clave y ejemplos.

### Organización: fijar, Recortes, Secret-book y Papelera
- **`folio_set_sheet_pinned`** `{ id: number, pinned: boolean }`
  Fija (`true`) o desfija (`false`) una hoja arriba del cuaderno.
- **`folio_move_sheet`** `{ id: number, destination: "clippings" | "secret" | "trash" | "notebook" }`
  - `"clippings"`: Mueve la hoja a la categoría **Recortes**.
  - `"secret"`: Mueve la hoja al **Secret-book** cifrado.
  - `"trash"`: Envía la hoja a la **papelera**.
  - `"notebook"`: Restaura la hoja desde la papelera o el secret-book al cuaderno principal.

### Control de ventanas flotantes («Arrancar hoja») e interfaz
- **`folio_tear_off_sheet`** `{ id: number, collapsed?: boolean, pinned?: boolean }`
  Arranca la hoja `id` en su propia ventana flotante siempre encima. Si `collapsed: true`, la deja como ícono compacto en el dock; si `pinned: true`, queda fija expandida sin auto-colapsarse al perder foco.
- **`folio_set_floating_sheet_mode`** `{ id: number, collapsed?: boolean, pinned?: boolean }`
  Colapsa o expande una hoja flotante ya abierta, o cambia su pin.
- **`folio_return_torn_off_sheet`** `{ id: number }`
  Guarda y cierra la ventana flotante de la hoja `id`, devolviéndola al cuaderno.
- **`folio_list_torn_off_sheets`** `{}`
  Lista todas las hojas flotantes abiertas y su estado (`collapsed`, `pinned`, coordenadas).
- **`folio_open_map`** `{}`
  Abre la ventana de Folio directamente en el **Mapa del cuaderno**.
- **`folio_open_notebook`** `{ sheetId?: number }`
  Trae el cuaderno al frente y, si se indica `sheetId`, abre directamente esa hoja.
- **`folio_open_capture`** `{}`
  Abre la ventana flotante de captura rápida («Nueva hoja suelta»).
- **`folio_rescan`** `{}`
  Re-escanea las carpetas vigiladas del disco.

---

## 4. Flujos de trabajo recomendados para el agente

### Flujo A: Crear una nota bien estructurada y categorizada
1. Si no conocés las categorías del usuario, llamá a `folio_list_categories`.
2. Llamá a `folio_create_sheet` con `title`, `content` en Markdown limpio y `categoryName` (con `createCategoryIfMissing: true` si hace falta una categoría nueva).
3. Si el usuario pidió **«dejámela a mano»**, **«dejala flotando»** o **«abrila en una hoja suelta / flotante»**, pasá `tearOff: true` (y `collapsed: true` si la pidió minimizada en un rincón/dock, o `pinned: true` si la quiere fija mientras trabaja en otra ventana).

### Flujo B: Analizar y organizar hojas sin categoría
1. Llamá a `folio_list_sheets` con `{ "view": "uncategorized" }` y a `folio_list_categories`.
2. Opcionalmente ejecutá `folio_suggest_categories` para ver agrupaciones temáticas detectadas en las notas.
3. Para cada hoja, leé su detalle con `folio_get_sheet` si el `preview` no alcanza, decidí la categoría más adecuada (o creá una nueva con `folio_create_category`) y asignala con `folio_set_sheet_category`.
4. Si encontrás recortes rápidos sueltos, movelos a Recortes con `folio_move_sheet` (`destination: "clippings"`).

### Flujo C: Respaldo directo en disco (cuando no hay cliente MCP configurado)
Si el entorno del agente no tiene conectado el servidor MCP, podés crear o editar archivos `.md` directamente en `{{CARPETA_DE_NOTAS}}` (Folio vigila esa carpeta en vivo y los indexa al instante):
1. Nombre del archivo: `AAAA-MM-DD-tema.md` en `{{CARPETA_DE_NOTAS}}` (nunca pises un archivo existente; si ya existe, usá `-2`, `-3`).
2. Encabezado YAML opcional que Folio interpreta automáticamente:
   ```markdown
   ---
   titulo: Título corto y claro
   categoria: Trabajo
   etiquetas: [tema, otro-tema]
   fuente: Claude Code
   fecha: AAAA-MM-DD
   ---

   # Título corto y claro

   Resumen claro y conciso.

   ## Pendientes
   - [ ] Tarea pendiente
   - [x] Tarea completada
   ```
3. Nunca guardes contraseñas, tokens ni claves privadas en texto plano; si el usuario pide guardar algo sensible, usá `folio_move_sheet` con `destination: "secret"`.
