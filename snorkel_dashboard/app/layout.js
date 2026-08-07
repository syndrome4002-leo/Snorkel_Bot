import './globals.css';

export const metadata = {
  title: 'Bot',
  description: 'Start Sentinel tasks and see what has been collected.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({ children }) {
  return (
    /*
     * The script in <head> below stamps `data-theme` on this element before
     * React hydrates, so the server HTML ("<html lang=en>") and the live DOM
     * ("<html lang=en data-theme=dark>") differ by exactly one attribute, and
     * React warns that the tree did not match.
     *
     * That difference is the point: the alternative is applying the theme after
     * hydration, which is a flash of the wrong colours on every single load.
     * `suppressHydrationWarning` covers this element's own attributes and
     * nothing deeper, so a genuine mismatch inside the page still surfaces.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🤿</text></svg>"
        />
        {/*
          Runs before the first paint, which is the whole point of it being here
          rather than in a component. This is a static export: the HTML that
          arrives has no idea which theme was chosen, so reading localStorage in
          an effect would render the wrong one and correct it a frame later —
          visible as a flash of white on every load for anyone using dark.
        */}
        {/*
          Suppressed for the same reason as <html> above, but a different cause:
          browser extensions inject their own scripts into <head>, and one that
          arrives before React hydrates shifts everything after it along by one.
          React then compares this script against the extension's — a src to
          chrome-extension://… where it expected the theme snippet — and reports
          a mismatch in our HTML that is not in our HTML.

          Nothing here is derived from the page, the clock or the environment:
          the content is a fixed string. So there is no real mismatch this could
          hide.
        */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('snorkelbot.theme');" +
              "if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
