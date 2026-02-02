import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "ScoutHub",
  description: "Room scout con chat e chiamate",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
