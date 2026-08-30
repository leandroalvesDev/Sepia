import './globals.css';

export const metadata = {
  title: 'Sépia',
  description: 'Leitor de HQs e livros digitais client-side',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}