<!-- folio:inicio · Instrucciones de Folio para tomar notas y controlar el cuaderno. Folio agrega y quita este bloque desde Ajustes → Integraciones; lo que esté fuera de él no lo toca. -->
## Control de Folio y notas (`folio mcp`)

Folio es el cuaderno visual donde el usuario reúne y organiza todas sus notas (`{{CARPETA_DE_NOTAS}}`). Incluye un servidor **MCP (Model Context Protocol, stdio)** integrado en el ejecutable (`folio mcp` o `folio --mcp`) que permite controlar todo el cuaderno programáticamente.

### Configuración MCP
En `~/.gemini/settings.json`, `mcp_config.json` o `.vscode/mcp.json`:
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

### Herramientas MCP disponibles (`folio_*`)
- **Consultar y buscar**: `folio_get_overview`, `folio_list_sheets` (`view`: `'all' | 'today' | 'uncategorized' | 'category' | 'secret' | 'hidden'`, `query`, `categoryId`, `limit`), `folio_get_sheet` (`id`).
- **Crear y editar**: `folio_create_sheet` (`title`, `content`, `categoryId`, `categoryName`, `createCategoryIfMissing`, `pinned`, `tearOff`, `collapsed`), `folio_update_sheet` (`id`, `content`, `title`, `append`).
- **Categorizar**: `folio_list_categories`, `folio_create_category` (`name`, `description`, `color`), `folio_update_category`, `folio_delete_category`, `folio_set_sheet_category` (`id`, `categoryId`, `categoryName`), `folio_suggest_categories`.
- **Organizar**: `folio_set_sheet_pinned` (`id`, `pinned`), `folio_move_sheet` (`id`, `destination`: `'clippings' | 'secret' | 'trash' | 'notebook'`).
- **Hojas flotantes y ventana**: `folio_tear_off_sheet` (`id`, `collapsed`, `pinned`), `folio_set_floating_sheet_mode` (`id`, `collapsed`, `pinned`), `folio_return_torn_off_sheet` (`id`), `folio_list_torn_off_sheets`, `folio_open_map`, `folio_open_notebook` (`sheetId`), `folio_open_capture`, `folio_rescan`.

### Creación directa de archivos (si no usás MCP)
Si no tenés el servidor MCP conectado, guardá archivos `.md` en UTF-8 dentro de `{{CARPETA_DE_NOTAS}}` con nombre `AAAA-MM-DD-tema.md` (sin pisar archivos existentes; usá `-2`, `-3` si ya existe):

```markdown
---
titulo: Título corto y claro
categoria: Trabajo
etiquetas: [tema, otro-tema]
fuente: Gemini CLI
fecha: AAAA-MM-DD
---

# Título corto y claro

Una o dos frases con lo esencial.

## Pendientes
- [ ] Lo que falta hacer
- [x] Lo que ya está
```

- Si el usuario pide dejar una nota flotando o a la vista mientras trabaja, usá `folio_create_sheet` con `tearOff: true` o `folio_tear_off_sheet`.
- No guardes notas por tu cuenta sin que el usuario lo pida, ni escribas secretos en texto plano (para notas sensibles usá `folio_move_sheet` con `destination: "secret"`).
<!-- folio:fin -->
