export const $ = (s) => document.querySelector(s);
export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
let timer;
export function toast(message) {
  $("#toast").textContent = message;
  clearTimeout(timer);
  timer = setTimeout(() => ($("#toast").textContent = ""), 4000);
}
export function load(key, fallback, validate) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback();
    const data = JSON.parse(raw);
    if (!validate(data)) throw Error();
    return data;
  } catch {
    $("#storage-warning").textContent =
      "Saved data could not be read. This session starts empty; your original storage has not been overwritten.";
    return [];
  }
}
export function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    const warning = $("#storage-warning");
    if (warning) warning.textContent = "";
    return true;
  } catch {
    const warning = $("#storage-warning");
    if (warning)
      warning.textContent =
        "Storage unavailable. Changes remain in memory and will not persist after leaving.";
    toast("Storage unavailable. Changes will not persist after leaving.");
    return false;
  }
}
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export function bindDialogs() {
  document
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => b.closest("dialog").close()));
}
