import { Roboto } from "next/font/google";
import Translate from "@/i18n/Translate";

// Styles
import "@/styles/main.scss";

const sans = Roboto({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "700"], variable: "--font-sans" });

export const metadata = {
  title: "HomeTube",
  description: "Your own video library, downloaded to your homelab",
};

const RootLayout = ({ children }) => {
  return (
    <html lang={process.env.NEXT_PUBLIC_HOMETUBE_LANG || "en"} className={sans.variable}>
      <body>{children}<Translate /></body>
    </html>
  );
};

export default RootLayout;
