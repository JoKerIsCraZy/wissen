<script lang="ts">
  import '$lib/tokens.css';

  import { onMount, type Snippet } from 'svelte';
  import { goto, afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { base } from '$app/paths';

  import Rail from '$lib/components/Rail.svelte';
  import Topbar from '$lib/components/Topbar.svelte';
  import LogPeek from '$lib/components/LogPeek.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import HelpOverlay from '$lib/components/HelpOverlay.svelte';
  import MobileTabBar from '$lib/components/MobileTabBar.svelte';
  import ScrollTopFab from '$lib/components/ScrollTopFab.svelte';
  import ReleaseUpdateModal from '$lib/components/ReleaseUpdateModal.svelte';

  import { peek } from '$lib/stores/peek.svelte';
  import { pushToast } from '$lib/stores/toast.svelte';
  import { getRouteId } from '$lib/stores/route.svelte';
  import { triggerScrape as apiTriggerScrape, getLogs } from '$lib/api/endpoints';
  import { ApiHttpError } from '$lib/api/client';
  import { connectEvents, type SseClient } from '$lib/api/sse';
  import { live } from '$lib/stores/live.svelte';

  interface LayoutProps {
    children: Snippet;
  }
  let { children }: LayoutProps = $props();

  // Overlay state
  let paletteOpen = $state(false);
  let helpOpen = $state(false);

  // g-prefix navigation: hold `g` and tap a letter to switch routes. The
  // indicator is bound directly to the held state — release g, prefix gone.
  let gPrefixActive = $state(false);
  let gHeld = false;

  // The login route is owned by B3; suppress shell chrome there if it ever
  // mounts under +layout (B3 is expected to use a sibling +layout).
  const isShellRoute = $derived(getRouteId(page.url.pathname) !== 'login');

  // Routes that benefit from a "scroll to top" pill once the user has paged
  // through enough content to lose their entry point.
  const SCROLL_TOP_ROUTES = new Set(['stundenplan', 'noten', 'absenzen', 'stats']);
  const showScrollTop = $derived(
    SCROLL_TOP_ROUTES.has(getRouteId(page.url.pathname))
  );

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return target.isContentEditable;
  }

  const G_ROUTE_MAP: Record<string, string> = {
    j: '/',            // Jetzt
    s: '/stundenplan', // Stundenplan
    n: '/noten',       // Noten
    b: '/absenzen',    // Absenzen (B wie a-B-senz; n ist von Noten belegt)
    a: '/stats',       // Auswertung
    e: '/settings',    // Einstellungen
    p: '/push',        // Push
    t: '/telegram',    // Telegram
  };

  let scrapeBusy = $state(false);

  async function triggerScrape(): Promise<void> {
    if (scrapeBusy) return;
    scrapeBusy = true;
    try {
      const res = await apiTriggerScrape();
      if (res?.triggered) {
        pushToast('info', 'Abfrage gestartet.', { title: 'Abfrage' });
      } else if (res?.reason) {
        pushToast('warn', `Nicht gestartet: ${res.reason}`, { title: 'Abfrage' });
      }
      // Routes listen for this event to refetch their data once the Abfrage
      // completes. SSE-based live status updates would replace this; until
      // then the event triggers a soft refetch.
      window.dispatchEvent(new CustomEvent('wissen:scrape'));
    } catch (err) {
      let msg = 'Fehler beim Starten';
      if (err instanceof ApiHttpError) {
        if (err.status === 429) {
          const body = err.body as { retryInSec?: number; reason?: string } | null;
          msg = body?.reason ?? `Cooldown — in ${body?.retryInSec ?? '?'}s erneut versuchen`;
        } else if (err.status === 401) {
          msg = 'Nicht authentifiziert';
        } else {
          msg = `Server-Fehler (${err.status})`;
        }
      } else if (err instanceof Error) {
        msg = err.message;
      }
      pushToast('error', msg, { title: 'Abfrage fehlgeschlagen' });
    } finally {
      scrapeBusy = false;
    }
  }

  function focusSearch(): void {
    // Search lives on /noten. Route there first if needed, then focus the
    // first available search input (the noten route page will own #notenSearch).
    const goAndFocus = (): void => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLInputElement>('input[type="search"], input[data-search]');
        if (el) el.focus();
      });
    };
    if (getRouteId(page.url.pathname) !== 'noten') {
      void goto(`${base}/noten`).then(goAndFocus);
    } else {
      goAndFocus();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    // Esc has the highest priority and works even on inputs.
    if (e.key === 'Escape') {
      if (paletteOpen) {
        e.preventDefault();
        paletteOpen = false;
        return;
      }
      if (helpOpen) {
        e.preventDefault();
        helpOpen = false;
        return;
      }
      if (peek.open) {
        e.preventDefault();
        peek.hide();
        return;
      }
      if (gPrefixActive) {
        gPrefixActive = false;
        gHeld = false;
        return;
      }
      return;
    }

    // Cmd/Ctrl shortcuts work even while a field is focused.
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      paletteOpen = true;
      return;
    }
    if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      peek.toggle();
      return;
    }

    // CommandPalette handles its own arrow/enter keys while open.
    if (paletteOpen) return;

    if (isEditableTarget(e.target)) return;

    // Hold 'g' to arm the navigation prefix.
    if (e.key === 'g' || e.key === 'G') {
      // Ignore browser autorepeat — the OS keeps firing keydown until
      // keyup, but we only want to react to the initial press.
      if (e.repeat) return;
      gHeld = true;
      gPrefixActive = true;
      return;
    }

    // While g is held, letters trigger navigation. The prefix stays armed
    // so multiple routes can be visited within a single hold.
    if (gHeld) {
      const route = G_ROUTE_MAP[e.key.toLowerCase()];
      if (route) {
        e.preventDefault();
        void goto(`${base}${route}`);
      }
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (e.key === 'r') {
      e.preventDefault();
      triggerScrape();
      return;
    }
    if (e.key === '?') {
      e.preventDefault();
      helpOpen = true;
      return;
    }
  }

  function onKeyup(e: KeyboardEvent): void {
    if (e.key === 'g' || e.key === 'G') {
      gHeld = false;
      gPrefixActive = false;
    }
  }

  /* Scroll-to-top on every route change. SvelteKit's default targets the
   * window, but our actual scroll container is .main (the layout shell sets
   * overflow-y:auto there so the rail + topbar stay fixed). Without this,
   * navigating from a long page (e.g. /noten with 100 modules scrolled to
   * the bottom) into another route would land mid-page. Skip on hash-only
   * navigations so anchor jumps still work. */
  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname === to.url.pathname) return;
    const el = document.querySelector('.main');
    if (el instanceof HTMLElement) el.scrollTop = 0;
  });

  onMount(() => {
    // Backfill logs from /api/logs first so the LogPeek isn't empty until the
    // first SSE log lands.
    void getLogs(200).then((res) => {
      for (const entry of res.logs) live.pushLog(entry);
    }).catch(() => { /* ignore */ });

    // Live SSE: status pill + log peek + abfrage-done refetch trigger.
    const sse: SseClient = connectEvents();
    const offState = sse.onState((s) => { live.connection = s; });
    const offStatus = sse.on('status', (s) => live.applyStatus(s));
    const offLog = sse.on('log', (entry) => live.pushLog(entry));
    // Genau EIN Done-Listener: der Server feuert 'abfrage_done' (kanonisch)
    // UND das alte 'scrape_done'. Auf beide zu lauschen löste einen doppelten
    // Refetch aus — daher bewusst nur auf das kanonische Event.
    const offDone = sse.on('abfrage_done', () => {
      // Routes refetch their data on this event.
      window.dispatchEvent(new CustomEvent('wissen:scrape'));
    });

    return () => {
      offState();
      offStatus();
      offLog();
      offDone();
      sse.close();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

{#if isShellRoute}
  <div class="app">
    <Rail />
    <div class="shell">
      <Topbar
        status={live.kind}
        statusLabel={live.label}
        lastrun={live.lastrun}
        onScrape={triggerScrape}
        onPalette={() => (paletteOpen = true)}
      />
      <main class="main">
        <div class="main__inner">
          {#key page.url.pathname}
            <div class="route-frame">
              {@render children()}
            </div>
          {/key}
        </div>
      </main>
    </div>
    <LogPeek />
    <Toast />
    <CommandPalette bind:open={paletteOpen} onHelpOpen={() => (helpOpen = true)} />
    <HelpOverlay bind:open={helpOpen} />
    <MobileTabBar />
    {#if showScrollTop}
      <ScrollTopFab />
    {/if}
    <ReleaseUpdateModal />
    {#if gPrefixActive}
      <div class="g-prefix" role="status" aria-live="polite">
        <span class="kbd">g</span>
        <span>dann Buchstabe für Route</span>
      </div>
    {/if}
  </div>
{:else}
  <!-- Login surface, owned by B3, renders without shell chrome. -->
  {@render children()}
  <Toast />
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: var(--rail-w) 1fr;
    height: 100vh;
    width: 100vw;
  }

  .shell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
    height: 100vh;
  }

  .main {
    flex: 1;
    overflow-y: auto;
    /* Clip statt visible auf der X-Achse: die Settings-Save-Bar bricht per
       negativem margin-inline aus der zentrierten .main__inner aus, um als
       Full-Bleed-Footer bis an die Rail/Scrollbar zu reichen. clip schneidet
       diesen Bleed pixelgenau an der .main-Kante ab (ohne eine horizontale
       Scrollbar zu erzeugen, wie es overflow-x:auto taete). */
    overflow-x: clip;
    scroll-behavior: smooth;
  }
  /* The route gets a comfortable PC-monitor width without going edge-to-edge
   * on ultrawide. min-height stretches to fill the viewport so dashboard
   * pages can use 100% of the available vertical space. */
  .main__inner {
    max-width: 1600px;
    margin: 0 auto;
    padding: 24px 28px 60px;
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* Route transition. The {#key pathname} wrapper re-mounts this frame on
   * navigation, retriggering the keyframe. Only opacity + transform are
   * animated (compositor-friendly, no layout thrash). Reduced-motion users
   * get a shorter opacity-only fade so the surface still doesn't snap. */
  .route-frame {
    flex: 1;
    display: flex;
    flex-direction: column;
    animation: routeIn 200ms var(--ease) both;
    /* `will-change` bewusst NICHT gesetzt: die routeIn-Animation läuft
     * nur 200ms, moderne Browser detektieren das und promoten den Layer
     * automatisch. Ein permanentes will-change:opacity,transform hielt
     * den Layer dauerhaft im Speicher — Memory-Overhead ohne Nutzen,
     * sichtbar in Chrome-Devtools-Performance auf langen Sessions. */
  }
  @keyframes routeIn {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes routeFade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .route-frame {
      animation: routeFade 140ms linear both;
    }
  }

  .g-prefix {
    position: fixed;
    bottom: 24px;
    left: 50%;
    /* Use the standalone `translate` property for horizontal centering so
     * the entry animation can use `transform` without overriding (or
     * clearing, post-animation) the centering offset. */
    translate: -50% 0;
    z-index: 70;
    background: var(--surface);
    border: 1px solid var(--accent-border);
    border-radius: var(--r-md);
    padding: 8px 14px;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text);
    box-shadow: var(--shadow-md);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    animation: gPrefixPop 140ms var(--ease);
  }
  @keyframes gPrefixPop {
    from { opacity: 0; transform: scale(0.96) translateY(4px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  .kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--accent);
    letter-spacing: 0.04em;
  }

  @media (max-width: 640px) {
    .main__inner { padding: 16px 16px 80px; }
  }

  /* Mobile: drop the rail column and reserve room for the bottom tab bar
     (plus iOS safe-area). The MobileTabBar component itself is fixed. */
  @media (max-width: 720px) {
    .app { grid-template-columns: 1fr; }
    .main {
      padding-bottom: calc(var(--tabbar-h, 56px) + env(safe-area-inset-bottom));
    }
    .main__inner {
      padding: 16px 16px 24px;
    }
    .g-prefix {
      bottom: calc(var(--tabbar-h, 56px) + env(safe-area-inset-bottom) + 12px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .g-prefix { animation: none; }
    .main { scroll-behavior: auto; }
  }
</style>
