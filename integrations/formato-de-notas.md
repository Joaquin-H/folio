# Formato de notas para Book

Un formato chico para que un asistente de IA (Claude Code, Codex, Gemini CLI) o
cualquiera le deje notas a Book que se lean cómodas en el cuaderno. Es un archivo `.md`
común: se abre con cualquier editor y no depende de Book.

## Dónde y con qué nombre

- En la carpeta de notas de Book: `Documentos\Book` (la ruta exacta se ve en
  Ajustes → Integraciones).
- Nombre `AAAA-MM-DD-tema.md`: la fecha del día y un tema corto, en minúsculas, sin
  tildes y con guiones. Por ejemplo `2026-10-14-plan-de-migracion.md`.
- Nunca se pisa un archivo que ya existe: si el nombre está ocupado, se agrega `-2`,
  `-3`…

## El encabezado (opcional)

Va al principio, entre dos renglones `---`. Book no lo muestra como texto: lo usa.

| Clave | También | Qué hace en Book |
|---|---|---|
| `titulo` | `title` | Es el título que se ve en la hoja (en lugar del nombre del archivo). |
| `categoria` | `category` | Si coincide con una categoría que ya existe (sin importar tildes ni mayúsculas), la hoja va a esa categoría como si la hubieras elegido vos. Si no existe, no se crea nada. Una categoría que elegiste a mano nunca se pisa. |
| `etiquetas` | `tags` | Una lista (`[uno, dos]`); se ven como etiquetas discretas en el encabezado de la hoja. |
| `fuente` | `source` | Quién escribió la nota («Claude Code»); se ve junto a las etiquetas. |
| `fecha` | `date` | La fecha de la nota, `AAAA-MM-DD`. |

## El cuerpo

Markdown simple: títulos con `#`, párrafos cortos, listas (`-` o `1.`), tareas
(`- [ ]` y `- [x]`, que en Book se marcan con un clic), código entre ` ``` `, citas
con `>`, tablas chicas y enlaces. Sin HTML: Book no lo interpreta. Nada de
contraseñas, claves ni datos personales sensibles.

## Ejemplo

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
