import { useCallback, useEffect, useState } from 'react';
import type { Deck, Slide, ThemeName } from './types';
import StartScreen from './components/StartScreen';
import Presentation from './components/Presentation';

const THEME_KEY = 'slidedown.theme';

function storedTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'light';
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
    () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
    [],
  );

  const loadDeck = useCallback((deck: Deck) => {
    if (deck.meta.theme) setTheme(deck.meta.theme);
    setSlides(deck.slides);
  }, []);

  if (!slides || slides.length === 0) {
    return (
      <StartScreen onLoad={loadDeck} theme={theme} onCycleTheme={cycleTheme} />
    );
  }

  return (
    <Presentation
      slides={slides}
      theme={theme}
      onCycleTheme={cycleTheme}
      onExit={() => setSlides(null)}
    />
  );
}
