export const money = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n / 100);
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(
      (window.SMARTMART_API || "").replace(/\/$/, "") + "/api" + path,
      {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw Error(
      "Cannot reach SmartMart. Check the backend connection and retry.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(
      "The backend returned an unexpected response. Check config.js.",
    );
  }
  if (!response.ok) {
    const error = Error(
      typeof data.detail === "string"
        ? data.detail
        : Array.isArray(data.detail)
          ? data.detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`).join("; ")
          : "Request failed",
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
const shapes = {
  apple:
    '<path d="M82 59c-28-28-64 4-44 42 13 26 24 29 42 21 18 8 31 5 43-20 20-39-15-70-41-43Z"/><path d="M80 57q-7-28 18-30" fill="none"/><path d="M85 45q26-25 34-7-17 17-34 7Z"/>',
  banana:
    '<path d="M42 38q-15 73 61 85 25 1 31-18-67 12-82-68Z"/><path d="M52 38q5 46 44 64" fill="none"/>',
  tomato:
    '<circle cx="80" cy="89" r="43"/><path d="m80 55-20-14 10 22-22 3 25 8 8-18 11 18 23-9-25-3 9-20Z"/>',
  milk: '<path d="M57 25h46v22l12 19v70H45V66l12-19Z"/><path d="M57 47h46M45 66h70M45 96h70" fill="none"/><circle cx="80" cy="111" r="9"/>',
  jar: '<rect x="47" y="48" width="66" height="87" rx="15"/><rect x="45" y="31" width="70" height="20" rx="4"/><path d="M47 80h66v28H47" fill="none"/><path d="m70 92 10-6 10 6-10 7Z"/>',
  bread:
    '<path d="M29 100q-8-41 38-57 49-15 66 31 15 40-36 48-52 12-68-22Z"/><path d="m58 57 16 28m6-37 18 29m6-26 16 27" fill="none"/>',
  bag: '<path d="M52 27h56l-6 21 18 89H40l18-89Z"/><path d="M58 48h44M52 27l8 10h41" fill="none"/><rect x="55" y="72" width="50" height="36" rx="3"/>',
  egg: '<path d="M80 27c-20 0-45 48-45 69 0 50 90 50 90 0 0-21-25-69-45-69Z"/><path d="M54 93q0-21 13-39" fill="none"/>',
  leaf: '<path d="M35 119Q16 31 129 28q8 96-94 91Z"/><path d="M29 138 109 48M55 109l-5-36m26 13 30-2M77 85l-1-26" fill="none"/>',
};
export function art(icon) {
  return `<svg viewBox="0 0 160 160" aria-hidden="true" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${shapes[icon] || shapes.bag}</svg>`;
}
