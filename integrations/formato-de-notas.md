# Formato de notas y control por agentes (MCP) para Folio

Folio ofrece dos formas complementarias para que cualquier agente de IA (Antigravity, Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI) trabaje con el cuaderno del usuario:

1. **Servidor MCP integrado (`folio mcp` / `folio --mcp`)**: control programático completo sobre hojas, categorías, búsqueda FTS5, fijado, Recortes, Secret-book, papelera, ventanas flotantes («Arrancar hoja») y mapa del cuaderno.
2. **Archivos `.md` en la carpeta de notas (`Documentos\Folio`)**: formato simple con encabezado YAML opcional que Folio indexa en vivo.

---

## 1. Servidor MCP integrado (`folio mcp`)

Agregá a la configuración MCP de tu cliente (`mcp_config.json`, `claude_desktop_config.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.gemini/settings.json`):

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

### Herramientas expuestas
| Herramienta | Qué hace |
|---|---|
| `folio_get_overview` | Resumen de conteos, categorías, carpeta de notas y hojas flotantes abiertas. |
| `folio_list_sheets` | Lista o busca hojas por `view` (`all`, `today`, `uncategorized`, `category`, `secret`, `hidden`), `categoryId`, `query` (FTS5) y `limit`. |
| `folio_get_sheet` | Devuelve el detalle completo de una hoja (`id`), su `content`, `hash` y `versions`. |
| `folio_create_sheet` | Crea una hoja (`.md` o `.txt`), le asigna categoría (`categoryId` o `categoryName`), opcionalmente la fija (`pinned`) o la abre en ventana flotante (`tearOff`, `collapsed`). |
| `folio_update_sheet` | Edita el contenido (`append: true` para agregar al final) y/o renombra el título de una hoja. |
| `folio_list_categories` | Lista todas las categorías con su ID, nombre, descripción, color y cantidad de hojas. |
| `folio_create_category` | Crea una categoría nueva (`name`, `description`, `color`). |
| `folio_update_category` | Cambia nombre, descripción o color de una categoría. |
| `folio_delete_category` | Elimina una categoría sin borrar sus hojas. |
| `folio_set_sheet_category` | Asigna o quita la categoría de una hoja por ID o nombre. |
| `folio_suggest_categories` | Analiza localmente las hojas del cuaderno y sugiere categorías con palabras clave. |
| `folio_set_sheet_pinned` | Fija (`true`) o desfija (`false`) una hoja arriba del cuaderno. |
| `folio_move_sheet` | Mueve una hoja a `clippings` (Recortes), `secret` (Secret-book), `trash` (Papelera) o la restaura a `notebook`. |
| `folio_tear_off_sheet` | Arranca una hoja en su propia ventana flotante siempre visible (expandida o colapsada en el dock). |
| `folio_set_floating_sheet_mode` | Expande, colapsa al dock o fija/desfija una hoja flotante abierta. |
| `folio_return_torn_off_sheet` | Devuelve una hoja flotante al cuaderno y cierra su ventana. |
| `folio_list_torn_off_sheets` | Lista las hojas flotantes abiertas actualmente. |
| `folio_open_map` | Abre el Mapa del cuaderno en la ventana principal de Folio. |
| `folio_open_notebook` | Abre el cuaderno (y opcionalmente salta a `sheetId`). |
| `folio_open_capture` | Abre la ventana flotante de captura rápida («Nueva hoja suelta»). |
| `folio_rescan` | Vuelve a escanear las carpetas vigiladas. |

---

## 2. Formato de archivos `.md` en `Documentos\Folio`

- Nombre `AAAA-MM-DD-tema.md`: la fecha del día y un tema corto, en minúsculas, sin tildes y con guiones. Por ejemplo `2026-10-14-plan-de-migracion.md`.
- Nunca se pisa un archivo que ya existe: si el nombre está ocupado, se agrega `-2`, `-3`…

### El encabezado (opcional)

Va al principio, entre dos renglones `---`. Folio no lo muestra como texto: lo usa.

| Clave | También | Qué hace en Folio |
|---|---|---|
| `titulo` | `title` | Es el título que se ve en la hoja (en lugar del nombre del archivo). |
| `categoria` | `category` | Si coincide con una categoría que ya existe (sin importar tildes ni mayúsculas), la hoja va a esa categoría como puesta a mano. |
| `etiquetas` | `tags` | Una lista (`[uno, dos]`); se ven como etiquetas discretas en el encabezado de la hoja. |
| `fuente` | `source` | Quién escribió la nota («Claude Code»); se ve junto a las etiquetas. |
| `fecha` | `date` | La fecha de la nota, `AAAA-MM-DD`. |

### Ejemplo

~~~markdown
---
titulo: Plan de migración del gestor
categoria: Trabajo
etiquetas: [migración, gestor]
fuente: Claude Code
fecha: 2026-10-14
---

# Plan de migración

Se posterga dos semanas; antes hay que cerrar la capacitación.

## Pendientes
- [x] Avisar al equipo
- [ ] Pedir el presupuesto actualizado

## Comando para el respaldo
```sh
pg_dump gestor > respaldo.sql
```
~~~
