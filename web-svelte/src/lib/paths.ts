/**
 * Base-Pfad der App ohne Slash am Ende: '' beim Self-Host, '/wissen/desktop-demo'
 * im GitHub-Pages-Demo-Build (siehe paths.base in vite.config.ts).
 *
 * SvelteKit 3 exportiert `base` nicht mehr aus `$app/paths`. App-Routen laufen
 * deshalb über das typisierte `resolve('/noten')`. Dieser Wert ist nur für URLs
 * gedacht, die SvelteKit nicht kennt — z.B. /assets/* und /floorplans/*, die
 * Express aus web/ ausliefert. resolve('/') liefert base + '/'.
 *
 * Setzt Path-Routing voraus (Default). Mit router.type 'hash' gäbe resolve('/')
 * '#/' zurück und base wäre '#'.
 */
import { resolve } from '$app/paths';

export const base: string = resolve('/').slice(0, -1);
