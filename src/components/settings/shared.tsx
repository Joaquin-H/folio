import type { ReactNode } from 'react';

/**
 * Lo común a las secciones de Ajustes: el contenedor agrupado y el renglón, más el tipo
 * de la función con la que una sección dispara un cambio.
 */

/** Ejecuta un cambio en el backend y, al terminar, recarga los ajustes (o muestra el error). */
export type Act = (action: Promise<unknown>) => void;

export function Group(props: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="group">
      {props.title && <h3>{props.title}</h3>}
      <div className="group-body">{props.children}</div>
      {props.footer && <p className="group-footer">{props.footer}</p>}
    </section>
  );
}

export function Row(props: { label: ReactNode; detail?: ReactNode; children?: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={`row${props.className ? ` ${props.className}` : ''}`}>
      <div className="row-text">
        <span className={props.mono ? 'mono' : undefined}>{props.label}</span>
        {props.detail && <small>{props.detail}</small>}
      </div>
      {props.children && <div className="row-control">{props.children}</div>}
    </div>
  );
}
