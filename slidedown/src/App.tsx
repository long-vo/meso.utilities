import { useCallback, useEffect, useState } from 'react';
import type { Deck, Slide, ThemeName } from './types';
import { THEMES } from './types';
import StartScreen from './components/StartScreen';
import Presentation from './components/Presentation';

const THEME_KEY = 'slidedown.theme';
// The hub (meso.utilities) persists its light/dark choice under this key; on
// first run Slidedown seeds from it so opening a deck doesn't silently reset the
// theme. Once Slidedown writes THEME_KEY, that wins.
const HUB_THEME_KEY = 'meso-theme';

function isTheme(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

function storedTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isTheme(v)) return v;
    // No Slidedown preference yet — inherit the hub's light/dark choice.
    const hub = localStorage.getItem(HUB_THEME_KEY);
    if (hub === 'dark' || hub === 'light') return hub;
    return 'light';
  } catch {
    return 'light';
  }
}

export default function App() {
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [theme, setTheme] = useState<ThemeName>(storedTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, [theme]);

  const cycleTheme = useCallback(
    () =>
      setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]),
    [],
  );

  const loadDeck = useCallback((deck: Deck) => {
    if (deck.meta.theme) setTheme(deck.meta.theme);
    setSlides(deck.slides);
  }, []);

  if (!slides || slides.length === 0) {
    return (
      <StartScreen onLoad={loadDeck} theme={theme} onSetTheme={setTheme} />
    );
  }

  return (
    <Presentation
      slides={slides}
      theme={theme}
      onSetTheme={setTheme}
      onCycleTheme={cycleTheme}
      onExit={() => setSlides(null)}
    />
  );
}
