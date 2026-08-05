'use client';

import { useEffect, useState } from 'react';

/*
 * Light, dark, or whatever the machine says.
 *
 * The choice is written to `data-theme` on <html>, which the stylesheet reads
 * ahead of the prefers-color-scheme media query — so an explicit choice wins in
 * both directions, and "system" is the absence of the attribute rather than a
 * third set of colours.
 *
 * The matching read happens in a blocking script in the document head (see
 * layout.js). It has to: this is a static export, so the first paint is server
 * HTML, and reading localStorage here in an effect would show the wrong theme
 * for a frame every time the page loads.
 */
const MODES = [
  { key: 'light', label: 'Light', icon: '☀' },
  { key: 'dark', label: 'Dark', icon: '☾' },
  { key: 'system', label: 'System', icon: '◐' },
];

export const THEME_KEY = 'snorkelbot.theme';

function apply(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Private browsing, or storage turned off. The theme still applies for this
    // page; it just will not be remembered.
  }
}

export default function ThemeToggle() {
  // Starts as null so the server-rendered markup and the first client render
  // agree; the real value arrives in the effect below.
  const [mode, setMode] = useState(null);

  useEffect(() => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* see above */
    }
    setMode(MODES.some((m) => m.key === saved) ? saved : 'system');
  }, []);

  const choose = (next) => {
    setMode(next);
    apply(next);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          className={`theme-option${mode === m.key ? ' active' : ''}`}
          aria-pressed={mode === m.key}
          title={`${m.label} theme`}
          onClick={() => choose(m.key)}
        >
          <span aria-hidden="true">{m.icon}</span>
          <span className="theme-label">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
