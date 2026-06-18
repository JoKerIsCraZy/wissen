import { visit } from 'unist-util-visit';

/**
 * Prefixes root-absolute Markdown links (`/features/…`) mit dem konfigurierten
 * `base`-Pfad. Starlight macht das für Sidebar-Links automatisch, aber NICHT für
 * Links im Markdown-Content — die zeigen sonst auf `/features/…` statt
 * `/wissen/features/…` und liefern auf GitHub Pages einen 404.
 *
 * @param {{ base?: string }} [options]
 */
export default function rehypeBaseLinks({ base = '/' } = {}) {
  // Trailing-Slash entfernen, damit base + href nicht zu `//` wird.
  const normalizedBase = base.replace(/\/$/, '');

  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a') return;
      const href = node.properties?.href;
      if (typeof href !== 'string') return;

      // Nur interne root-absolute Links anfassen. Externe (`//`, `https://`),
      // relative und bereits ge-base-te Links bleiben unverändert.
      if (!href.startsWith('/') || href.startsWith('//')) return;
      if (normalizedBase && (href === normalizedBase || href.startsWith(`${normalizedBase}/`))) return;

      node.properties.href = `${normalizedBase}${href}`;
    });
  };
}
