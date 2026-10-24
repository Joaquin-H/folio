import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useT } from '../../i18n';
import type { Category, CategorySuggestion, Overview } from '../../types';
import { ColorPicker } from '../ColorPicker';
import { Presence } from '../ui';
import { Group, type Act } from './shared';
import { SUGGEST_PALETTE, suggestColor, SuggestedCategoryList } from './SuggestionList';
import '../../styles/suggest.css';

/** Colores sugeridos para una categoría, también los que se reparten a las nuevas. */
const PALETTE = [...SUGGEST_PALETTE, '#8E8E93'];

/** Cuánto se espera, mientras se arrastra por el selector, antes de guardar el color. */
const SAVE_DELAY_MS = 280;

function CategoryRow(props: { category: Category; act: Act }) {
  const t = useT();
  const { category, act } = props;
  const [name, setName] = useState(category.name);
  const [description, setDescription] = useState(category.description);
  const [color, setColor] = useState(category.color);
  const [confirming, setConfirming] = useState(false);
  const dirty = name.trim() !== category.name || description.trim() !== category.description;

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const save = (next = category.color) => {
    if (name.trim()) act(api.updateCategory(category.id, name, description, next));
  };

  // El color se ve al instante y se guarda enseguida, pero no en cada paso de un arrastre.
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = useRef(() => {});
  flush.current = () => {
    clearTimeout(timer.current);
    if (pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    save(next);
  };
  const choose = (next: string) => {
    setColor(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), SAVE_DELAY_MS);
  };
  // Si la fila se va (otra sección, cierre de Ajustes) con un color sin guardar, se guarda.
  useEffect(() => () => flush.current(), []);
  useEffect(() => {
    if (pending.current === null) setColor(category.color);
  }, [category.color]);

  return (
    <div className="row category-row">
      <ColorPicker
        variant="well"
        align="left"
        value={color}
        suggested={PALETTE}
        title={t('Cambiar el color de {name}', { name: category.name })}
        label={t('Color de {name}', { name: category.name })}
        onChange={choose}
      />
      <div className="category-fields">
        <input value={name} aria-label={t('Nombre')} onChange={(e) => setName(e.target.value)} onBlur={() => dirty && save()} />
        <input
          value={description}
          aria-label={t('Descripción')}
          placeholder={t('Qué tipo de notas van acá (ayuda a la IA a elegir)')}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => dirty && save()}
        />
      </div>
      <span className="row-count">{category.count}</span>
      {confirming ? (
        <button type="button" className="button small danger" onClick={() => act(api.deleteCategory(category.id))}>
          {t('Eliminar')}
        </button>
      ) : (
        <button
          type="button"
          className="icon-button"
          aria-label={t('Eliminar {name}', { name: category.name })}
          title={t('Eliminar')}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

/** Lo mínimo que se ve el estado de espera: si el análisis es instantáneo, no parpadea. */
const MIN_WAIT_MS = 700;


/** Sin tildes ni mayúsculas, para decidir si dos nombres son el mismo. */
const plain = (text: string) => text.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Una sugerencia con lo que el usuario decidió: si se crea y con qué nombre. */
interface Choice extends CategorySuggestion {
  id: number;
  checked: boolean;
  /** Ya se creó (queda a la vista si otra falló y hay que reintentar). */
  created: boolean;
}

/**
 * Categorías de base a partir de las notas: el análisis es local (no se envía nada) y el
 * resultado es una lista para elegir y renombrar. Recién al aceptar se crea algo.
 */
function Suggestions(props: { categories: Category[]; act: Act }) {
  const t = useT();
  const { categories, act } = props;
  const [phase, setPhase] = useState<'idle' | 'working' | 'ready'>('idle');
  const [choices, setChoices] = useState<Choice[]>([]);
  /** El análisis falló: se explica en lugar de la lista. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Falló la creación de alguna de las elegidas. */
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<'local' | 'ai'>('local');
  const alive = useRef(true);
  const run = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const analyse = async (withAi = false) => {
    const ticket = ++run.current;
    setSource(withAi ? 'ai' : 'local');
    setPhase('working');
    setFailure(null);
    setCreateError(null);
    const started = Date.now();
    let found: CategorySuggestion[] = [];
    let problem: string | null = null;
    try {
      found = withAi ? await api.suggestCategoriesAi() : await api.suggestCategories();
    } catch (reason) {
      problem = String(reason).replace(/^Error:\s*/, '');
    }
    const left = MIN_WAIT_MS - (Date.now() - started);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    if (!alive.current || ticket !== run.current) return;
    setChoices(found.map((suggestion, id) => ({ ...suggestion, id, checked: true, created: false })));
    setFailure(problem);
    setPhase('ready');
  };

  const close = () => {
    run.current++;
    setPhase('idle');
  };

  const change = (id: number, patch: Partial<Choice>) =>
    setChoices((current) => current.map((choice) => (choice.id === id ? { ...choice, ...patch } : choice)));

  const existing = new Set(categories.map((category) => plain(category.name)));
  const pending = choices.filter((choice) => choice.checked && !choice.created);
  const repeated = new Map<string, number>();
  for (const choice of pending) repeated.set(plain(choice.name), (repeated.get(plain(choice.name)) ?? 0) + 1);
  const problemOf = (choice: Choice): string | null => {
    if (!choice.checked || choice.created) return null;
    const key = plain(choice.name);
    if (!key) return t('Falta el nombre.');
    if (existing.has(key)) return t('Ya hay una categoría con ese nombre.');
    if ((repeated.get(key) ?? 0) > 1) return t('Otra sugerencia tiene el mismo nombre.');
    return null;
  };
  const problem = pending.map(problemOf).find((text) => text !== null) ?? null;
  // Las categorías nuevas toman los colores de la paleta que siguen a los de las que ya hay.
  const colorFor = (at: number, base = categories.length) => suggestColor(at, base);
  const colors = new Map(pending.map((choice, at) => [choice.id, colorFor(at)]));

  const create = () => {
    setCreating(true);
    setCreateError(null);
    const first = categories.length;
    const task = (async () => {
      for (const [at, choice] of pending.entries()) {
        // La descripción es lo que la IA lee para decidir si una nota va en la categoría.
        await api.createCategory(choice.name.trim(), t('Notas sobre: {words}', { words: choice.keywords.join(', ') }), colorFor(at, first));
        if (alive.current) change(choice.id, { created: true });
      }
    })();
    task
      .then(() => alive.current && close())
      .catch((reason) => alive.current && setCreateError(String(reason).replace(/^Error:\s*/, '')))
      .finally(() => {
        // También si falló a mitad: lo que sí se creó tiene que verse en la lista.
        act(Promise.resolve());
        if (alive.current) setCreating(false);
      });
  };

  const note = createError ?? problem;
  const leftToCreate = pending.length;

  return (
    <>
      <div className="row suggest-row">
        <div className="row-text">
          <span>{t('Sugerir categorías a partir de mis notas')}</span>
          <small>{t('Se analizan en esta PC; no se envía nada.')}</small>
        </div>
        <div className="row-control">
          <button type="button" className="button suggest-go" disabled={phase === 'working' || creating} onClick={() => void analyse(false)}>
            {phase === 'working' && source === 'local' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
            {phase === 'working' && source === 'local' ? t('Analizando…') : phase === 'ready' && source === 'local' ? t('Analizar de nuevo') : t('Sugerir')}
          </button>
          <button type="button" className="button suggest-ai" disabled={phase === 'working' || creating} onClick={() => void analyse(true)}>
            {phase === 'working' && source === 'ai' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
            {phase === 'working' && source === 'ai' ? t('Consultando…') : phase === 'ready' && source === 'ai' ? t('Consultar de nuevo') : t('Sugerir con IA')}
          </button>
        </div>
      </div>
      <Presence show={phase === 'ready'} exitMs={240}>
        {(leaving) => (
          <div
            className={`suggest-panel${leaving ? ' leaving' : ''}`}
            onAnimationEnd={(event) => {
              // Al terminar de abrirse, se lleva a la vista lo que quedó abajo.
              if (event.target === event.currentTarget && event.animationName === 'suggest-open') {
                event.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }}
          >
            <div className="suggest-panel-inner">
              <div className="suggest-body">
                {failure ? (
                  <>
                    <p className="suggest-empty" role="alert">
                      {t('No se pudieron analizar las notas: {reason}', { reason: failure })}
                    </p>
                    <div className="suggest-actions">
                      <button type="button" className="button" onClick={close}>
                        {t('Cerrar')}
                      </button>
                    </div>
                  </>
                ) : choices.length === 0 ? (
                  <>
                    <p className="suggest-empty">{t('Todavía no hay suficientes notas parecidas entre sí para proponer categorías.')}</p>
                    <div className="suggest-actions">
                      <button type="button" className="button" onClick={close}>
                        {t('Cerrar')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <SuggestedCategoryList
                      items={choices.map((choice) => ({
                        id: choice.id,
                        name: choice.name,
                        keywords: choice.keywords,
                        count: choice.count,
                        samples: choice.samples,
                        checked: choice.checked,
                        created: choice.created,
                        color: colors.get(choice.id),
                        problem: problemOf(choice),
                      }))}
                      disabled={creating}
                      onToggle={(index) => change(choices[index].id, { checked: !choices[index].checked })}
                      onNameChange={(index, name) => change(choices[index].id, { name })}
                    />
                    <div className="suggest-actions">
                      <span className={`suggest-note${note ? ' warn' : ''}`} role={createError ? 'alert' : undefined} aria-live="polite">
                        {note ?? t('{n} de {total} elegidas', { n: leftToCreate, total: choices.filter((choice) => !choice.created).length })}
                      </span>
                      <button type="button" className="button" disabled={creating} onClick={close}>
                        {t('Descartar')}
                      </button>
                      <button type="button" className="button primary suggest-create" disabled={creating || leftToCreate === 0 || problem !== null} onClick={create}>
                        {creating && <LoaderCircle size={14} className="spin" />}
                        {t('Crear las elegidas')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </Presence>
    </>
  );
}

function ClippingsMigration(props: { count: number; act: Act }) {
  const t = useT();
  const [migrating, setMigrating] = useState(false);
  const [doneCount, setDoneCount] = useState<number | null>(null);

  const runMigration = async () => {
    setMigrating(true);
    try {
      const migrated = await api.migrateClippings();
      setDoneCount(migrated);
      props.act(Promise.resolve());
    } finally {
      setMigrating(false);
    }
  };

  if (doneCount !== null) {
    return (
      <div className="row suggest-row">
        <div className="row-text">
          <span>{t('Recortes organizados')}</span>
          <small>{t('Se asignaron {n} recortes a la categoría Recortes.', { n: doneCount })}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="row suggest-row">
      <div className="row-text">
        <span>{t('Organizar recortes existentes')}</span>
        <small>
          {t('Se encontraron {n} recortes sin categorizar. Podés moverlos automáticamente a la categoría Recortes.', {
            n: props.count,
          })}
        </small>
      </div>
      <div className="row-control">
        <button
          type="button"
          className="button suggest-go"
          disabled={migrating}
          onClick={() => void runMigration()}
        >
          {migrating && <LoaderCircle size={14} className="spin" />}
          {t('Asignar a Recortes')}
        </button>
      </div>
    </div>
  );
}

/** Las categorías entre las que elige el clasificador: color, nombre, descripción y cuántas hojas tiene cada una. */
export function Categories(props: { categories: Category[]; act: Act; overview?: Overview | null }) {
  const t = useT();
  const { categories, act, overview } = props;
  const [newCategory, setNewCategory] = useState('');
  // Sin elegir, la categoría nueva toma el siguiente color de la paleta.
  const [chosen, setChosen] = useState<string | null>(null);
  const newColor = chosen ?? PALETTE[categories.length % PALETTE.length];

  return (
    <Group
      title={t('Categorías')}
      footer={t('Tocá el círculo de color de una categoría para cambiarlo: se aplica al elegirlo. La IA que clasifica elige entre estas categorías; la descripción le indica qué va en cada una. Eliminar una categoría pide confirmación y deja sus hojas sin categoría: las hojas no se borran.')}
    >
      {overview?.untaggedClippingsCount ? (
        <ClippingsMigration count={overview.untaggedClippingsCount} act={act} />
      ) : null}
      {categories.map((category) => (
        <CategoryRow key={`${category.id}:${category.name}:${category.description}`} category={category} act={act} />
      ))}
      <form
        className="row add-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newCategory.trim()) return;
          act(api.createCategory(newCategory, '', newColor));
          setNewCategory('');
          setChosen(null);
        }}
      >
        <ColorPicker
          variant="well"
          align="left"
          value={newColor}
          suggested={PALETTE}
          title={t('Elegir el color de la categoría nueva')}
          label={t('Color de la categoría nueva')}
          onChange={setChosen}
        />
        <div className="inline-form">
          <input
            value={newCategory}
            aria-label={t('Nombre de la categoría nueva')}
            placeholder={t('Nueva categoría')}
            onChange={(event) => setNewCategory(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={!newCategory.trim()}>
            {t('Agregar')}
          </button>
        </div>
      </form>
      <Suggestions categories={categories} act={act} />
    </Group>
  );
}
