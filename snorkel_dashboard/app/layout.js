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
    <html lang="en">
      <head>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🤿</text></svg>"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
