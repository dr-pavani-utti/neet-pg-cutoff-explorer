// Light/dark theme. Loaded synchronously in <head> so the saved theme applies before first paint.
// No saved choice = follow the OS. Any [data-theme-toggle] button flips it.
(() => {
  const KEY = "neetpg.theme";
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => localStorage.getItem(KEY);
  const current = () => saved() || (media.matches ? "dark" : "light");

  function apply() {
    const theme = current();
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#161513" : "#f5f1e8";
    for (const b of document.querySelectorAll("[data-theme-toggle]")) {
      const next = theme === "dark" ? "light" : "dark";
      b.setAttribute("aria-label", `Switch to ${next} theme`);
      b.title = `Switch to ${next} theme`;
      b.setAttribute("aria-pressed", String(theme === "dark"));
    }
  }

  apply();
  media.addEventListener("change", () => !saved() && apply());
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("[data-theme-toggle]")) return;
    localStorage.setItem(KEY, current() === "dark" ? "light" : "dark");
    apply();
    window.goatcounter?.count?.({ path: `theme/${current()}`, title: "theme", event: true });
  });
  document.addEventListener("DOMContentLoaded", apply);
})();
