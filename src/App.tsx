import { useState } from 'react';
import type { Slide } from './types';
import StartScreen from './components/StartScreen';
import Presentation from './components/Presentation';

export default function App() {
  const [slides, setSlides] = useState<Slide[] | null>(null);

  if (!slides || slides.length === 0) {
    return <StartScreen onLoad={setSlides} />;
  }

  return <Presentation slides={slides} onExit={() => setSlides(null)} />;
}
