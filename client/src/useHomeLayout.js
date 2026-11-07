import { useEffect, useState } from "react";
import { homeLayout } from "./homeLayout.mjs";

const read = () => (typeof window === "undefined" ? "wide" : homeLayout(window.innerWidth));

export function useHomeLayout() {
  const [layout, setLayout] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const on = () => setLayout(read());
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return layout;
}
