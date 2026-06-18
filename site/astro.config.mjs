// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseLinks from './rehype-base-links.mjs';

const base = '/wissen';

export default defineConfig({
  site: 'https://jokeriscrazy.github.io',
  base,
  markdown: {
    rehypePlugins: [[rehypeBaseLinks, { base }]],
  },
  integrations: [
    starlight({
      title: 'WISSen',
      description: 'Inoffizieller Scraper für das WISS Tocco-Schulportal — Noten, Stundenplan, PWA, Telegram-Bot, Push-Benachrichtigungen aus einem Guss.',
      logo: {
        src: './src/assets/logo.webp',
        alt: 'WISSen Logo',
        // Logo ersetzt den "WISSen"-Title im Header — sonst doppelt mit dem
        // Hero-H1 unten ("Deine WISS-Noten, live auf deinem Handy.")
        // visuell konkurrenzierend direkt darunter.
        replacesTitle: true,
      },
      favicon: '/favicon.ico',
      defaultLocale: 'root',
      locales: {
        root: { label: 'Deutsch', lang: 'de' },
      },
      // Force dark-only — kein Theme-Switcher in der UI, kein Light-Mode.
      // ThemeProvider wird über das ausgeblendete <starlight-theme-select> via
      // CSS unsichtbar; data-theme wird hart auf "dark" gesetzt unten via
      // Inline-Skript im head.
      pagefind: true,
      customCss: ['./src/styles/custom.css', './src/styles/docs.css'],
      components: {
        PageTitle: './src/components/overrides/PageTitle.astro',
      },
      head: [
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://jokeriscrazy.github.io/wissen/og.png' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#6366f1' },
        },
        // Progressive enhancement: mark JS-enabled before paint so reveal-animations
        // can hide initial state without ever flashing for no-JS users / SEO crawlers.
        // Plus: force dark theme — site is dark-only, so any persisted theme=light
        // from localStorage gets overridden before paint to prevent FOUC.
        {
          tag: 'script',
          content: 'document.documentElement.classList.add("tm-anim");document.documentElement.setAttribute("data-theme","dark");try{localStorage.setItem("starlight-theme","dark");}catch(e){}',
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/JoKerIsCraZy/wissen',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/JoKerIsCraZy/wissen/edit/main/site/',
      },
      lastUpdated: true,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      sidebar: [
        {
          label: 'Loslegen',
          items: [
            // Anchor-link statt Slug — Starlight's Slug-Resolver kann auf
            // Windows fehlschlagen wenn der Link kein eigener Doc-Slug ist.
            // /#demo scrollt in-place auf der Landing zur Live-Demo-Section.
            { label: 'Live Demo', link: '/#demo' },
            { label: 'Übersicht', link: '/start/uebersicht/' },
            { label: 'Quick Start (Docker)', link: '/start/quick-start/' },
            { label: 'Lokale Installation', link: '/start/installation/' },
          ],
        },
        {
          label: 'Docker',
          items: [
            { label: 'Deployment', link: '/docker/deployment/' },
            { label: 'NAS / Unraid / Synology', link: '/docker/nas-unraid/' },
          ],
        },
        {
          label: 'Konfiguration',
          items: [
            { label: 'Environment-Variablen', link: '/konfiguration/env-variablen/' },
            { label: 'Sicherheit', link: '/konfiguration/sicherheit/' },
          ],
        },
        {
          label: 'Betrieb',
          items: [
            { label: 'Ins Internet freigeben', link: '/betrieb/internet-freigeben/' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'Dashboard', link: '/features/dashboard/' },
            { label: 'Mobile-App (PWA)', link: '/features/mobile-pwa/' },
            { label: 'Push-Benachrichtigungen', link: '/features/push/' },
            { label: 'Telegram-Bot', link: '/features/telegram/' },
            { label: 'Stundenplan & Noten', link: '/features/stundenplan-noten/' },
            { label: 'Absenzen', link: '/features/absenzen/' },
          ],
        },
        {
          label: 'Referenz',
          items: [
            { label: 'API-Übersicht', link: '/referenz/api/' },
            { label: 'Architektur', link: '/referenz/architektur/' },
            { label: 'Troubleshooting', link: '/referenz/troubleshooting/' },
          ],
        },
        {
          label: 'Projekt',
          items: [
            { label: 'Lizenz', link: '/projekt/lizenz/' },
            { label: 'Mitwirken', link: '/projekt/mitwirken/' },
          ],
        },
      ],
    }),
  ],
});
