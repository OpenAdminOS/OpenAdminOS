// Theme preference shared by the pre-paint script in layout.tsx and the
// header toggle. Stored on this device only.

export const THEME_STORAGE_KEY = "openadminos-theme";

/**
 * Runs in <head> before first paint: resolves the saved preference (or the
 * system setting) to data-theme on <html>, and follows system changes while
 * the preference is "system".
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var d=document.documentElement;var m=window.matchMedia("(prefers-color-scheme: dark)");function apply(){var p=localStorage.getItem(k);d.dataset.theme=p==="light"||p==="dark"?p:(m.matches?"dark":"light")}apply();m.addEventListener("change",apply)}catch(e){}})();`;
